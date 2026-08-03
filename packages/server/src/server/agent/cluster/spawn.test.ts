import { expect, test } from "vitest";

import type {
  BoundCreateAgentCommand,
  CreateAgentCommandInput,
  CreateAgentCommandResult,
  CreateAgentFromMcpInput,
} from "../create-agent/create.js";
import type { ManagedAgent } from "../agent-manager.js";
import type { ClusterDraftPlan } from "./planner.js";
import type { ClusterWorkerProfile } from "./preferences.js";
import { buildWorkerInitialPrompt, spawnClusterWorkers, topologicalLayers } from "./spawn.js";

function makeSnapshot(id: string): ManagedAgent {
  return {
    id,
    cwd: "/tmp/ws",
    workspaceId: "ws-main",
    status: "idle",
    provider: "test",
  } as unknown as ManagedAgent;
}

function makeResult(
  id: string,
  initialPromptError: unknown | null = null,
): CreateAgentCommandResult {
  const snapshot = makeSnapshot(id);
  return {
    snapshot,
    liveSnapshot: snapshot,
    background: true,
    initialPromptStarted: true,
    initialPromptError,
  };
}

function createFakeCreateAgent(params?: {
  onCreate?: (input: CreateAgentFromMcpInput) => void;
  failOnTitle?: string;
  failWith?: Error;
  /** Map node title → agent id (defaults to auto uuid-like). */
  idForTitle?: (title: string, callIndex: number) => string;
}): {
  createAgent: BoundCreateAgentCommand;
  calls: CreateAgentFromMcpInput[];
} {
  const calls: CreateAgentFromMcpInput[] = [];
  let callIndex = 0;
  const createAgent: BoundCreateAgentCommand = async (input: CreateAgentCommandInput) => {
    if (input.kind !== "mcp") {
      throw new Error("expected mcp");
    }
    calls.push(input);
    params?.onCreate?.(input);
    if (params?.failOnTitle && input.title === params.failOnTitle) {
      throw params.failWith ?? new Error(`forced failure for ${input.title}`);
    }
    const id =
      params?.idForTitle?.(input.title, callIndex) ??
      `agent-${callIndex + 1}-${input.title.replace(/\s+/g, "-")}`;
    callIndex += 1;
    return makeResult(id);
  };
  return { createAgent, calls };
}

const basePlan: ClusterDraftPlan = {
  id: "plan-1",
  goal: "Ship cluster fan-out",
  workers: [
    {
      id: "w-research",
      title: "Research A",
      goal: "Survey existing hooks",
      role: "research",
      scope: { allow: ["packages/server"], deny: ["packages/app"] },
      isolation: "shared",
      successCriteria: ["List entry points"],
    },
    {
      id: "w-impl",
      title: "Impl B",
      goal: "Implement spawn",
      role: "impl",
      scope: { allow: ["packages/server/src/server/agent/cluster"], deny: [] },
      isolation: "worktree",
      dependsOn: ["w-research"],
      successCriteria: ["Tests pass"],
    },
  ],
};

test("topologicalLayers puts independent roots in the same layer", () => {
  const layers = topologicalLayers([
    {
      id: "a",
      title: "A",
      goal: "a",
      role: "impl",
      scope: { allow: ["x"], deny: [] },
      isolation: "worktree",
      successCriteria: [],
    },
    {
      id: "b",
      title: "B",
      goal: "b",
      role: "ui",
      scope: { allow: ["y"], deny: [] },
      isolation: "worktree",
      successCriteria: [],
    },
    {
      id: "c",
      title: "C",
      goal: "c",
      role: "audit",
      scope: { allow: ["z"], deny: [] },
      isolation: "shared",
      dependsOn: ["a", "b"],
      successCriteria: [],
    },
  ]);

  expect(layers).toHaveLength(2);
  expect(layers[0].map((w) => w.id).sort()).toEqual(["a", "b"]);
  expect(layers[1].map((w) => w.id)).toEqual(["c"]);
});

