import { expect, test } from "vitest";
import type { SpawnClusterWorkersResult } from "./spawn.js";
import { runClusterReview, type ClusterReviewPort } from "./review-run.js";
import type { WorkerSpec } from "./types.js";
import type { ClusterWorkerOutcome } from "./wait-workers.js";

const MAIN_AGENT_ID = "main-agent-uuid";

const IMPL_EVIDENCE =
  "Changed packages/server/src/login.ts and packages/server/src/login.test.ts. " +
  "Verification: `npm run typecheck --workspace=@getpaseo/server` passed, vitest 42/42 green.";
const RESEARCH_EVIDENCE =
  "Root cause found: resolveLoginToken defined at packages/server/src/login.ts line 42; " +
  "the 500 comes from the token cache path (function invalidateCache, line 45).";

function implWorker(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    id: "w1",
    title: "Impl worker",
    goal: "Fix the login 500",
    role: "impl",
    provider: "grok",
    scope: { allow: ["packages/server"], deny: ["packages/app"] },
    isolation: "shared",
    successCriteria: ["login 500 fixed", "server tests green"],
    ...overrides,
  };
}

function researchWorker(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    id: "w2",
    title: "Research worker",
    goal: "Locate the root cause",
    role: "research",
    provider: "grok",
    scope: { allow: ["packages/server/src"], deny: [] },
    isolation: "shared",
    successCriteria: ["root cause identified with evidence"],
    ...overrides,
  };
}

function makeSpawnResult(
  overrides: Partial<SpawnClusterWorkersResult> = {},
): SpawnClusterWorkersResult {
  return {
    plan: {
      id: "plan-1",
      goal: "Fix login 500 end to end",
      workers: [implWorker(), researchWorker()],
    },
    agentIdByNodeId: { w1: "uuid-impl", w2: "uuid-research" },
    workerIds: ["uuid-impl", "uuid-research"],
    ...overrides,
  };
}

function makeThreeWorkerSpawnResult(): SpawnClusterWorkersResult {
  return makeSpawnResult({
    plan: {
      id: "plan-1",
      goal: "Fix login 500 end to end",
      workers: [implWorker(), researchWorker(), implWorker({ id: "w3", title: "UI worker" })],
    },
    agentIdByNodeId: { w1: "uuid-impl", w2: "uuid-research", w3: "uuid-ui" },
    workerIds: ["uuid-impl", "uuid-research", "uuid-ui"],
  });
}

interface FakePortState {
  sends: Array<{ agentId: string; prompt: string }>;
  workerOutcomes: ClusterWorkerOutcome[];
  mainOutcome: ClusterWorkerOutcome;
  bounceSendError?: unknown;
  bounceWaitByAgentId?: Record<string, ClusterWorkerOutcome>;
  waitForClusterAgentTurnCalls: string[];
}

function makePort(overrides: Partial<FakePortState> = {}): {
  state: FakePortState;
  port: ClusterReviewPort;
} {
  const state: FakePortState = {
    sends: [],
    workerOutcomes: [],
    mainOutcome: { agentId: MAIN_AGENT_ID, status: "completed", lastMessage: "Reviewed: all ok." },
    waitForClusterAgentTurnCalls: [],
    ...overrides,
  };
  const port: ClusterReviewPort = {
    waitForClusterWorkers: async () => state.workerOutcomes,
    waitForClusterAgentTurn: async (agentId) => {
      state.waitForClusterAgentTurnCalls.push(agentId);
      const bounceOutcome = state.bounceWaitByAgentId?.[agentId];
      if (agentId !== MAIN_AGENT_ID && bounceOutcome) {
        return bounceOutcome;
      }
      return state.mainOutcome;
    },
    sendPrompt: async (agentId, prompt) => {
      if (agentId !== MAIN_AGENT_ID && state.bounceSendError) {
        throw state.bounceSendError;
      }
      state.sends.push({ agentId, prompt });
    },
  };
  return { state, port };
}

function runReview(port: ClusterReviewPort, spawnResult: SpawnClusterWorkersResult) {
  return runClusterReview({
    spawnResult,
    originalUserRequest: "Fix the login 500 please",
    mainAgentId: MAIN_AGENT_ID,
    port,
  });
}

