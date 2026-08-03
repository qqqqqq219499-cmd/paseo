import { expect, test } from "vitest";

import type {
  AgentManagerEvent,
  AgentSubscriber,
  ManagedAgent,
  SubscribeOptions,
  WaitForAgentOptions,
  WaitForAgentResult,
} from "../agent-manager.js";
import type { AgentPermissionRequest, AgentStreamEvent } from "../agent-sdk-types.js";
import {
  waitForClusterAgentTurn,
  waitForClusterWorkers,
  type ClusterWorkerAgentManagerPort,
} from "./wait-workers.js";

type FakeLifecycle = "initializing" | "idle" | "running" | "error" | "closed";

interface FakeWorkerState {
  lifecycle: FakeLifecycle;
  completedTurn: boolean;
  lastMessage: string | null;
  lastError?: string;
  pendingPermissions: Map<string, AgentPermissionRequest>;
}

class FakeClusterAgentManager implements ClusterWorkerAgentManagerPort {
  readonly agents = new Map<string, FakeWorkerState>();
  private readonly listeners = new Set<{ agentId: string | null; callback: AgentSubscriber }>();
  activeSubscriptions = 0;
  unsubscribed = 0;

  addAgent(id: string, init: Partial<FakeWorkerState> = {}): FakeWorkerState {
    const state: FakeWorkerState = {
      lifecycle: "idle",
      completedTurn: false,
      lastMessage: null,
      pendingPermissions: new Map(),
      ...init,
    };
    this.agents.set(id, state);
    return state;
  }

  getAgent(agentId: string): ManagedAgent | undefined {
    const state = this.agents.get(agentId);
    if (!state) {
      return undefined;
    }
    return this.snapshot(agentId, state);
  }

  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void {
    const record = { agentId: options?.agentId ?? null, callback };
    this.listeners.add(record);
    this.activeSubscriptions += 1;
    if (options?.replayState !== false) {
      if (record.agentId) {
        const state = this.agents.get(record.agentId);
        if (state) {
          callback({ type: "agent_state", agent: this.snapshot(record.agentId, state) });
        }
      } else {
        for (const [id, state] of this.agents) {
          callback({ type: "agent_state", agent: this.snapshot(id, state) });
        }
      }
    }
    return () => {
      if (this.listeners.delete(record)) {
        this.unsubscribed += 1;
        this.activeSubscriptions -= 1;
      }
    };
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    return this.agents.get(agentId)?.lastMessage ?? null;
  }

  async agentHasCompletedTurn(agentId: string): Promise<boolean> {
    return this.agents.get(agentId)?.completedTurn ?? false;
  }

  async waitForAgentEvent(
    agentId: string,
    options?: WaitForAgentOptions,
  ): Promise<WaitForAgentResult> {
    const state = this.agents.get(agentId);
    if (!state) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const immediatePermission = firstPendingPermission(state);
    if (immediatePermission) {
      return {
        status: state.lifecycle,
        permission: immediatePermission,
        lastMessage: state.lastMessage,
      };
    }

    const busy = state.lifecycle === "running" || state.lifecycle === "initializing";
    if (!busy) {
      return { status: state.lifecycle, permission: null, lastMessage: state.lastMessage };
    }
    if (options?.signal?.aborted) {
      const reason = options.signal.reason;
      let message = "wait aborted";
      if (reason instanceof Error) {
        message = reason.message;
      } else if (typeof reason === "string") {
        message = reason;
      }
      throw Object.assign(new Error(message), { name: "AbortError" });
    }

    return await new Promise<WaitForAgentResult>((resolvePromise, reject) => {
      let finished = false;
      let cleanup = () => {};

      const finish = (result: WaitForAgentResult) => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        resolvePromise(result);
      };

      const unsub = this.subscribe(
        (event) => {
          if (finished) {
            return;
          }
          if (event.type !== "agent_state" || event.agent.id !== agentId) {
            return;
          }
          const pending = firstPendingPermission(event.agent);
          if (pending) {
            finish({
              status: event.agent.lifecycle,
              permission: pending,
              lastMessage: state.lastMessage,
            });
            return;
          }
          if (event.agent.lifecycle !== "running" && event.agent.lifecycle !== "initializing") {
            finish({
              status: event.agent.lifecycle,
              permission: null,
              lastMessage: state.lastMessage,
            });
          }
        },
        { agentId, replayState: false },
      );

      const abortHandler = () => {
        const reason = options?.signal?.reason;
        let message = "wait aborted";
        if (reason instanceof Error) {
          message = reason.message;
        } else if (typeof reason === "string") {
          message = reason;
        }
        cleanup();
        reject(Object.assign(new Error(message), { name: "AbortError" }));
      };
      if (options?.signal) {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
      cleanup = () => {
        unsub();
        options?.signal?.removeEventListener("abort", abortHandler);
      };
    });
  }