test("two root workers create in the same layer; dependent gets real UUID dependsOn", async () => {
  const { createAgent, calls } = createFakeCreateAgent({
    idForTitle: (title) => {
      if (title === "Root One") return "uuid-root-1";
      if (title === "Root Two") return "uuid-root-2";
      if (title === "Child") return "uuid-child";
      return `uuid-${title}`;
    },
  });

  const plan: ClusterDraftPlan = {
    id: "p",
    goal: "parallel roots",
    workers: [
      {
        id: "n1",
        title: "Root One",
        goal: "g1",
        role: "impl",
        scope: { allow: ["a"], deny: [] },
        isolation: "worktree",
        successCriteria: ["ok"],
      },
      {
        id: "n2",
        title: "Root Two",
        goal: "g2",
        role: "ui",
        scope: { allow: ["b"], deny: [] },
        isolation: "worktree",
        successCriteria: ["ok"],
      },
      {
        id: "n3",
        title: "Child",
        goal: "g3",
        role: "audit",
        scope: { allow: ["c"], deny: [] },
        isolation: "shared",
        dependsOn: ["n1", "n2"],
        successCriteria: ["ok"],
      },
    ],
  };

  const profiles: Record<string, ClusterWorkerProfile> = {
    impl: { provider: "opencode/impl", mode: "full-access", thinking: "max", autoArchive: true },
    ui: { provider: "opencode/ui", mode: "full-access", thinking: "max" },
    audit: { provider: "grok/audit", mode: "bypassPermissions", thinking: "high" },
  };

  const result = await spawnClusterWorkers({
    plan,
    mainAgent: { id: "main-agent", cwd: "/repo", workspaceId: "ws-1" },
    createAgent,
    resolveProfile: (role) => profiles[role] ?? null,
  });

  expect(result.agentIdByNodeId).toEqual({
    n1: "uuid-root-1",
    n2: "uuid-root-2",
    n3: "uuid-child",
  });
  // Same-layer create order is concurrent; only require set membership + child last layer.
  expect(new Set(result.workerIds)).toEqual(new Set(["uuid-root-1", "uuid-root-2", "uuid-child"]));
  expect(result.workerIds).toHaveLength(3);
  expect(result.workerIds[2]).toBe("uuid-child");
  expect(result.plan.workers.map((w) => w.provider)).toEqual([
    "opencode/impl",
    "opencode/ui",
    "grok/audit",
  ]);

  // First layer: two roots, no dependsOn graph ids
  const rootCalls = calls.filter((c) => c.title === "Root One" || c.title === "Root Two");
  expect(rootCalls).toHaveLength(2);
  for (const call of rootCalls) {
    expect(call.dependsOn).toBeUndefined();
  }

  const child = calls.find((c) => c.title === "Child");
  expect(child?.dependsOn?.slice().sort()).toEqual(["uuid-root-1", "uuid-root-2"]);
  // Never pass graph node ids as dependsOn
  expect(child?.dependsOn).not.toContain("n1");
  expect(child?.dependsOn).not.toContain("n2");
});

test("createAgent gets parent, background, notify disabled, autoArchive, worktree/shared, mode/thinking", async () => {
  const { createAgent, calls } = createFakeCreateAgent();
  const profiles: Record<string, ClusterWorkerProfile> = {
    research: {
      provider: "grok/grok-4.5",
      mode: "bypassPermissions",
      thinking: "high",
      autoArchive: false,
    },
    impl: {
      provider: "opencode/opencode-go/deepseek-v4-flash",
      mode: "full-access",
      thinking: "max",
      autoArchive: true,
    },
  };

  await spawnClusterWorkers({
    plan: basePlan,
    mainAgent: { id: "main-1", cwd: "E:/repo", workspaceId: "ws-main" },
    createAgent,
    resolveProfile: (role) => profiles[role] ?? null,
  });

  expect(calls).toHaveLength(2);

  const research = calls.find((c) => c.title === "Research A")!;
  expect(research.kind).toBe("mcp");
  expect(research.callerAgentId).toBe("main-1");
  expect(research.background).toBe(true);
  expect(research.notifyOnFinish).toBe(false);
  expect(research.unattended).toBe(true);
  expect(research.promptFailure).toBe("return-error");
  expect(research.autoArchive).toBe(false);
  expect(research.mode).toBe("bypassPermissions");
  expect(research.thinking).toBe("high");
  expect(research.cwd).toBe("E:/repo");
  expect(research.workspaceId).toBe("ws-main");
  expect(research.worktree).toBeUndefined();
  expect(research.internal).toBeUndefined();
  expect(research.provider).toBe("grok/grok-4.5");

  const impl = calls.find((c) => c.title === "Impl B")!;
  expect(impl.callerAgentId).toBe("main-1");
  expect(impl.background).toBe(true);
  expect(impl.notifyOnFinish).toBe(false);
  expect(impl.autoArchive).toBe(false);
  expect(impl.mode).toBe("full-access");
  expect(impl.thinking).toBe("max");
  expect(impl.worktree).toEqual({ action: "branch-off" });
  // worktree path should not force main workspace reuse
  expect(impl.workspaceId).toBeUndefined();
  expect(impl.internal).toBeUndefined();
  expect(impl.dependsOn).toHaveLength(1);
  expect(impl.dependsOn?.[0]).toMatch(/^agent-/);
  expect(impl.dependsOn?.[0]).not.toBe("w-research");
});

