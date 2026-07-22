import { describe, expect, test } from "vitest";

import type {
  GrokQuotaFailoverController,
  GrokQuotaFailoverInput,
  GrokQuotaFailoverResult,
} from "../../../../services/grok/grok-account-service.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type {
  AgentCapabilityFlags,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";
import { isSystemInjectedEnvelope } from "../../agent-prompt.js";
import { createGrokAutoFailoverSession, isGrokQuotaExhaustionEvent } from "./auto-failover.js";

const capabilities: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

class FakeGrokSession implements AgentSession {
  readonly provider = "grok";
  readonly capabilities = capabilities;
  readonly prompts: Array<{ prompt: AgentPromptInput; options?: AgentRunOptions }> = [];
  readonly modelSelections: Array<string | null> = [];
  closed = false;
  /** interrupt() returns, but withholds the terminal event until flushDeferredInterrupt(). */
  deferInterruptEvent = false;
  /** interrupt() never resolves and never emits a terminal — models a hung Grok CLI. */
  hangInterruptForever = false;
  /** interrupt() rejects immediately. */
  interruptThrows = false;
  onStart: (() => void) | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurnId: string | null = null;
  private deferredCanceledTurnId: string | null = null;
  private turnSequence = 0;

  constructor(
    readonly id: string,
    private readonly replayEvents: AgentStreamEvent[] = [],
  ) {}

  async run(): Promise<AgentRunResult> {
    throw new Error("the Grok wrapper owns run()");
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    const turnId = `${this.id}-turn-${++this.turnSequence}`;
    this.activeTurnId = turnId;
    this.prompts.push({ prompt, options });
    this.emit({ type: "turn_started", provider: "grok", turnId });
    this.emit({
      type: "timeline",
      provider: "grok",
      turnId,
      item: {
        type: "user_message",
        text: typeof prompt === "string" ? prompt : "[structured prompt]",
        messageId: options?.clientMessageId,
      },
    });
    this.onStart?.();
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    callback({ type: "thread_started", provider: "grok", sessionId: this.id });
    for (const event of this.replayEvents) {
      callback(event);
    }
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: "grok", sessionId: this.id };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<void> {}

  async setModel(modelId: string | null): Promise<void> {
    this.modelSelections.push(modelId);
  }

  describePersistence() {
    return {
      provider: "grok",
      sessionId: this.id,
      nativeHandle: this.id,
      metadata: { cwd: "E:\\paseo" },
    };
  }

  async interrupt(): Promise<void> {
    if (this.hangInterruptForever) {
      // Never resolves and never emits a terminal event.
      return new Promise(() => {});
    }
    if (this.interruptThrows) {
      throw new Error("fake Grok interrupt failed");
    }
    if (!this.activeTurnId) return;
    const turnId = this.activeTurnId;
    if (this.deferInterruptEvent) {
      this.deferredCanceledTurnId = turnId;
      return;
    }
    this.activeTurnId = null;
    this.emit({ type: "turn_canceled", provider: "grok", reason: "interrupted", turnId });
  }