  setLifecycle(id: string, lifecycle: FakeLifecycle): void {
    const state = this.agents.get(id);
    if (!state) {
      return;
    }
    state.lifecycle = lifecycle;
    this.emitState(id);
  }

  setError(id: string, message: string): void {
    const state = this.agents.get(id);
    if (!state) {
      return;
    }
    state.lastError = message;
    state.lifecycle = "error";
    this.emitState(id);
  }

  setClosed(id: string): void {
    const state = this.agents.get(id);
    if (!state) {
      return;
    }
    state.lifecycle = "closed";
    this.emitState(id);
  }

  completeTurn(id: string, lastMessage: string): void {
    const state = this.agents.get(id);
    if (!state) {
      return;
    }
    state.completedTurn = true;
    state.lastMessage = lastMessage;
  }

  requestPermission(id: string, request: AgentPermissionRequest): void {
    const state = this.agents.get(id);
    if (!state) {
      return;
    }
    state.pendingPermissions.set(request.id, request);
    this.emitState(id);
  }

  pushStream(id: string, event: AgentStreamEvent): void {
    this.emit({ type: "agent_stream", agentId: id, event });
  }

  private snapshot(id: string, state: FakeWorkerState): ManagedAgent {
    return {
      id,
      lifecycle: state.lifecycle,
      pendingPermissions: state.pendingPermissions,
      lastError: state.lastError,
    } as unknown as ManagedAgent;
  }

  private emitState(id: string): void {
    const state = this.agents.get(id);
    if (!state) {
      return;
    }
    this.emit({ type: "agent_state", agent: this.snapshot(id, state) });
  }

  private emit(event: AgentManagerEvent): void {
    const eventAgentId = event.type === "agent_state" ? event.agent.id : event.agentId;
    for (const record of this.listeners) {
      if (record.agentId != null && record.agentId !== eventAgentId) {
        continue;
      }
      record.callback(event);
    }
  }
}

function firstPendingPermission(state: {
  pendingPermissions: Map<string, AgentPermissionRequest>;
}): AgentPermissionRequest | null {
  return state.pendingPermissions.values().next().value ?? null;
}

function makePermissionRequest(): AgentPermissionRequest {
  return {
    id: "perm-1",
    provider: "codex",
    name: "write_file",
    kind: "tool",
  };
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("already-completed worker returns immediately with lastMessage", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a", { completedTurn: true, lastMessage: "done A" });

  const outcomes = await waitForClusterWorkers({
    workerIds: ["worker-a"],
    agentManager: manager,
    timeoutMs: 500,
  });

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toEqual({
    agentId: "worker-a",
    status: "completed",
    lastMessage: "done A",
  });
  expect(manager.activeSubscriptions).toBe(0);
});

test("initial idle without assistant does not complete early; running→idle completes", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");

  let settled = false;
  const wait = waitForClusterWorkers({
    workerIds: ["worker-a"],
    agentManager: manager,
    timeoutMs: 500,
  }).then((outcomes) => {
    settled = true;
    return outcomes;
  });

  await tick(20);
  expect(settled).toBe(false);

  manager.setLifecycle("worker-a", "running");
  await tick(20);
  expect(settled).toBe(false);

  manager.completeTurn("worker-a", "done A");
  manager.setLifecycle("worker-a", "idle");

  const outcomes = await wait;
  expect(outcomes[0]?.status).toBe("completed");
  expect(outcomes[0]?.lastMessage).toBe("done A");
  expect(manager.activeSubscriptions).toBe(0);
});