test("dependent worker keeps real UUID dependsOn and notify disabled", async () => {
  const { createAgent, calls } = createFakeCreateAgent({
    idForTitle: (title) => {
      if (title === "Root") return "uuid-root-9";
      if (title === "Child") return "uuid-child-9";
      return `uuid-${title}`;
    },
  });

  const plan: ClusterDraftPlan = {
    id: "p",
    goal: "g",
    workers: [
      {
        id: "n-root",
        title: "Root",
        goal: "g",
        role: "impl",
        scope: { allow: ["a"], deny: [] },
        isolation: "shared",
        successCriteria: ["ok"],
      },
      {
        id: "n-child",
        title: "Child",
        goal: "g",
        role: "audit",
        scope: { allow: ["b"], deny: [] },
        isolation: "shared",
        dependsOn: ["n-root"],
        successCriteria: ["ok"],
      },
    ],
  };

  await spawnClusterWorkers({
    plan,
    mainAgent: { id: "main-1", cwd: "/repo", workspaceId: "ws-1" },
    createAgent,
    resolveProfile: (role) => ({ provider: `p/${role}` }),
  });

  const child = calls.find((c) => c.title === "Child")!;
  expect(child.dependsOn).toEqual(["uuid-root-9"]);
  expect(child.dependsOn).not.toContain("n-root");
  expect(child.notifyOnFinish).toBe(false);
  expect(child.autoArchive).toBe(false);
  expect(child.background).toBe(true);
  expect(child.callerAgentId).toBe("main-1");
});

test("autoArchive pinned false even when plan and profile request true", async () => {
  const { createAgent, calls } = createFakeCreateAgent();
  await spawnClusterWorkers({
    plan: {
      id: "p",
      goal: "g",
      workers: [
        {
          id: "w1",
          title: "W",
          goal: "g",
          role: "impl",
          scope: { allow: ["a"], deny: [] },
          isolation: "shared",
          successCriteria: [],
          autoArchive: true,
        },
      ],
    },
    mainAgent: { id: "m", cwd: "/x", workspaceId: "ws" },
    createAgent,
    resolveProfile: () => ({
      provider: "p/m",
      autoArchive: true,
    }),
  });
  expect(calls[0].autoArchive).toBe(false);
});

test("initial prompt forbids nested agents, commit/push, and asks for evidence", async () => {
  const prompt = buildWorkerInitialPrompt({
    planGoal: "Overall",
    worker: {
      id: "w1",
      title: "T",
      goal: "Do the thing",
      role: "impl",
      scope: { allow: ["src"], deny: ["secrets"] },
      isolation: "worktree",
      successCriteria: ["tests green"],
    },
    dependsOnNodeIds: [],
    dependsOnAgentIds: [],
  });

  expect(prompt).toContain("Overall");
  expect(prompt).toContain("Do the thing");
  expect(prompt).toContain("Allow: src");
  expect(prompt).toContain("Deny: secrets");
  expect(prompt).toContain("tests green");
  expect(prompt.toLowerCase()).toMatch(/do not create|no create_agent|do not.*spawn/i);
  expect(prompt.toLowerCase()).toMatch(/commit|push|deploy/);
  expect(prompt.toLowerCase()).toMatch(/do not ask the user|禁止向用户提问|questions/);
  expect(prompt.toLowerCase()).toMatch(/evidence|verification|files you changed/);
});

test("missing provider creates zero agents", async () => {
  const { createAgent, calls } = createFakeCreateAgent();
  await expect(
    spawnClusterWorkers({
      plan: basePlan,
      mainAgent: { id: "m", cwd: "/x" },
      createAgent,
      resolveProfile: (role) => (role === "research" ? { provider: "grok/ok" } : null),
    }),
  ).rejects.toThrow(/no provider configured for role "impl"/);
  expect(calls).toHaveLength(0);
});

