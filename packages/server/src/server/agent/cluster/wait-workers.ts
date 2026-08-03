import type {
  AgentManagerEvent,
  AgentSubscriber,
  ManagedAgent,
  SubscribeOptions,
  WaitForAgentOptions,
  WaitForAgentResult,
} from "../agent-manager.js";

/** Default wait budget for one cluster worker fan-in round. */
export const DEFAULT_CLUSTER_WORKER_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

export type ClusterWorkerTerminalStatus =
  | "completed"
  | "failed"
  | "blocked"
  | "closed"
  | "canceled"
  | "timeout";

export interface ClusterWorkerOutcome {
  agentId: string;
  status: ClusterWorkerTerminalStatus;
  lastMessage: string | null;
  error?: string;
}

/**
 * Minimal AgentManager surface used by cluster worker waiting.
 * Injectable so the module stays thin and unit-testable with a fake port.
 */
export interface ClusterWorkerAgentManagerPort {
  getAgent(agentId: string): ManagedAgent | undefined;
  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void;
  getLastAssistantMessage(agentId: string): Promise<string | null>;
  agentHasCompletedTurn(agentId: string): Promise<boolean>;
  waitForAgentEvent(agentId: string, options?: WaitForAgentOptions): Promise<WaitForAgentResult>;
}

export interface WaitForClusterWorkersOptions {
  workerIds: string[];
  agentManager: ClusterWorkerAgentManagerPort;
  timeoutMs?: number;
}

