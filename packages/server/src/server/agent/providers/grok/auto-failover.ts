import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { GrokQuotaFailoverController } from "../../../../services/grok/grok-account-service.js";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import {
  getAgentStreamEventTurnId,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentSession,
  type AgentStreamEvent,
} from "../../agent-sdk-types.js";
import { formatSystemNotificationPrompt } from "../../agent-prompt.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "../provider-runner.js";

/** Must stay below the agent-manager cancel rescue timeout (2s) so the wrapper self-heals first. */
const DEFAULT_INTERRUPT_FORCE_SETTLE_TIMEOUT_MS = 1_500;

const QUOTA_CONTINUATION_PROMPT = formatSystemNotificationPrompt(
  "The previous request was interrupted because the Grok account ran out of quota. Continue the interrupted request from the current session state.",
);

interface ActiveTurn {
  outerTurnId: string;
  innerTurnId: string | null;
  failedAccountId: string | null;
  excludedAccountIds: Set<string>;
  recovering: boolean;
  retrying: boolean;
  canceled: boolean;
  cancelRequested: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
  runOptions?: AgentRunOptions;
}

export interface GrokAutoFailoverSessionOptions {
  session: AgentSession;
  accountController: GrokQuotaFailoverController;
  agentId: string | null;
  boundAccountId: string | null;
  resumeSession: (session: AgentSession) => Promise<AgentSession>;
  logger: Logger;
  /** Cap for interrupt waits before force-settling the outer turn. Default 1500ms. */
  interruptForceSettleTimeoutMs?: number;
}

export function isGrokQuotaExhaustionEvent(
  event: Extract<AgentStreamEvent, { type: "turn_failed" }>,
): boolean {
  if (event.httpStatus !== undefined) {
    return event.httpStatus === 402;
  }

  const detail = `${event.error}\n${event.diagnostic ?? ""}`.toLowerCase();
  return (
    /\bstatus\s+402\b/.test(detail) ||
    detail.includes("grok build usage balance exhausted") ||
    detail.includes("credit limit for your plan") ||
    detail.includes("free grok build usage limit") ||
    detail.includes("rate limit for your plan")
  );
}

export function createGrokAutoFailoverSession(
  options: GrokAutoFailoverSessionOptions,
): AgentSession {
  return new GrokAutoFailoverSession(options).asSession();
}

class GrokAutoFailoverSession {
  private session: AgentSession;
  private sessionUnsubscribe: (() => void) | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly accountController: GrokQuotaFailoverController;
  private readonly agentId: string | null;
  private readonly resumeSession: (session: AgentSession) => Promise<AgentSession>;
  private readonly logger: Logger;
  private readonly interruptForceSettleTimeoutMs: number;
  private boundAccountId: string | null;
  private activeTurn: ActiveTurn | null = null;
  private transition: Promise<void> | null = null;
  private closed = false;

  constructor(options: GrokAutoFailoverSessionOptions) {
    this.session = options.session;
    this.accountController = options.accountController;
    this.agentId = options.agentId;
    this.boundAccountId = options.boundAccountId;
    this.resumeSession = options.resumeSession;
    this.logger = options.logger;
    this.interruptForceSettleTimeoutMs =
      options.interruptForceSettleTimeoutMs ?? DEFAULT_INTERRUPT_FORCE_SETTLE_TIMEOUT_MS;
    this.attachSession(options.session);
  }

  asSession(): AgentSession {
    return new Proxy(this.session, {
      get: (_target, property) => {
        switch (property) {
          case "run":
            return this.run.bind(this);
          case "startTurn":
            return this.startTurn.bind(this);
          case "subscribe":
            return this.subscribe.bind(this);
          case "interrupt":
            return this.interrupt.bind(this);
          case "close":
            return this.close.bind(this);
          default: {
            const value = Reflect.get(this.session, property, this.session);
            if (typeof value !== "function") {
              return value;
            }
            return (...args: unknown[]) => {
              const current = this.session;
              const method = Reflect.get(current, property, current);
              if (typeof method !== "function") {
                throw new Error(`Current Grok session does not implement ${String(property)}`);
              }
              return Reflect.apply(method, current, args);
            };
          }
        }
      },
    });
  }

