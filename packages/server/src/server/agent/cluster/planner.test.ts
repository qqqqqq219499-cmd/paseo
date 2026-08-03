import { expect, test } from "vitest";

import type { BoundCreateAgentCommand } from "../create-agent/create.js";
import type { AgentPromptInput, AgentRunResult } from "../agent-sdk-types.js";
import {
  buildClusterPlannerPrompt,
  ClusterPlannerError,
  ClusterPlannerValidationError,
  normalizeScopeAllowPath,
  runClusterPlanner,
  scopeAllowPathsOverlap,
  validateClusterDraftPlan,
  validateClusterDraftPlanSemantics,
  type ClusterDraftPlan,
  type ClusterPlannerAgentManager,
} from "./planner.js";

function validTwoWorkerPlan(): ClusterDraftPlan {
  return {
    id: "plan-1",
    goal: "Investigate and fix login 500",
    workers: [
      {
        id: "research-api",
        title: "Research API errors",
        goal: "Find the login 500 root cause",
        role: "research",
        scope: { allow: ["packages/server/**"], deny: [] },
        isolation: "shared",
        successCriteria: ["report root cause with file evidence"],
      },
      {
        id: "impl-fix",
        title: "Implement fix",
        goal: "Apply the server fix",
        role: "impl",
        scope: { allow: ["packages/server/src/auth/**"], deny: [] },
        isolation: "worktree",
        dependsOn: ["research-api"],
        successCriteria: ["tests pass for auth path"],
      },
    ],
  };
}

test("validateClusterDraftPlan accepts a legal DAG", () => {
  const plan = validateClusterDraftPlan(validTwoWorkerPlan());
  expect(plan.workers).toHaveLength(2);
  expect(plan.workers[1]?.dependsOn).toEqual(["research-api"]);
  expect(plan.workers.every((worker) => !("provider" in worker))).toBe(true);
});

test("validateClusterDraftPlan rejects unknown dependsOn", () => {
  const raw = validTwoWorkerPlan();
  raw.workers[1] = {
    ...raw.workers[1]!,
    dependsOn: ["missing-node"],
  };
  expect(() => validateClusterDraftPlan(raw)).toThrow(ClusterPlannerValidationError);
  try {
    validateClusterDraftPlan(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ClusterPlannerValidationError);
    expect((error as ClusterPlannerValidationError).validationErrors.join("\n")).toContain(
      "unknown id",
    );
  }
});

test("validateClusterDraftPlan rejects cycles", () => {
  const raw: ClusterDraftPlan = {
    id: "cycle",
    goal: "cycle",
    workers: [
      {
        id: "a",
        title: "A",
        goal: "A",
        role: "impl",
        scope: { allow: ["a/**"], deny: [] },
        isolation: "worktree",
        dependsOn: ["b"],
        successCriteria: [],
      },
      {
        id: "b",
        title: "B",
        goal: "B",
        role: "impl",
        scope: { allow: ["b/**"], deny: [] },
        isolation: "worktree",
        dependsOn: ["a"],
        successCriteria: [],
      },
    ],
  };
  expect(() => validateClusterDraftPlan(raw)).toThrow(ClusterPlannerValidationError);
  try {
    validateClusterDraftPlan(raw);
  } catch (error) {
    expect((error as ClusterPlannerValidationError).validationErrors.join("\n")).toContain("cycle");
  }
});

test("validateClusterDraftPlan rejects duplicate ids", () => {
  const raw = validTwoWorkerPlan();
  raw.workers[1] = { ...raw.workers[1]!, id: "research-api" };
  expect(() => validateClusterDraftPlan(raw)).toThrow(ClusterPlannerValidationError);
  try {
    validateClusterDraftPlan(raw);
  } catch (error) {
    expect((error as ClusterPlannerValidationError).validationErrors.join("\n")).toContain(
      "duplicate id",
    );
  }
});

test("validateClusterDraftPlan rejects empty allow", () => {
  const raw = validTwoWorkerPlan();
  raw.workers[0] = {
    ...raw.workers[0]!,
    scope: { allow: [], deny: [] },
  };
  expect(() => validateClusterDraftPlan(raw)).toThrow();
});

test("validateClusterDraftPlan rejects more than 6 workers", () => {
  const raw: ClusterDraftPlan = {
    id: "too-many",
    goal: "too many",
    workers: Array.from({ length: 7 }, (_, index) => ({
      id: `w${index}`,
      title: `W${index}`,
      goal: `goal ${index}`,
      role: "research" as const,
      scope: { allow: [`path-${index}/**`], deny: [] },
      isolation: "shared" as const,
      successCriteria: [],
    })),
  };
  expect(() => validateClusterDraftPlan(raw)).toThrow();
});