export interface WaitForClusterAgentTurnOptions {
  agentId: string;
  agentManager: ClusterWorkerAgentManagerPort;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Wait for every worker's first turn. Returns one outcome per input id,
 * in input order. Never fails fast on the first error: each worker is
 * waited on independently and all outcomes are collected before resolving.
 */
export async function waitForClusterWorkers(
  options: WaitForClusterWorkersOptions,
): Promise<ClusterWorkerOutcome[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLUSTER_WORKER_WAIT_TIMEOUT_MS;
  return await Promise.all(
    options.workerIds.map((agentId) =>
      waitForClusterWorker(options.agentManager, agentId, timeoutMs),
    ),
  );
}

/**
 * Wait for a single turn of an already-running agent (evidence bounce or a
 * post-review follow-up). Reuses AgentManager's own waitForAgentEvent state
 * machine; this module only wraps it with a timeout and normalizes the result.
 *
 * Terminal stream semantics are observed through an extra subscription:
 * - turn_canceled → canceled (waitForAgentEvent alone would report idle → completed)
 * - turn_failed → failed, carrying the real provider error
 * Only this module's timeout controller yields `timeout`; a caller abort
 * yields `canceled` with the abort reason.
 */
export async function waitForClusterAgentTurn(
  options: WaitForClusterAgentTurnOptions,
): Promise<ClusterWorkerOutcome> {
  const { agentId, agentManager } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLUSTER_WORKER_WAIT_TIMEOUT_MS;

  let resolveSettled: (outcome: ClusterWorkerOutcome) => void = () => {};
  const settledPromise = new Promise<ClusterWorkerOutcome>((resolvePromise) => {
    resolveSettled = resolvePromise;
  });
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let callerAbortListener: (() => void) | null = null;

  const combinedController = new AbortController();
  const callerSignal = options.signal;

  const settle = (outcome: ClusterWorkerOutcome) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // ignore cleanup errors
      }
      unsubscribe = null;
    }
    if (callerAbortListener && callerSignal) {
      try {
        callerSignal.removeEventListener("abort", callerAbortListener);
      } catch {
        // ignore cleanup errors
      }
      callerAbortListener = null;
    }
    if (!combinedController.signal.aborted) {
      combinedController.abort(outcome);
    }
    resolveSettled(outcome);
  };

  timeoutId = setTimeout(() => {
    settle({
      agentId,
      status: "timeout",
      lastMessage: null,
      error: `Cluster worker ${agentId} did not complete a turn within ${Math.round(timeoutMs / 1000)}s`,
    });
  }, timeoutMs);

  const onCallerAbort = () => {
    const reason = callerSignal?.reason;
    let message = "aborted";
    if (reason instanceof Error) {
      message = reason.message;
    } else if (typeof reason === "string") {
      message = reason;
    }
    settle({ agentId, status: "canceled", lastMessage: null, error: message });
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      onCallerAbort();
      return settledPromise;
    }
    callerAbortListener = onCallerAbort;
    callerSignal.addEventListener("abort", callerAbortListener, { once: true });
  }

  unsubscribe = agentManager.subscribe(
    (event: AgentManagerEvent) => {
      if (settled) {
        return;
      }
      if (event.type !== "agent_stream" || event.agentId !== agentId) {
        return;
      }
      const streamEvent = event.event;
      if (streamEvent.type === "turn_canceled") {
        settle({
          agentId,
          status: "canceled",
          lastMessage: null,
          error: streamEvent.reason,
        });
        return;
      }
      if (streamEvent.type === "turn_failed") {
        settle({
          agentId,
          status: "failed",
          lastMessage: null,
          error: streamEvent.error,
        });
      }
    },
    { agentId, replayState: false },
  );

  void (async () => {
    try {
      const result = await agentManager.waitForAgentEvent(agentId, {
        signal: combinedController.signal,
        waitForActive: true,
      });
      if (settled) {
        return;
      }
      settle(normalizeClusterTurnResult(agentId, result));
    } catch (error) {
      if (settled) {
        return;
      }
      if (error instanceof Error && error.name === "AbortError") {
        settle({
          agentId,
          status: "canceled",
          lastMessage: null,
          error: error.message,
        });
        return;
      }
      settle({
        agentId,
        status: "failed",
        lastMessage: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return settledPromise;
}

async function waitForClusterWorker(
  agentManager: ClusterWorkerAgentManagerPort,
  agentId: string,
  timeoutMs: number,
): Promise<ClusterWorkerOutcome> {
  const snapshot = agentManager.getAgent(agentId);
  if (!snapshot) {
    return {
      agentId,
      status: "failed",
      lastMessage: null,
      error: `Cluster worker ${agentId} not found`,
    };
  }

  // Already finished a turn (e.g. daemon restart) → completed immediately.
  if (await agentManager.agentHasCompletedTurn(agentId)) {
    return {
      agentId,
      status: "completed",
      lastMessage: await agentManager.getLastAssistantMessage(agentId),
    };
  }

  // Terminal states that need no subscription.
  if (snapshot.lifecycle === "error") {
    return {
      agentId,
      status: "failed",
      lastMessage: null,
      error: snapshot.lastError ?? `Cluster worker ${agentId} errored`,
    };
  }
  if (snapshot.lifecycle === "closed") {
    return { agentId, status: "closed", lastMessage: null };
  }
  if (snapshot.pendingPermissions.size > 0) {
    return {
      agentId,
      status: "blocked",
      lastMessage: null,
      error: `Cluster worker ${agentId} is waiting for permission`,
    };
  }

  return await waitForClusterWorkerEdge(agentManager, agentId, timeoutMs);
}

function waitForClusterWorkerEdge(
  agentManager: ClusterWorkerAgentManagerPort,
  agentId: string,
  timeoutMs: number,
): Promise<ClusterWorkerOutcome> {
  let resolveSettled: (outcome: ClusterWorkerOutcome) => void = () => {};
  const settledPromise = new Promise<ClusterWorkerOutcome>((resolvePromise) => {
    resolveSettled = resolvePromise;
  });
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const settle = (outcome: ClusterWorkerOutcome) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // ignore cleanup errors
      }
      unsubscribe = null;
    }
    resolveSettled(outcome);
  };

  timeoutId = setTimeout(() => {
    settle({
      agentId,
      status: "timeout",
      lastMessage: null,
      error: `Cluster worker ${agentId} did not reach a terminal state within ${Math.round(timeoutMs / 1000)}s`,
    });
  }, timeoutMs);

  const checkIdleCompletion = () => {
    void (async () => {
      try {
        const completed = await agentManager.agentHasCompletedTurn(agentId);
        if (!completed) {
          return;
        }
        const lastMessage = await agentManager.getLastAssistantMessage(agentId);
        settle({ agentId, status: "completed", lastMessage });
      } catch (error) {
        settle({
          agentId,
          status: "failed",
          lastMessage: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  unsubscribe = agentManager.subscribe(
    (event: AgentManagerEvent) => {
      if (settled) {
        return;
      }

      if (event.type === "agent_stream") {
        if (event.agentId !== agentId) {
          return;
        }
        const streamEvent = event.event;
        if (streamEvent.type === "permission_requested") {
          settle({
            agentId,
            status: "blocked",
            lastMessage: null,
            error: `Cluster worker ${agentId} is waiting for permission "${streamEvent.request.name}"`,
          });
          return;
        }
        if (streamEvent.type === "turn_failed") {
          settle({
            agentId,
            status: "failed",
            lastMessage: null,
            error: streamEvent.error,
          });
          return;
        }
        if (streamEvent.type === "turn_canceled") {
          settle({ agentId, status: "canceled", lastMessage: null });
          return;
        }
        return;
      }

      if (event.type !== "agent_state" || event.agent.id !== agentId) {
        return;
      }

      if (event.agent.pendingPermissions.size > 0) {
        settle({
          agentId,
          status: "blocked",
          lastMessage: null,
          error: `Cluster worker ${agentId} is waiting for permission`,
        });
        return;
      }

      const lifecycle = event.agent.lifecycle;
      if (lifecycle === "running") {
        return;
      }
      if (lifecycle === "error") {
        settle({
          agentId,
          status: "failed",
          lastMessage: null,
          error: event.agent.lastError ?? `Cluster worker ${agentId} errored`,
        });
        return;
      }
      if (lifecycle === "closed") {
        settle({ agentId, status: "closed", lastMessage: null });
        return;
      }
      if (lifecycle === "idle") {
        checkIdleCompletion();
      }
    },
    { agentId, replayState: true },
  );

  return settledPromise;
}

function normalizeClusterTurnResult(
  agentId: string,
  result: WaitForAgentResult,
): ClusterWorkerOutcome {
  if (result.permission != null) {
    return {
      agentId,
      status: "blocked",
      lastMessage: result.lastMessage,
      error: `Cluster worker ${agentId} is waiting for permission`,
    };
  }
  switch (result.status) {
    case "idle":
      return { agentId, status: "completed", lastMessage: result.lastMessage };
    case "error":
      return {
        agentId,
        status: "failed",
        lastMessage: result.lastMessage,
        error: `Cluster worker ${agentId} failed`,
      };
    case "closed":
      return { agentId, status: "closed", lastMessage: result.lastMessage };
    default:
      return {
        agentId,
        status: "failed",
        lastMessage: result.lastMessage,
        error: `Cluster worker ${agentId} resolved with unexpected lifecycle "${result.status}"`,
      };
  }
}