test("lifecycle error maps to failed", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  const wait = waitForClusterWorkers({
    workerIds: ["worker-a"],
    agentManager: manager,
    timeoutMs: 500,
  });

  await tick();
  manager.setError("worker-a", "provider boom");

  const outcomes = await wait;
  expect(outcomes[0]?.status).toBe("failed");
  expect(outcomes[0]?.error).toContain("provider boom");
  expect(manager.activeSubscriptions).toBe(0);
});

test("lifecycle closed maps to closed", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  const wait = waitForClusterWorkers({
    workerIds: ["worker-a"],
    agentManager: manager,
    timeoutMs: 500,
  });

  await tick();
  manager.setLifecycle("worker-a", "running");
  await tick();
  manager.setClosed("worker-a");

  const outcomes = await wait;
  expect(outcomes[0]?.status).toBe("closed");
});

test("permission_requested stream event maps to blocked", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  const wait = waitForClusterWorkers({
    workerIds: ["worker-a"],
    agentManager: manager,
    timeoutMs: 500,
  });

  await tick();
  manager.pushStream("worker-a", {
    type: "permission_requested",
    provider: "codex",
    request: makePermissionRequest(),
  });

  const outcomes = await wait;
  expect(outcomes[0]?.status).toBe("blocked");
});

test("pending permission blocks immediately", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a", {
    pendingPermissions: new Map([["perm-1", makePermissionRequest()]]),
  });

  const outcomes = await waitForClusterWorkers({
    workerIds: ["worker-a"],
    agentManager: manager,
    timeoutMs: 200,
  });

  expect(outcomes[0]?.status).toBe("blocked");
  expect(manager.activeSubscriptions).toBe(0);
});

test("turn_canceled maps to canceled", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  const wait = waitForClusterWorkers({
    workerIds: ["worker-a"],
    agentManager: manager,
    timeoutMs: 500,
  });

  await tick();
  manager.pushStream("worker-a", {
    type: "turn_canceled",
    provider: "codex",
    reason: "user stopped",
  });

  const outcomes = await wait;
  expect(outcomes[0]?.status).toBe("canceled");
});

test("waits for all workers and preserves input order", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-slow");
  manager.addAgent("worker-fast");
  manager.addAgent("worker-fail");

  let settled = false;
  const wait = waitForClusterWorkers({
    workerIds: ["worker-slow", "worker-fast", "worker-fail"],
    agentManager: manager,
    timeoutMs: 500,
  }).then((outcomes) => {
    settled = true;
    return outcomes;
  });

  // Fast worker completes first; the wait must not resolve yet.
  manager.setLifecycle("worker-fast", "running");
  manager.completeTurn("worker-fast", "fast done");
  manager.setLifecycle("worker-fast", "idle");
  await tick(20);
  expect(settled).toBe(false);

  // Fail lands before the slow worker finishes.
  manager.setError("worker-fail", "boom");

  manager.setLifecycle("worker-slow", "running");
  manager.completeTurn("worker-slow", "slow done");
  manager.setLifecycle("worker-slow", "idle");

  const outcomes = await wait;
  expect(outcomes.map((o) => o.agentId)).toEqual(["worker-slow", "worker-fast", "worker-fail"]);
  expect(outcomes[0]?.status).toBe("completed");
  expect(outcomes[0]?.lastMessage).toBe("slow done");
  expect(outcomes[1]?.status).toBe("completed");
  expect(outcomes[2]?.status).toBe("failed");
  expect(manager.activeSubscriptions).toBe(0);
});

test("timed-out worker returns timeout and cleans up subscriptions", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");

  const outcomes = await waitForClusterWorkers({
    workerIds: ["worker-a"],
    agentManager: manager,
    timeoutMs: 30,
  });

  expect(outcomes[0]?.status).toBe("timeout");
  expect(outcomes[0]?.error).toMatch(/did not reach a terminal state/);
  expect(manager.activeSubscriptions).toBe(0);
  expect(manager.unsubscribed).toBeGreaterThan(0);
});