test("validateClusterDraftPlan rejects self-dependency and duplicate edges", () => {
  const selfDep: ClusterDraftPlan = {
    id: "self",
    goal: "self",
    workers: [
      {
        id: "only",
        title: "Only",
        goal: "only",
        role: "impl",
        scope: { allow: ["x/**"], deny: [] },
        isolation: "worktree",
        dependsOn: ["only"],
        successCriteria: [],
      },
    ],
  };
  const selfErrors = validateClusterDraftPlanSemantics(selfDep);
  expect(selfErrors.some((error) => error.includes("self"))).toBe(true);

  const dupEdge: ClusterDraftPlan = {
    id: "dup",
    goal: "dup",
    workers: [
      {
        id: "a",
        title: "A",
        goal: "A",
        role: "research",
        scope: { allow: ["a/**"], deny: [] },
        isolation: "shared",
        successCriteria: [],
      },
      {
        id: "b",
        title: "B",
        goal: "B",
        role: "impl",
        scope: { allow: ["b/**"], deny: [] },
        isolation: "worktree",
        dependsOn: ["a", "a"],
        successCriteria: [],
      },
    ],
  };
  const dupErrors = validateClusterDraftPlanSemantics(dupEdge);
  expect(dupErrors.some((error) => error.includes("duplicate dependsOn"))).toBe(true);
});

test("validateClusterDraftPlan strips / ignores provider on input", () => {
  const raw = {
    ...validTwoWorkerPlan(),
    workers: [
      {
        ...validTwoWorkerPlan().workers[0],
        provider: "evil/should-not-be-trusted",
      },
      validTwoWorkerPlan().workers[1],
    ],
  };
  const plan = validateClusterDraftPlan(raw);
  expect(plan.workers[0]).not.toHaveProperty("provider");
});

test("normalizeScopeAllowPath unifies slashes and strips trailing globs", () => {
  expect(normalizeScopeAllowPath("packages\\server\\src\\**")).toBe("packages/server/src");
  expect(normalizeScopeAllowPath("packages/server/*")).toBe("packages/server");
  expect(normalizeScopeAllowPath("packages/server/**/")).toBe("packages/server");
  expect(normalizeScopeAllowPath("**")).toBe("");
});

test("scopeAllowPathsOverlap detects same / ancestor / child", () => {
  expect(scopeAllowPathsOverlap("packages/server/**", "packages\\server\\*")).toBe(true);
  expect(scopeAllowPathsOverlap("packages/server", "packages/server/src/auth")).toBe(true);
  expect(scopeAllowPathsOverlap("packages/app/src/ui", "packages/server")).toBe(false);
});

test("rejects concurrent impl/ui with overlapping scope.allow", () => {
  const raw: ClusterDraftPlan = {
    id: "overlap-parallel",
    goal: "two writers same tree",
    workers: [
      {
        id: "impl-a",
        title: "Impl A",
        goal: "edit server",
        role: "impl",
        scope: { allow: ["packages/server/**"], deny: [] },
        isolation: "worktree",
        successCriteria: [],
      },
      {
        id: "ui-b",
        title: "UI B",
        goal: "edit nested server ui path",
        role: "ui",
        scope: { allow: ["packages\\server\\src\\ui\\*"], deny: [] },
        isolation: "worktree",
        successCriteria: [],
      },
    ],
  };
  const errors = validateClusterDraftPlanSemantics(raw);
  expect(errors.some((error) => error.includes("scope.allow overlap"))).toBe(true);
  expect(() => validateClusterDraftPlan(raw)).toThrow(ClusterPlannerValidationError);
});

test("allows overlapping scope when impl/ui are serial via dependsOn", () => {
  const raw: ClusterDraftPlan = {
    id: "overlap-serial",
    goal: "serial writers may share tree",
    workers: [
      {
        id: "impl-a",
        title: "Impl A",
        goal: "edit server",
        role: "impl",
        scope: { allow: ["packages/server/**"], deny: [] },
        isolation: "worktree",
        successCriteria: [],
      },
      {
        id: "impl-b",
        title: "Impl B",
        goal: "edit nested after A",
        role: "impl",
        scope: { allow: ["packages/server/src/**"], deny: [] },
        isolation: "worktree",
        dependsOn: ["impl-a"],
        successCriteria: [],
      },
    ],
  };
  expect(validateClusterDraftPlanSemantics(raw)).toEqual([]);
  expect(validateClusterDraftPlan(raw).workers).toHaveLength(2);
});

