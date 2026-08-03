import { expect, test } from "vitest";

import {
  CLUSTER_RUNTIME_NOT_CONFIGURED_ERROR,
  CLUSTER_TOOLS_DISABLED_ERROR,
  createEmptyClusterRun,
  shouldSkipCluster,
  startClusterRun,
} from "./orchestrator.js";
import type { ClusterRunState } from "./types.js";
import type { ClusterDraftPlan } from "./planner.js";
import type { SpawnClusterWorkersResult } from "./spawn.js";

const draftPlan: ClusterDraftPlan = {
  id: "plan-1",
  goal: "Investigate and implement",
  workers: [
    {
      id: "research",
      title: "Research",
      goal: "Find the cause",
      role: "research",
      scope: { allow: ["packages/server/**"], deny: [] },
      isolation: "shared",
      successCriteria: ["Report evidence"],
    },
  ],
};

function spawnResult(workerIds: string[]): SpawnClusterWorkersResult {
  return {
    plan: {
      ...draftPlan,
      workers: draftPlan.workers.map((worker) => ({ ...worker, provider: "grok/grok-4.5" })),
    },
    agentIdByNodeId: { research: workerIds[0] ?? "" },
    workerIds,
  };
}

test("skips empty prompts", () => {
  const decision = shouldSkipCluster("   ");
  expect(decision.skip).toBe(true);
  expect(decision.reason).toBe("empty prompt");
});

test("skips overly short prompts", () => {
  const decision = shouldSkipCluster("查一下");
  expect(decision.skip).toBe(true);
  expect(decision.reason).toContain("too short");
});

test("skips greetings only", () => {
  expect(shouldSkipCluster("你好").skip).toBe(true);
  expect(shouldSkipCluster("Hello!").skip).toBe(true);
  expect(shouldSkipCluster("在吗？").skip).toBe(true);
});

test("keeps substantive prompts", () => {
  expect(shouldSkipCluster("帮我排查登录接口 500 报错的原因").skip).toBe(false);
});

test("createEmptyClusterRun starts in idle", () => {
  expect(createEmptyClusterRun()).toEqual({ phase: "idle" });
});

test("tools off → failed without entering planning", async () => {
  const phases: ClusterRunState["phase"][] = [];
  const result = await startClusterRun({
    prompt: "帮我排查登录接口 500 报错的原因",
    paseoToolsEnabled: false,
    observer: (state) => {
      phases.push(state.phase);
    },
  });

  expect(result).toEqual({
    phase: "failed",
    error: CLUSTER_TOOLS_DISABLED_ERROR,
  });
  expect(phases).toEqual(["failed"]);
  expect(phases).not.toContain("planning");
  expect(result.phase === "failed" && result.error).toContain("Enable Paseo tools");
});

test("greeting/short → skipped_single", async () => {
  // CJK greetings are often < MIN length; still skip (chat-first).
  const shortGreeting = await startClusterRun({
    prompt: "你好",
    paseoToolsEnabled: true,
  });
  expect(shortGreeting.phase).toBe("skipped_single");

  // Long enough to pass length gate but still a pure greeting.
  const greeting = await startClusterRun({
    prompt: "hello!!!!",
    paseoToolsEnabled: true,
  });
  expect(greeting.phase).toBe("skipped_single");
  if (greeting.phase === "skipped_single") {
    expect(greeting.reason).toBe("greeting only");
  }

  const short = await startClusterRun({
    prompt: "查一下",
    paseoToolsEnabled: true,
  });
  expect(short.phase).toBe("skipped_single");
  if (short.phase === "skipped_single") {
    expect(short.reason).toContain("too short");
  }
});

test("long task without runtime → observer sees planning then failed", async () => {
  const phases: ClusterRunState["phase"][] = [];
  const result = await startClusterRun({
    prompt: "帮我排查登录接口 500 报错的原因",
    paseoToolsEnabled: true,
    observer: (state) => {
      phases.push(state.phase);
    },
  });

  expect(phases).toEqual(["planning", "failed"]);
  expect(result).toEqual({
    phase: "failed",
    error: CLUSTER_RUNTIME_NOT_CONFIGURED_ERROR,
  });
  expect(result.phase === "failed" && result.error).toMatch(/runtime.*not configured/i);
});

test("long task → planning → spawning → running with real worker ids", async () => {
  const phases: ClusterRunState["phase"][] = [];
  const result = await startClusterRun({
    prompt: "帮我并行调查并修复登录接口 500 报错",
    paseoToolsEnabled: true,
    planTask: async () => draftPlan,
    spawnTask: async (plan) => {
      expect(plan).toBe(draftPlan);
      return spawnResult(["agent-real-1", "agent-real-2"]);
    },
    observer: (state) => phases.push(state.phase),
  });

  expect(phases).toEqual(["planning", "spawning", "running"]);
  expect(result).toEqual({
    phase: "running",
    workerIds: ["agent-real-1", "agent-real-2"],
  });
});

test("planner failure is visible and never enters spawning", async () => {
  const phases: ClusterRunState["phase"][] = [];
  const result = await startClusterRun({
    prompt: "帮我并行调查并修复登录接口 500 报错",
    paseoToolsEnabled: true,
    planTask: async () => {
      throw new Error("invalid DAG");
    },
    spawnTask: async () => spawnResult([]),
    observer: (state) => phases.push(state.phase),
  });

  expect(phases).toEqual(["planning", "failed"]);
  expect(result).toEqual({ phase: "failed", error: "Cluster planning failed: invalid DAG" });
});

test("partial spawn failure preserves real ids in the visible error", async () => {
  const phases: ClusterRunState["phase"][] = [];
  const result = await startClusterRun({
    prompt: "帮我并行调查并修复登录接口 500 报错",
    paseoToolsEnabled: true,
    planTask: async () => draftPlan,
    spawnTask: async () => {
      throw new Error("Cluster spawn failed after creating 1 worker [research=agent-real-1]");
    },
    observer: (state) => phases.push(state.phase),
  });

  expect(phases).toEqual(["planning", "spawning", "failed"]);
  expect(result).toEqual({
    phase: "failed",
    error: "Cluster spawn failed after creating 1 worker [research=agent-real-1]",
  });
});