test("unknown worker returns failed with clear error", async () => {
  const manager = new FakeClusterAgentManager();

  const outcomes = await waitForClusterWorkers({
    workerIds: ["ghost"],
    agentManager: manager,
    timeoutMs: 200,
  });

  expect(outcomes[0]?.status).toBe("failed");
  expect(outcomes[0]?.error).toMatch(/ghost.*not found/);
});

test("waitForClusterAgentTurn normalizes completed turn", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  manager.completeTurn("worker-a", "bounce output");
  manager.setLifecycle("worker-a", "idle");

  const outcome = await waitForClusterAgentTurn({
    agentId: "worker-a",
    agentManager: manager,
    timeoutMs: 200,
  });

  expect(outcome.status).toBe("completed");
  expect(outcome.lastMessage).toBe("bounce output");
});

test("waitForClusterAgentTurn normalizes permission as blocked", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a", {
    pendingPermissions: new Map([["perm-1", makePermissionRequest()]]),
  });

  const outcome = await waitForClusterAgentTurn({
    agentId: "worker-a",
    agentManager: manager,
    timeoutMs: 200,
  });

  expect(outcome.status).toBe("blocked");
});

test("waitForClusterAgentTurn timeout returns timeout outcome instead of throwing", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  manager.setLifecycle("worker-a", "running");

  const outcome = await waitForClusterAgentTurn({
    agentId: "worker-a",
    agentManager: manager,
    timeoutMs: 30,
  });

  expect(outcome.status).toBe("timeout");
  expect(outcome.error).toMatch(/did not complete a turn/);
});

test("waitForClusterAgentTurn unknown agent returns failed", async () => {
  const manager = new FakeClusterAgentManager();

  const outcome = await waitForClusterAgentTurn({
    agentId: "ghost",
    agentManager: manager,
    timeoutMs: 200,
  });

  expect(outcome.status).toBe("failed");
  expect(outcome.error).toMatch(/ghost.*not found/);
});

test("waitForClusterAgentTurn maps turn_canceled to canceled, not completed", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  manager.setLifecycle("worker-a", "running");

  const wait = waitForClusterAgentTurn({
    agentId: "worker-a",
    agentManager: manager,
    timeoutMs: 500,
  });
  await tick();
  manager.pushStream("worker-a", {
    type: "turn_canceled",
    provider: "codex",
    reason: "review aborted",
  });

  const outcome = await wait;
  expect(outcome.status).toBe("canceled");
  expect(outcome.error).toContain("review aborted");
  expect(manager.activeSubscriptions).toBe(0);
});

test("waitForClusterAgentTurn maps turn_failed to failed with the real error", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  manager.setLifecycle("worker-a", "running");

  const wait = waitForClusterAgentTurn({
    agentId: "worker-a",
    agentManager: manager,
    timeoutMs: 500,
  });
  await tick();
  manager.pushStream("worker-a", {
    type: "turn_failed",
    provider: "codex",
    error: "provider rate limited",
  });

  const outcome = await wait;
  expect(outcome.status).toBe("failed");
  expect(outcome.error).toContain("provider rate limited");
  expect(manager.activeSubscriptions).toBe(0);
});

test("waitForClusterAgentTurn caller abort returns canceled with the abort reason", async () => {
  const manager = new FakeClusterAgentManager();
  manager.addAgent("worker-a");
  manager.setLifecycle("worker-a", "running");

  const controller = new AbortController();
  const wait = waitForClusterAgentTurn({
    agentId: "worker-a",
    agentManager: manager,
    timeoutMs: 500,
    signal: controller.signal,
  });
  await tick();
  controller.abort(new Error("caller gave up"));

  const outcome = await wait;
  expect(outcome.status).toBe("canceled");
  expect(outcome.error).toContain("caller gave up");
  expect(manager.activeSubscriptions).toBe(0);
});