  flushDeferredInterrupt(): void {
    if (!this.deferredCanceledTurnId) throw new Error("no deferred fake interrupt");
    const turnId = this.deferredCanceledTurnId;
    this.deferredCanceledTurnId = null;
    this.activeTurnId = null;
    this.emit({ type: "turn_canceled", provider: "grok", reason: "interrupted", turnId });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  fail(error: string, options?: { httpStatus?: number; diagnostic?: string }): void {
    if (!this.activeTurnId) throw new Error("no active fake turn");
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.emit({
      type: "turn_failed",
      provider: "grok",
      error,
      turnId,
      ...(options?.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
      ...(options?.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
    });
  }

  complete(text: string): void {
    if (!this.activeTurnId) throw new Error("no active fake turn");
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.emit({
      type: "timeline",
      provider: "grok",
      turnId,
      item: { type: "assistant_message", text },
    });
    this.emit({ type: "turn_completed", provider: "grok", turnId });
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

class FakeAccountController implements GrokQuotaFailoverController {
  readonly inputs: GrokQuotaFailoverInput[] = [];
  readonly results: GrokQuotaFailoverResult[] = [];

  constructor(public activeAccountId: string | null) {}

  getActiveAccountId(): string | null {
    return this.activeAccountId;
  }

  async rotateAfterQuotaExhaustion(
    input: GrokQuotaFailoverInput,
  ): Promise<GrokQuotaFailoverResult> {
    this.inputs.push(input);
    const result = this.results.shift() ?? {
      outcome: "unavailable",
      reason: "no_alternate_account",
    };
    if (result.outcome !== "unavailable") {
      this.activeAccountId = result.activeAccountId;
    }
    return result;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function wrap(params: {
  source: FakeGrokSession;
  controller: FakeAccountController;
  boundAccountId: string | null;
  resumed: FakeGrokSession[];
  beforeResume?: (resumeIndex: number) => Promise<void>;
  interruptForceSettleTimeoutMs?: number;
}) {
  const resumeSources: string[] = [];
  let resumeIndex = 0;
  const session = createGrokAutoFailoverSession({
    session: params.source,
    accountController: params.controller,
    agentId: "agent-1",
    boundAccountId: params.boundAccountId,
    logger: createTestLogger(),
    interruptForceSettleTimeoutMs: params.interruptForceSettleTimeoutMs,
    resumeSession: async (current) => {
      resumeSources.push(current.id ?? "");
      const next = params.resumed.shift();
      if (!next) throw new Error("no resumed fake session available");
      await params.beforeResume?.(resumeIndex);
      resumeIndex += 1;
      return next;
    },
  });
  return { session, resumeSources };
}

describe("Grok automatic account recovery", () => {
  test("replays context usage captured before outer subscribers attach", () => {
    const usageEvent: AgentStreamEvent = {
      type: "usage_updated",
      provider: "grok",
      usage: {
        contextWindowUsedTokens: 49_179,
        contextWindowMaxTokens: 500_000,
      },
    };
    const source = new FakeGrokSession("session-1", [usageEvent]);
    const { session } = wrap({
      source,
      controller: new FakeAccountController("account-a"),
      boundAccountId: "account-a",
      resumed: [],
    });
    const events: AgentStreamEvent[] = [];

    session.subscribe((event) => events.push(event));

    expect(events).toContainEqual(usageEvent);
  });

  test("reloads the same native session before the first prompt after a manual account switch", async () => {
    const source = new FakeGrokSession("session-1");
    const resumed = new FakeGrokSession("session-1");
    const resumedStarted = deferred();
    resumed.onStart = resumedStarted.resolve;
    const controller = new FakeAccountController("account-b");
    const { session, resumeSources } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [resumed],
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("continue the task", { clientMessageId: "visible-message" });
    await resumedStarted.promise;

    expect(resumeSources).toEqual(["session-1"]);
    expect(source.closed).toBe(true);
    expect(source.prompts).toEqual([]);
    expect(resumed.prompts).toEqual([
      { prompt: "continue the task", options: { clientMessageId: "visible-message" } },
    ]);
    expect(session.describePersistence()?.sessionId).toBe("session-1");
    expect(events.filter((event) => event.type === "timeline")).toHaveLength(1);
  });

  test("hides a 402, reloads the original session, and continues the same outer turn", async () => {
    const source = new FakeGrokSession("session-1");
    const sourceStarted = deferred();
    source.onStart = sourceStarted.resolve;
    const resumed = new FakeGrokSession("session-1");
    const retryStarted = deferred();
    resumed.onStart = retryStarted.resolve;
    const controller = new FakeAccountController("account-a");
    controller.results.push({
      outcome: "switched",
      previousAccountId: "account-a",
      activeAccountId: "account-b",
    });
    const { session, resumeSources } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [resumed],
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const started = await session.startTurn("finish the migration", { clientMessageId: "message-1" });
    await sourceStarted.promise;

    source.fail("Internal error: API error: Grok Build usage balance exhausted", {
      httpStatus: 402,
    });
    await retryStarted.promise;
    resumed.complete("migration complete");

    expect(controller.inputs).toEqual([
      {
        agentId: "agent-1",
        failedAccountId: "account-a",
        excludedAccountIds: ["account-a"],
      },
    ]);
    expect(resumeSources).toEqual(["session-1"]);
    expect(source.closed).toBe(true);
    expect(resumed.prompts[0]?.prompt).toContain("Continue the interrupted request");
    expect(isSystemInjectedEnvelope(String(resumed.prompts[0]?.prompt))).toBe(true);
    expect(resumed.prompts[0]?.options).toEqual({});
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", turnId: started.turnId });
    expect(session.describePersistence()?.sessionId).toBe("session-1");
  });

  test("attributes a 402 to the account loaded by a manual switch", async () => {
    const source = new FakeGrokSession("session-1");
    const accountB = new FakeGrokSession("session-1");
    const accountBStarted = deferred();
    accountB.onStart = accountBStarted.resolve;
    const accountC = new FakeGrokSession("session-1");
    const accountCStarted = deferred();
    accountC.onStart = accountCStarted.resolve;
    const controller = new FakeAccountController("account-b");
    controller.results.push({
      outcome: "switched",
      previousAccountId: "account-b",
      activeAccountId: "account-c",
    });
    const { session } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [accountB, accountC],
    });

    await session.startTurn("continue after manual switch");
    await accountBStarted.promise;
    accountB.fail("Grok Build usage balance exhausted", { httpStatus: 402 });
    await accountCStarted.promise;

    expect(controller.inputs).toEqual([
      {
        agentId: "agent-1",
        failedAccountId: "account-b",
        excludedAccountIds: ["account-b"],
      },
    ]);
    expect(accountC.prompts[0]?.prompt).toContain("Continue the interrupted request");
  });

  test("forwards non-quota failures without switching or reloading", async () => {
    const source = new FakeGrokSession("session-1");
    const sourceStarted = deferred();
    source.onStart = sourceStarted.resolve;
    const controller = new FakeAccountController("account-a");
    const { session, resumeSources } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [],
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("do work");
    await sourceStarted.promise;

    source.fail("upstream gateway failed", { httpStatus: 502 });

    expect(controller.inputs).toEqual([]);
    expect(resumeSources).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", httpStatus: 502 });
  });

  test("emits one terminal failure when no alternate account is available", async () => {
    const source = new FakeGrokSession("session-1");
    const sourceStarted = deferred();
    source.onStart = sourceStarted.resolve;
    const controller = new FakeAccountController("account-a");
    const { session } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [],
    });
    const failed = deferred();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "turn_failed") failed.resolve();
    });
    await session.startTurn("do work");
    await sourceStarted.promise;

    source.fail("status 402 Payment Required");
    await failed.promise;

    const failures = events.filter((event) => event.type === "turn_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      error: expect.stringContaining("No unused saved Grok account"),
    });
  });