test("allows overlapping scope for concurrent research (non-writable) workers", () => {
  const raw: ClusterDraftPlan = {
    id: "research-overlap",
    goal: "two researchers same tree",
    workers: [
      {
        id: "r1",
        title: "R1",
        goal: "read server",
        role: "research",
        scope: { allow: ["packages/server/**"], deny: [] },
        isolation: "shared",
        successCriteria: [],
      },
      {
        id: "r2",
        title: "R2",
        goal: "also read server",
        role: "research",
        scope: { allow: ["packages/server/src"], deny: [] },
        isolation: "shared",
        successCriteria: [],
      },
    ],
  };
  expect(validateClusterDraftPlanSemantics(raw)).toEqual([]);
});

test("allows concurrent impl workers with disjoint scopes", () => {
  const raw: ClusterDraftPlan = {
    id: "disjoint",
    goal: "parallel disjoint writers",
    workers: [
      {
        id: "impl-server",
        title: "Server",
        goal: "edit server",
        role: "impl",
        scope: { allow: ["packages/server/**"], deny: [] },
        isolation: "worktree",
        successCriteria: [],
      },
      {
        id: "impl-app",
        title: "App",
        goal: "edit app",
        role: "impl",
        scope: { allow: ["packages/app/**"], deny: [] },
        isolation: "worktree",
        successCriteria: [],
      },
    ],
  };
  expect(validateClusterDraftPlanSemantics(raw)).toEqual([]);
});

test("buildClusterPlannerPrompt encodes planner rules", () => {
  const prompt = buildClusterPlannerPrompt("fix login 500");
  expect(prompt).toContain("Chat-first");
  expect(prompt).toContain("JSON only");
  expect(prompt).toContain("2–3");
  expect(prompt).toContain("6");
  expect(prompt).toContain("dependsOn");
  expect(prompt).toContain("worktree");
  expect(prompt).toContain("shared");
  expect(prompt).toContain("fix login 500");
  expect(prompt).toContain("Do not include provider");
});

function createFakeHarness(options: {
  responses: string[];
  runBehavior?: (prompt: string, index: number) => AgentRunResult | Promise<AgentRunResult>;
  closeError?: Error;
  deleteError?: Error;
}) {
  const createCalls: unknown[] = [];
  let agentCounter = 0;
  const closed: string[] = [];
  const deleted: string[] = [];
  let runIndex = 0;

  const createAgent: BoundCreateAgentCommand = async (input) => {
    createCalls.push(input);
    agentCounter += 1;
    const id = `planner-agent-${agentCounter}`;
    return {
      snapshot: { id } as never,
      liveSnapshot: { id } as never,
      background: true,
      initialPromptStarted: false,
      initialPromptError: null,
    };
  };

  const agentManager: ClusterPlannerAgentManager = {
    runAgent: async (_agentId, prompt: AgentPromptInput) => {
      const index = runIndex;
      runIndex += 1;
      if (options.runBehavior) {
        return options.runBehavior(String(prompt), index);
      }
      const text =
        options.responses[index] ?? options.responses[options.responses.length - 1] ?? "";
      return {
        sessionId: "sess",
        finalText: text,
        timeline: text ? [{ type: "assistant_message" as const, text }] : [],
        canceled: false,
      };
    },
    closeAgent: async (agentId) => {
      closed.push(agentId);
      if (options.closeError) {
        throw options.closeError;
      }
    },
    deleteAgentState: async (agentId) => {
      deleted.push(agentId);
      if (options.deleteError) {
        throw options.deleteError;
      }
    },
  };

  return { createAgent, agentManager, createCalls, closed, deleted };
}

test("runClusterPlanner creates internal planner without initialPrompt/caller", async () => {
  const plan = validTwoWorkerPlan();
  const harness = createFakeHarness({
    responses: [JSON.stringify(plan)],
  });

  const result = await runClusterPlanner({
    prompt: "Investigate and fix login 500 with tests",
    plannerProvider: "grok/grok-4.5",
    mainAgent: { cwd: "E:\\repo", workspaceId: "ws-main" },
    createAgent: harness.createAgent,
    agentManager: harness.agentManager,
  });

  expect(result.workers).toHaveLength(2);
  expect(harness.createCalls).toHaveLength(1);
  const createInput = harness.createCalls[0] as Record<string, unknown>;
  expect(createInput).toMatchObject({
    kind: "mcp",
    provider: "grok/grok-4.5",
    internal: true,
    background: true,
    notifyOnFinish: false,
    unattended: true,
    promptFailure: "return-error",
    cwd: "E:\\repo",
    workspaceId: "ws-main",
  });
  expect(createInput).not.toHaveProperty("initialPrompt");
  expect(createInput).not.toHaveProperty("callerAgentId");
  expect(createInput).not.toHaveProperty("mode");
  expect(createInput).not.toHaveProperty("thinking");
  expect(harness.closed).toEqual(["planner-agent-1"]);
  expect(harness.deleted).toEqual(["planner-agent-1"]);
});