test("two successful workers: no bounce, single main prompt, done", async () => {
  const { state, port } = makePort({
    workerOutcomes: [
      { agentId: "uuid-impl", status: "completed", lastMessage: IMPL_EVIDENCE },
      { agentId: "uuid-research", status: "completed", lastMessage: RESEARCH_EVIDENCE },
    ],
  });

  const result = await runReview(port, makeSpawnResult());

  expect(result.final).toEqual({ phase: "done", workerIds: ["uuid-impl", "uuid-research"] });
  expect(result.packet.allOk).toBe(true);
  expect(result.packet.failedAgentIds).toEqual([]);
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0].agentId).toBe(MAIN_AGENT_ID);
  expect(state.waitForClusterAgentTurnCalls).toEqual([MAIN_AGENT_ID]);
});

test("bare Done bounces the same UUID once then passes; main prompt sent once", async () => {
  const { state, port } = makePort({
    workerOutcomes: [
      { agentId: "uuid-impl", status: "completed", lastMessage: "Done" },
      { agentId: "uuid-research", status: "completed", lastMessage: RESEARCH_EVIDENCE },
    ],
    bounceWaitByAgentId: {
      "uuid-impl": { agentId: "uuid-impl", status: "completed", lastMessage: IMPL_EVIDENCE },
    },
  });

  const result = await runReview(port, makeSpawnResult());

  expect(result.final.phase).toBe("done");
  const impl = result.packet.workers.find((w) => w.nodeId === "w1")!;
  expect(impl.agentId).toBe("uuid-impl");
  expect(impl.bounced).toBe(true);
  expect(impl.verdict.ok).toBe(true);
  expect(impl.finalText).toBe(IMPL_EVIDENCE);

  expect(state.sends).toHaveLength(2);
  expect(state.sends[0].agentId).toBe("uuid-impl");
  expect(state.sends[0].prompt).toContain("<paseo-system>");
  expect(state.sends[0].prompt).toContain("Cluster review: evidence required");
  expect(state.sends[0].prompt).toContain("uuid-impl");
  expect(state.sends[1].agentId).toBe(MAIN_AGENT_ID);
  expect(state.waitForClusterAgentTurnCalls).toEqual(["uuid-impl", MAIN_AGENT_ID]);
});

test("failed/timeout/blocked workers: no bounce, packet fail, main summarizes once, run failed", async () => {
  const { state, port } = makePort({
    workerOutcomes: [
      { agentId: "uuid-impl", status: "failed", lastMessage: null, error: "provider exploded" },
      {
        agentId: "uuid-research",
        status: "timeout",
        lastMessage: null,
        error: "did not complete in time",
      },
      { agentId: "uuid-ui", status: "blocked", lastMessage: null, error: "waiting for permission" },
    ],
  });

  const result = await runReview(port, makeThreeWorkerSpawnResult());

  expect(result.final.phase).toBe("failed");
  expect(result.final.error).toContain("uuid-impl");
  expect(result.packet.allOk).toBe(false);
  expect(new Set(result.packet.failedAgentIds)).toEqual(
    new Set(["uuid-impl", "uuid-research", "uuid-ui"]),
  );
  for (const worker of result.packet.workers) {
    expect(worker.verdict.ok).toBe(false);
    expect(worker.bounced).toBe(false);
  }
  // One summary prompt to the main agent, no worker sends, no waits on workers.
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0].agentId).toBe(MAIN_AGENT_ID);
  expect(state.waitForClusterAgentTurnCalls).toEqual([MAIN_AGENT_ID]);
});