  private async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (nextPrompt, nextOptions) => this.startTurn(nextPrompt, nextOptions),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.session.id ?? "",
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });
  }

  private async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Grok session is closed");
    }
    if (this.activeTurn !== null) {
      throw new Error("A foreground turn is already active");
    }

    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const turn: ActiveTurn = {
      outerTurnId: randomUUID(),
      innerTurnId: null,
      failedAccountId: this.boundAccountId,
      excludedAccountIds: new Set(this.boundAccountId === null ? [] : [this.boundAccountId]),
      recovering: false,
      retrying: false,
      canceled: false,
      cancelRequested: false,
      settled,
      resolveSettled,
      runOptions: options,
    };
    this.activeTurn = turn;
    this.queueTransition(
      turn,
      () => this.startInnerTurn(turn, prompt, options),
      (error) => this.finishStartFailure(turn, error),
    );
    return { turnId: turn.outerTurnId };
  }

  private subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    if (this.session.id) {
      callback({ type: "thread_started", provider: "grok", sessionId: this.session.id });
    }
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      await this.session.interrupt();
      return;
    }
    if (turn.canceled) {
      await this.waitForTransitionsCapped(turn, "wait for transitions after cancel");
      return;
    }
    if (turn.cancelRequested) {
      await this.awaitSettledOrForce(turn, "wait for prior cancel to settle");
      await this.waitForTransitionsCapped(turn, "wait for transitions after prior cancel");
      return;
    }

    const hasRunningInnerTurn = !turn.recovering && turn.innerTurnId !== null;
    if (hasRunningInnerTurn) {
      turn.cancelRequested = true;
      try {
        await withTimeout(
          this.session.interrupt(),
          this.interruptForceSettleTimeoutMs,
          `Timed out after ${this.interruptForceSettleTimeoutMs}ms (Grok inner interrupt)`,
        );
        await this.awaitSettledOrForce(turn, "wait for inner cancel terminal");
        await this.waitForTransitionsCapped(turn, "wait for transitions after interrupt");
      } catch (error) {
        // Inner interrupt threw or timed out before force-settle ran — always leave the
        // wrapper able to start a new turn (never roll cancelRequested back and hang).
        if (this.activeTurn === turn) {
          this.forceSettleCanceledTurn(
            turn,
            error instanceof Error
              ? `Interrupted after Grok cancel failure: ${error.message}`
              : "Interrupted after Grok cancel failure",
          );
          void this.session.interrupt().catch(() => {});
        }
      }
      return;
    }

    turn.canceled = true;
    this.emit({
      type: "turn_canceled",
      provider: "grok",
      reason: "Interrupted during Grok account transition",
      turnId: turn.outerTurnId,
    });

    try {
      await this.waitForTransitionsCapped(
        turn,
        "wait for transitions during account transition cancel",
      );
    } finally {
      if (this.activeTurn === turn) {
        this.settleTurn(turn);
      }
    }
  }

  /**
   * Force-clear the outer turn after a cancel timeout/failure so the session can
   * accept a new startTurn. Emits exactly one synthetic turn_canceled for this turn.
   */
  private forceSettleCanceledTurn(turn: ActiveTurn, reason: string): void {
    turn.canceled = true;
    this.emit({
      type: "turn_canceled",
      provider: "grok",
      reason,
      turnId: turn.outerTurnId,
    });
    this.settleTurn(turn);
  }

  private async awaitSettledOrForce(turn: ActiveTurn, label: string): Promise<void> {
    if (this.activeTurn !== turn) {
      return;
    }
    try {
      await withTimeout(
        turn.settled,
        this.interruptForceSettleTimeoutMs,
        `Timed out after ${this.interruptForceSettleTimeoutMs}ms (${label})`,
      );
    } catch {
      if (this.activeTurn === turn) {
        this.logger.warn(
          { agentId: this.agentId, outerTurnId: turn.outerTurnId, label },
          "Grok cancel timed out waiting for terminal event; force-settling outer turn",
        );
        this.forceSettleCanceledTurn(
          turn,
          "Interrupted after Grok cancel timed out waiting for terminal event; forced local settle",
        );
        void this.session.interrupt().catch(() => {});
      }
    }
  }

  private async waitForTransitionsCapped(turn: ActiveTurn, label: string): Promise<void> {
    try {
      await withTimeout(
        this.waitForTransitions(),
        this.interruptForceSettleTimeoutMs,
        `Timed out after ${this.interruptForceSettleTimeoutMs}ms (${label})`,
      );
    } catch {
      this.logger.warn(
        { agentId: this.agentId, outerTurnId: turn.outerTurnId, label },
        "Grok cancel timed out waiting for account transitions; force-settling outer turn",
      );
      if (this.activeTurn === turn) {
        // Transition-path cancel already emitted turn_canceled; just settle.
        if (turn.canceled) {
          this.settleTurn(turn);
        } else {
          this.forceSettleCanceledTurn(
            turn,
            "Interrupted after Grok cancel timed out waiting for account transitions; forced local settle",
          );
        }
      }
    }
  }

  private async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const activeTurn = this.activeTurn;
    if (activeTurn) {
      activeTurn.canceled = true;
      activeTurn.resolveSettled();
    }
    this.activeTurn = null;
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
    try {
      await this.session.close();
    } finally {
      await this.waitForTransitions();
    }
  }

  private attachSession(session: AgentSession): void {
    this.sessionUnsubscribe?.();
    this.session = session;
    this.sessionUnsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
  }

  private handleSessionEvent(event: AgentStreamEvent): void {
    const eventTurnId = getAgentStreamEventTurnId(event);
    const turn = this.activeTurn;
    if (!turn) {
      this.emit(event);
      return;
    }

    // Late terminals for an already-canceled turn settle without re-emitting
    // (outer already sent a synthetic turn_canceled).
    if (turn.canceled) {
      this.settleCanceledTurnIfTerminal(event, eventTurnId, turn);
      return;
    }

    if (eventTurnId && turn.innerTurnId === null) {
      turn.innerTurnId = eventTurnId;
    }
    if (!eventBelongsToTurn(eventTurnId, turn)) {
      this.emit(event);
      return;
    }

    if (
      event.type === "turn_failed" &&
      isGrokQuotaExhaustionEvent(event) &&
      !turn.recovering &&
      !turn.cancelRequested
    ) {
      turn.recovering = true;
      this.queueTransition(
        turn,
        () => this.recoverFromQuota(turn, event),
        (error) => this.finishRecoveryError(turn, event, error),
      );
      return;
    }

    if (
      turn.retrying &&
      (event.type === "turn_started" ||
        (event.type === "timeline" && event.item.type === "user_message"))
    ) {
      return;
    }

    this.emit(this.mapTurnId(event, turn.outerTurnId));
    if (isTerminalTurnEvent(event)) {
      this.settleTurn(turn);
    }
  }

  private settleCanceledTurnIfTerminal(
    event: AgentStreamEvent,
    eventTurnId: string | undefined,
    turn: ActiveTurn,
  ): void {
    if (isTerminalTurnEvent(event) && eventBelongsToTurn(eventTurnId, turn)) {
      this.settleTurn(turn);
    }
  }

  private async startInnerTurn(
    turn: ActiveTurn,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<void> {
    const reloaded = await this.reloadForChangedAccount(turn);
    if (!reloaded || !this.isCurrentTurn(turn)) {
      return;
    }
    turn.failedAccountId = this.boundAccountId;
    turn.excludedAccountIds.clear();
    if (this.boundAccountId !== null) {
      turn.excludedAccountIds.add(this.boundAccountId);
    }
    const result = await this.session.startTurn(prompt, options);
    if (this.isCurrentTurn(turn)) {
      turn.innerTurnId ??= result.turnId;
    }
  }

  private async recoverFromQuota(
    turn: ActiveTurn,
    failure: Extract<AgentStreamEvent, { type: "turn_failed" }>,
  ): Promise<void> {
    const result = await this.accountController.rotateAfterQuotaExhaustion({
      agentId: this.agentId,
      failedAccountId: turn.failedAccountId,
      excludedAccountIds: [...turn.excludedAccountIds],
    });
    if (!this.isCurrentTurn(turn)) {
      return;
    }
    if (result.outcome === "unavailable") {
      this.finishRecoveryFailure(turn, failure, failoverUnavailableMessage(result.reason));
      return;
    }

    turn.excludedAccountIds.add(result.activeAccountId);
    const reloaded = await this.replaceSession(result.activeAccountId, turn);
    if (!reloaded || !this.isCurrentTurn(turn)) {
      return;
    }

    turn.failedAccountId = result.activeAccountId;
    turn.innerTurnId = null;
    turn.retrying = true;
    turn.recovering = false;
    const retry = await this.session.startTurn(
      QUOTA_CONTINUATION_PROMPT,
      withoutMessageIdentity(turn.runOptions),
    );
    if (this.isCurrentTurn(turn)) {
      turn.innerTurnId ??= retry.turnId;
      this.logger.info(
        { agentId: this.agentId, sessionId: this.session.id },
        "Grok account quota recovery resumed the existing session",
      );
    }
  }

  private finishRecoveryError(
    turn: ActiveTurn,
    failure: Extract<AgentStreamEvent, { type: "turn_failed" }>,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.finishRecoveryFailure(turn, failure, `Automatic Grok account recovery failed: ${message}`);
  }

  private finishRecoveryFailure(
    turn: ActiveTurn,
    failure: Extract<AgentStreamEvent, { type: "turn_failed" }>,
    reason: string,
  ): void {
    if (!this.isCurrentTurn(turn)) {
      return;
    }
    this.settleTurn(turn);
    this.emit(
      this.mapTurnId(
        {
          ...failure,
          error: `${failure.error}\n\n${reason}`,
        },
        turn.outerTurnId,
      ),
    );
  }

  private async reloadForChangedAccount(turn: ActiveTurn): Promise<boolean> {
    const activeAccountId = this.accountController.getActiveAccountId();
    if (activeAccountId === null || activeAccountId === this.boundAccountId) {
      return true;
    }
    const reloaded = await this.replaceSession(activeAccountId, turn);
    if (!reloaded) {
      return false;
    }
    this.logger.info(
      { agentId: this.agentId, sessionId: this.session.id },
      "Reloaded Grok session after account change",
    );
    return true;
  }

  private async replaceSession(activeAccountId: string, turn: ActiveTurn): Promise<boolean> {
    const previous = this.session;
    const next = await this.resumeSession(previous);
    if (!this.isCurrentTurn(turn)) {
      await next.close();
      return false;
    }

    this.attachSession(next);
    this.boundAccountId = activeAccountId;
    try {
      await previous.close();
    } catch (error) {
      this.logger.warn({ err: error, agentId: this.agentId }, "Failed to close stale Grok session");
    }
    return this.isCurrentTurn(turn);
  }

  private mapTurnId(event: AgentStreamEvent, outerTurnId: string): AgentStreamEvent {
    if (!("turnId" in event)) {
      return event;
    }
    return { ...event, turnId: outerTurnId };
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private queueTransition(
    turn: ActiveTurn,
    operation: () => Promise<void>,
    onError: (error: unknown) => void,
  ): void {
    const previous = this.transition ?? Promise.resolve();
    const next = (async () => {
      await previous;
      if (!this.isCurrentTurn(turn)) {
        return;
      }
      try {
        await operation();
      } catch (error) {
        if (this.isCurrentTurn(turn)) {
          onError(error);
        }
      }
    })();
    this.transition = next;
    void (async () => {
      await next;
      if (this.transition === next) {
        this.transition = null;
      }
    })();
  }

  private async waitForTransitions(): Promise<void> {
    while (this.transition) {
      await this.transition;
    }
  }

  private isCurrentTurn(turn: ActiveTurn): boolean {
    return !this.closed && !turn.canceled && !turn.cancelRequested && this.activeTurn === turn;
  }

  private finishStartFailure(turn: ActiveTurn, error: unknown): void {
    if (!this.isCurrentTurn(turn)) {
      return;
    }
    this.settleTurn(turn);
    this.emit({
      type: "turn_failed",
      provider: "grok",
      error: error instanceof Error ? error.message : String(error),
      turnId: turn.outerTurnId,
    });
  }

  private settleTurn(turn: ActiveTurn): void {
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
    turn.resolveSettled();
  }
}

function withoutMessageIdentity(options: AgentRunOptions | undefined): AgentRunOptions | undefined {
  if (!options) {
    return undefined;
  }
  const { messageId: _messageId, resumeFrom: _resumeFrom, ...rest } = options;
  return rest;
}

function failoverUnavailableMessage(
  reason: "no_alternate_account" | "other_agents_running",
): string {
  return reason === "other_agents_running"
    ? "Automatic Grok account switching was skipped because another Grok task is running."
    : "No unused saved Grok account is available for automatic recovery.";
}

function isTerminalTurnEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

function eventBelongsToTurn(eventTurnId: string | undefined, turn: ActiveTurn): boolean {
  return eventTurnId === undefined || turn.innerTurnId === null || eventTurnId === turn.innerTurnId;
}