  test("cancels a manual account reload without submitting the original prompt", async () => {
    const source = new FakeGrokSession("session-1");
    const abandoned = new FakeGrokSession("session-1");
    const resumeEntered = deferred();
    const releaseResume = deferred();
    const controller = new FakeAccountController("account-b");
    const { session } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [abandoned],
      beforeResume: async () => {
        resumeEntered.resolve();
        await releaseResume.promise;
      },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const starting = session.startTurn("must not be submitted");
    await resumeEntered.promise;
    let interruptSettled = false;
    const interrupting = (async () => {
      await session.interrupt();
      interruptSettled = true;
    })();
    await Promise.resolve();
    const settledBeforeResume = interruptSettled;
    releaseResume.resolve();
    const started = await starting;
    await interrupting;

    expect(settledBeforeResume).toBe(false);
    expect(source.prompts).toEqual([]);
    expect(abandoned.prompts).toEqual([]);
    expect(abandoned.closed).toBe(true);
    expect(events.filter((event) => event.type === "turn_canceled")).toEqual([
      expect.objectContaining({ turnId: started.turnId }),
    ]);
  });

  test("rejects a second turn while a manual account reload is still active", async () => {
    const source = new FakeGrokSession("session-1");
    const firstResumed = new FakeGrokSession("session-1");
    const secondResumed = new FakeGrokSession("session-1");
    const firstStarted = deferred();
    firstResumed.onStart = firstStarted.resolve;
    const resumeEntered = deferred();
    const releaseResume = deferred();
    const controller = new FakeAccountController("account-b");
    const { session, resumeSources } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [firstResumed, secondResumed],
      beforeResume: async (resumeIndex) => {
        if (resumeIndex === 0) {
          resumeEntered.resolve();
          await releaseResume.promise;
        }
      },
    });