test("second-layer failure error includes already-created real agent ids", async () => {
  const { createAgent, calls } = createFakeCreateAgent({
    idForTitle: (title) => {
      if (title === "Research A") return "uuid-created-research";
      return `uuid-${title}`;
    },
    failOnTitle: "Impl B",
    failWith: new Error("provider offline"),
  });

  let message = "";
  try {
    await spawnClusterWorkers({
      plan: basePlan,
      mainAgent: { id: "m", cwd: "/x", workspaceId: "ws" },
      createAgent,
      resolveProfile: (role) =>
        role === "research"
          ? { provider: "grok/r" }
          : { provider: "opencode/i", mode: "full-access" },
    });
    expect.unreachable("should have thrown");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(calls.some((c) => c.title === "Research A")).toBe(true);
  expect(calls.some((c) => c.title === "Impl B")).toBe(true);
  expect(message).toContain("uuid-created-research");
  expect(message).toContain("w-research=uuid-created-research");
  expect(message).toContain("Cluster spawn failed after creating");
  expect(message).toContain("provider offline");
  expect(message).not.toMatch(/all workers created successfully/i);
});

test("same-layer fast failure waits for late sibling; error includes late-success UUID", async () => {
  const createAgent: BoundCreateAgentCommand = async (input) => {
    if (input.kind !== "mcp") {
      throw new Error("expected mcp");
    }
    if (input.title === "Fast Fail") {
      throw new Error("fast provider offline");
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    return makeResult("uuid-slow-success");
  };

  const plan: ClusterDraftPlan = {
    id: "p",
    goal: "g",
    workers: [
      {
        id: "w-fast",
        title: "Fast Fail",
        goal: "fails immediately",
        role: "impl",
        scope: { allow: ["a"], deny: [] },
        isolation: "shared",
        successCriteria: [],
      },
      {
        id: "w-slow",
        title: "Slow Success",
        goal: "succeeds late",
        role: "impl",
        scope: { allow: ["b"], deny: [] },
        isolation: "shared",
        successCriteria: [],
      },
    ],
  };

  let message = "";
  try {
    await spawnClusterWorkers({
      plan,
      mainAgent: { id: "m", cwd: "/x", workspaceId: "ws" },
      createAgent,
      resolveProfile: () => ({ provider: "p/m" }),
    });
    expect.unreachable("should have thrown");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain("uuid-slow-success");
  expect(message).toContain("w-slow=uuid-slow-success");
  expect(message).toContain("Cluster spawn failed after creating 1 worker(s)");
  expect(message).toContain("fast provider offline");
});

test("initialPromptError from createAgent throws", async () => {
  const createAgent: BoundCreateAgentCommand = async () =>
    makeResult("uuid-x", new Error("prompt rejected"));

  await expect(
    spawnClusterWorkers({
      plan: {
        id: "p",
        goal: "g",
        workers: [
          {
            id: "w1",
            title: "W",
            goal: "g",
            role: "impl",
            scope: { allow: ["a"], deny: [] },
            isolation: "shared",
            successCriteria: [],
          },
        ],
      },
      mainAgent: { id: "m", cwd: "/x" },
      createAgent,
      resolveProfile: () => ({ provider: "p/m" }),
    }),
  ).rejects.toThrow(/initialPromptError/);
});

test("initialPromptError still records snapshot.id in partial failure message", async () => {
  const createAgent: BoundCreateAgentCommand = async (input) => {
    if (input.kind !== "mcp") {
      throw new Error("expected mcp");
    }
    if (input.title === "Research A") {
      return makeResult("uuid-research-ok");
    }
    // Agent was created (has real id) but initial prompt failed to start.
    return makeResult("uuid-impl-created", new Error("prompt start failed"));
  };

  let message = "";
  try {
    await spawnClusterWorkers({
      plan: basePlan,
      mainAgent: { id: "m", cwd: "/x", workspaceId: "ws" },
      createAgent,
      resolveProfile: (role) => ({ provider: `p/${role}` }),
    });
    expect.unreachable("should have thrown");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain("initialPromptError");
  expect(message).toContain("uuid-research-ok");
  expect(message).toContain("uuid-impl-created");
  expect(message).toContain("w-impl=uuid-impl-created");
  expect(message).toContain("Cluster spawn failed after creating");
});