test("runClusterPlanner forwards plannerMode and plannerThinking to createAgent", async () => {
  const plan = validTwoWorkerPlan();
  const harness = createFakeHarness({
    responses: [JSON.stringify(plan)],
  });

  await runClusterPlanner({
    prompt: "Investigate and fix login 500 with tests",
    plannerProvider: "grok/grok-4.5",
    plannerMode: "full-access",
    plannerThinking: "xhigh",
    mainAgent: { cwd: "/repo", workspaceId: "ws" },
    createAgent: harness.createAgent,
    agentManager: harness.agentManager,
  });

  const createInput = harness.createCalls[0] as Record<string, unknown>;
  expect(createInput).toMatchObject({
    kind: "mcp",
    provider: "grok/grok-4.5",
    mode: "full-access",
    thinking: "xhigh",
    internal: true,
    background: true,
    notifyOnFinish: false,
  });
  expect(createInput).not.toHaveProperty("initialPrompt");
  expect(createInput).not.toHaveProperty("callerAgentId");
});

test("runClusterPlanner retries invalid JSON then succeeds", async () => {
  const plan = validTwoWorkerPlan();
  const harness = createFakeHarness({
    responses: ["not json at all", JSON.stringify(plan)],
  });

  const result = await runClusterPlanner({
    prompt: "Investigate and fix login 500 with tests",
    plannerProvider: "grok/grok-4.5",
    mainAgent: { cwd: "/repo", workspaceId: "ws" },
    createAgent: harness.createAgent,
    agentManager: harness.agentManager,
  });

  expect(result.goal).toBe(plan.goal);
  expect(result.workers).toHaveLength(2);
  expect(harness.closed).toEqual(["planner-agent-1"]);
  expect(harness.deleted).toEqual(["planner-agent-1"]);
});

test("runClusterPlanner still close+delete when planner fails", async () => {
  const harness = createFakeHarness({
    responses: ["still not json", "still broken"],
  });

  await expect(
    runClusterPlanner({
      prompt: "Investigate and fix login 500 with tests",
      plannerProvider: "grok/grok-4.5",
      mainAgent: { cwd: "/repo" },
      createAgent: harness.createAgent,
      agentManager: harness.agentManager,
    }),
  ).rejects.toThrow();

  expect(harness.closed).toEqual(["planner-agent-1"]);
  expect(harness.deleted).toEqual(["planner-agent-1"]);
});

test("runClusterPlanner cleanup errors do not mask planner failures", async () => {
  const harness = createFakeHarness({
    responses: ["bad", "still bad"],
    closeError: new Error("close boom"),
  });

  await expect(
    runClusterPlanner({
      prompt: "Investigate and fix login 500 with tests",
      plannerProvider: "grok/grok-4.5",
      mainAgent: { cwd: "/repo" },
      createAgent: harness.createAgent,
      agentManager: harness.agentManager,
    }),
  ).rejects.toThrow(/did not match|Invalid JSON|schema/i);

  expect(harness.closed).toEqual(["planner-agent-1"]);
});

test("runClusterPlanner fails on canceled and still cleans up", async () => {
  const harness = createFakeHarness({
    responses: [],
    runBehavior: async () => ({
      sessionId: "sess",
      finalText: "partial",
      timeline: [],
      canceled: true,
    }),
  });

  await expect(
    runClusterPlanner({
      prompt: "Investigate and fix login 500 with tests",
      plannerProvider: "grok/grok-4.5",
      mainAgent: { cwd: "/repo" },
      createAgent: harness.createAgent,
      agentManager: harness.agentManager,
    }),
  ).rejects.toBeInstanceOf(ClusterPlannerError);

  expect(harness.closed).toEqual(["planner-agent-1"]);
  expect(harness.deleted).toEqual(["planner-agent-1"]);
});

test("runClusterPlanner fails on empty finalText and still cleans up", async () => {
  const harness = createFakeHarness({
    responses: [""],
  });

  await expect(
    runClusterPlanner({
      prompt: "Investigate and fix login 500 with tests",
      plannerProvider: "grok/grok-4.5",
      mainAgent: { cwd: "/repo" },
      createAgent: harness.createAgent,
      agentManager: harness.agentManager,
    }),
  ).rejects.toThrow(/empty finalText/i);

  expect(harness.closed).toEqual(["planner-agent-1"]);
  expect(harness.deleted).toEqual(["planner-agent-1"]);
});