    const first = session.startTurn("first");
    await resumeEntered.promise;
    const secondOutcome = session.startTurn("second").then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await Promise.resolve();
    releaseResume.resolve();
    await first;
    await firstStarted.promise;

    expect(await secondOutcome).toBe("rejected");
    expect(resumeSources).toEqual(["session-1"]);
    expect(firstResumed.prompts.map((entry) => entry.prompt)).toEqual(["first"]);
    expect(secondResumed.prompts).toEqual([]);
  });

  test("waits for a canceled 402 resume before allowing the next turn", async () => {
    const source = new FakeGrokSession("session-1");
    const sourceStarted = deferred();
    source.onStart = sourceStarted.resolve;
    const abandoned = new FakeGrokSession("session-1");
    const next = new FakeGrokSession("session-1");
    const nextStarted = deferred();
    next.onStart = nextStarted.resolve;
    const resumeEntered = deferred();
    const releaseResume = deferred();
    const controller = new FakeAccountController("account-a");
    controller.results.push({
      outcome: "switched",
      previousAccountId: "account-a",
      activeAccountId: "account-b",
    });
    const { session, resumeSources } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [abandoned, next],
      beforeResume: async (resumeIndex) => {
        if (resumeIndex === 0) {
          resumeEntered.resolve();
          await releaseResume.promise;
        }
      },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("quota-bound request");
    await sourceStarted.promise;
    source.fail("Grok Build usage balance exhausted", { httpStatus: 402 });
    await resumeEntered.promise;

    let interruptSettled = false;
    const interrupting = (async () => {
      await session.interrupt();
      interruptSettled = true;
    })();
    await Promise.resolve();
    const settledBeforeResume = interruptSettled;
    releaseResume.resolve();
    await interrupting;

    expect(settledBeforeResume).toBe(false);
    expect(abandoned.closed).toBe(true);
    expect(abandoned.prompts).toEqual([]);
    expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(1);

    await session.startTurn("next request");
    await nextStarted.promise;

    expect(resumeSources).toEqual(["session-1", "session-1"]);
    expect(next.prompts.map((entry) => entry.prompt)).toEqual(["next request"]);
  });

  test("routes an optional method captured before reload to the current session", async () => {
    const source = new FakeGrokSession("session-1");
    const resumed = new FakeGrokSession("session-1");
    const resumedStarted = deferred();
    resumed.onStart = resumedStarted.resolve;
    const controller = new FakeAccountController("account-b");
    const { session } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [resumed],
    });
    const setModel = session.setModel;

    await session.startTurn("continue");
    await resumedStarted.promise;
    await setModel?.("grok-4.5");

    expect(source.modelSelections).toEqual([]);
    expect(resumed.modelSelections).toEqual(["grok-4.5"]);
  });

  test("waits for the inner cancellation terminal before allowing the next turn", async () => {
    const source = new FakeGrokSession("session-1");
    source.deferInterruptEvent = true;
    const sourceStarted = deferred();
    source.onStart = sourceStarted.resolve;
    const controller = new FakeAccountController("account-a");
    const { session } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [],
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("cancel me");
    await sourceStarted.promise;

    let interruptSettled = false;
    const interrupting = (async () => {
      await session.interrupt();
      interruptSettled = true;
    })();
    await Promise.resolve();
    await Promise.resolve();

    const nextBeforeTerminal = session.startTurn("too early").then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    expect(await nextBeforeTerminal).toBe("rejected");
    expect(interruptSettled).toBe(false);

    source.flushDeferredInterrupt();
    await interrupting;
    const nextStarted = deferred();
    source.onStart = nextStarted.resolve;
    await session.startTurn("after cancel");
    await nextStarted.promise;

    expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(1);
    expect(source.prompts.map((entry) => entry.prompt)).toEqual(["cancel me", "after cancel"]);
  });

  test("force-settles when inner interrupt never resolves so the next turn can start", async () => {
    const source = new FakeGrokSession("session-1");
    source.hangInterruptForever = true;
    const sourceStarted = deferred();
    source.onStart = sourceStarted.resolve;
    const controller = new FakeAccountController("account-a");
    const { session } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [],
      interruptForceSettleTimeoutMs: 20,
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = await session.startTurn("stuck cancel");
    await sourceStarted.promise;

    await session.interrupt();

    const canceled = events.filter((event) => event.type === "turn_canceled");
    expect(canceled).toHaveLength(1);
    expect(canceled[0]).toMatchObject({ turnId: first.turnId });

    const nextStarted = deferred();
    source.hangInterruptForever = false;
    source.onStart = nextStarted.resolve;
    await session.startTurn("after force settle");
    await nextStarted.promise;

    expect(source.prompts.map((entry) => entry.prompt)).toEqual([
      "stuck cancel",
      "after force settle",
    ]);
  });

  test("force-settles when interrupt returns but the terminal event never arrives", async () => {
    const source = new FakeGrokSession("session-1");
    source.deferInterruptEvent = true;
    const sourceStarted = deferred();
    source.onStart = sourceStarted.resolve;
    const controller = new FakeAccountController("account-a");
    const { session } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [],
      interruptForceSettleTimeoutMs: 20,
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = await session.startTurn("missing terminal");
    await sourceStarted.promise;

    await session.interrupt();
    // Never flushDeferredInterrupt — the terminal event stays missing.

    const canceled = events.filter((event) => event.type === "turn_canceled");
    expect(canceled).toHaveLength(1);
    expect(canceled[0]).toMatchObject({ turnId: first.turnId });

    const nextStarted = deferred();
    source.deferInterruptEvent = false;
    source.onStart = nextStarted.resolve;
    await session.startTurn("after missing terminal");
    await nextStarted.promise;

    expect(source.prompts.map((entry) => entry.prompt)).toEqual([
      "missing terminal",
      "after missing terminal",
    ]);
  });

  test("force-settles when inner interrupt throws so the next turn can start", async () => {
    const source = new FakeGrokSession("session-1");
    source.interruptThrows = true;
    const sourceStarted = deferred();
    source.onStart = sourceStarted.resolve;
    const controller = new FakeAccountController("account-a");
    const { session } = wrap({
      source,
      controller,
      boundAccountId: "account-a",
      resumed: [],
      interruptForceSettleTimeoutMs: 20,
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = await session.startTurn("interrupt throws");
    await sourceStarted.promise;

    await session.interrupt();

    const canceled = events.filter((event) => event.type === "turn_canceled");
    expect(canceled).toHaveLength(1);
    expect(canceled[0]).toMatchObject({ turnId: first.turnId });

    const nextStarted = deferred();
    source.interruptThrows = false;
    source.onStart = nextStarted.resolve;
    await session.startTurn("after interrupt throw");
    await nextStarted.promise;

    expect(source.prompts.map((entry) => entry.prompt)).toEqual([
      "interrupt throws",
      "after interrupt throw",
    ]);
  });
});

describe("isGrokQuotaExhaustionEvent", () => {
  test.each([
    { httpStatus: 402, error: "Internal error" },
    { error: "API error (status 402 Payment Required)" },
    { error: "Grok Build usage balance exhausted" },
    { error: "You've hit the credit limit for your plan." },
    { error: "You've hit the free Grok Build usage limit." },
    { error: "Rate limit for your plan has been reached." },
  ])("accepts account quota failures: $error", (failure) => {
    expect(isGrokQuotaExhaustionEvent({ type: "turn_failed", provider: "grok", ...failure })).toBe(
      true,
    );
  });

  test.each([
    { httpStatus: 429, error: "rate limit for your plan" },
    { httpStatus: 401, error: "authentication required" },
    { httpStatus: 502, error: "Grok Build usage balance exhausted" },
    { error: "Internal error", code: "-32603" },
  ])("rejects non-quota failures: $error", (failure) => {
    expect(isGrokQuotaExhaustionEvent({ type: "turn_failed", provider: "grok", ...failure })).toBe(
      false,
    );
  });
});