test("bounce send failure converges to verdict fail without breaking other workers", async () => {
  const { port } = makePort({
    workerOutcomes: [
      { agentId: "uuid-impl", status: "completed", lastMessage: "Done" },
      { agentId: "uuid-research", status: "completed", lastMessage: RESEARCH_EVIDENCE },
    ],
    bounceSendError: new Error("worker agent vanished"),
  });

  const result = await runReview(port, makeSpawnResult());

  expect(result.final.phase).toBe("failed");
  const impl = result.packet.workers.find((w) => w.nodeId === "w1")!;
  expect(impl.verdict.ok).toBe(false);
  expect(impl.verdict.reason).toContain("bounce_failed");
  expect(impl.verdict.reason).toContain("worker agent vanished");
  const research = result.packet.workers.find((w) => w.nodeId === "w2")!;
  expect(research.verdict.ok).toBe(true);
  expect(research.finalText).toBe(RESEARCH_EVIDENCE);
  expect(result.packet.failedAgentIds).toEqual(["uuid-impl"]);
});

test("bounce wait non-completed outcome converges to verdict fail", async () => {
  const { state, port } = makePort({
    workerOutcomes: [
      { agentId: "uuid-impl", status: "completed", lastMessage: "Done" },
      { agentId: "uuid-research", status: "completed", lastMessage: RESEARCH_EVIDENCE },
    ],
    bounceWaitByAgentId: {
      "uuid-impl": {
        agentId: "uuid-impl",
        status: "failed",
        lastMessage: null,
        error: "turn failed after bounce",
      },
    },
  });

  const result = await runReview(port, makeSpawnResult());

  expect(result.final.phase).toBe("failed");
  const impl = result.packet.workers.find((w) => w.nodeId === "w1")!;
  expect(impl.verdict.ok).toBe(false);
  expect(impl.verdict.reason).toContain("bounce_failed");
  expect(impl.verdict.reason).toContain("turn failed after bounce");
  const research = result.packet.workers.find((w) => w.nodeId === "w2")!;
  expect(research.verdict.ok).toBe(true);
  expect(state.sends).toHaveLength(2);
});

test.each(["timeout", "blocked", "canceled"] as const)(
  "main review %s → run failed with visible error, prompt still sent once",
  async (status) => {
    const { state, port } = makePort({
      workerOutcomes: [
        { agentId: "uuid-impl", status: "completed", lastMessage: IMPL_EVIDENCE },
        { agentId: "uuid-research", status: "completed", lastMessage: RESEARCH_EVIDENCE },
      ],
      mainOutcome: {
        agentId: MAIN_AGENT_ID,
        status,
        lastMessage: null,
        error: `main ${status} reason`,
      },
    });

    const result = await runReview(port, makeSpawnResult());

    expect(result.final.phase).toBe("failed");
    expect(result.final.error).toContain(status);
    expect(result.final.error).toContain("main agent");
    expect(result.packet.allOk).toBe(true);
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0].agentId).toBe(MAIN_AGENT_ID);
  },
);

test("packet fail with completed main turn still ends failed (no false success)", async () => {
  const { state, port } = makePort({
    workerOutcomes: [
      { agentId: "uuid-impl", status: "failed", lastMessage: null, error: "boom" },
      { agentId: "uuid-research", status: "completed", lastMessage: RESEARCH_EVIDENCE },
    ],
  });

  const result = await runReview(port, makeSpawnResult());

  expect(result.final.phase).toBe("failed");
  expect(result.final.error).toContain("uuid-impl");
  expect(state.sends).toHaveLength(1);
});

test("main prompt carries real UUIDs, scope, criteria, failedAgentIds and no-false-success rule", async () => {
  const { state, port } = makePort({
    workerOutcomes: [
      { agentId: "uuid-impl", status: "failed", lastMessage: null, error: "boom" },
      { agentId: "uuid-research", status: "completed", lastMessage: RESEARCH_EVIDENCE },
    ],
  });

  const result = await runReview(port, makeSpawnResult());
  expect(result.final.phase).toBe("failed");

  expect(state.sends).toHaveLength(1);
  const prompt = state.sends[0].prompt;
  expect(prompt).toContain("Fix the login 500 please");
  expect(prompt).toContain("Fix login 500 end to end");
  expect(prompt).toContain("uuid-impl");
  expect(prompt).toContain("uuid-research");
  expect(prompt).toContain("packages/server");
  expect(prompt).toContain("packages/app");
  expect(prompt).toContain("login 500 fixed");
  expect(prompt).toContain("server tests green");
  expect(prompt).toContain("MUST NOT claim the overall task succeeded");
});
