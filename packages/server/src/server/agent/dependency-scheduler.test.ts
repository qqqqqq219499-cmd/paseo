import { expect, test, vi, beforeEach, afterEach } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import {
  buildDependencyContextBlock,
  clearDependencySchedulesForTests,
  getActiveDependencyScheduleCountForTests,
  rebuildDependencySchedules,
  scheduleDependentAgent,
  validateDependsOn,
} from "./dependency-scheduler.js";

const logger = createTestLogger();

type Subscriber = (event: { type: "agent_state"; agent: ManagedAgent }) => void;

function makeAgent(partial: Partial<ManagedAgent> & { id: string }): ManagedAgent {
  return {
    provider: "codex",
    cwd: "/tmp",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    config: { provider: "codex", cwd: "/tmp" },
    createdAt: new Date(),
    updatedAt: new Date(),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    labels: {},
    lifecycle: "idle",
    session: {} as ManagedAgent["session"],
    activeForegroundTurnId: null,
    ...partial,
  } as ManagedAgent;
}

function createHarness(options?: {
  agents?: Map<string, ManagedAgent>;
  records?: Map<string, StoredAgentRecord>;
  outputs?: Map<string, string | null>;
  completedTurns?: Set<string>;
}) {
  const agents = options?.agents ?? new Map<string, ManagedAgent>();
  const records = options?.records ?? new Map<string, StoredAgentRecord>();
  const outputs = options?.outputs ?? new Map<string, string | null>();
  const completedTurns = options?.completedTurns ?? new Set<string>();
  const subscribers = new Map<string, Set<Subscriber>>();
  const prompts: Array<{ agentId: string; prompt: string }> = [];

  const agentManager = {
    getAgent: (id: string) => agents.get(id),
    subscribe: (callback: Subscriber, opts?: { agentId?: string; replayState?: boolean }) => {
      const key = opts?.agentId ?? "*";
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(callback);
      return () => {
        set?.delete(callback);
      };
    },
    getLastAssistantMessage: async (id: string) => {
      if (outputs.has(id)) {
        return outputs.get(id) ?? null;
      }
      return `output-from-${id}`;
    },
    agentHasCompletedTurn: async (id: string) => completedTurns.has(id),
    // Used by sendPromptToAgent path in real code; tests stub stream/replace.
    tryRunOutOfBand: () => false,
    hasInFlightRun: () => false,
    streamAgent: (agentId: string, prompt: string) => {
      prompts.push({ agentId, prompt });
      return (async function* noop() {})();
    },
    replaceAgentRun: async (agentId: string, prompt: string) => {
      prompts.push({ agentId, prompt });
    },
    setAgentMode: async () => null,
  } as unknown as AgentManager;

  // sendPromptToAgent calls ensureAgentLoaded → get/storage; stub storage + minimal path
  // by monkeypatching through real sendPromptToAgent requires more. Instead, tests that
  // need fire will use schedule + emit and spy via replaceAgentRun after we patch
  // agent-prompt? Easier: intercept at agentStorage and use vi.mock - heavy.
  //
  // Practical approach: call buildDependencyContextBlock / validate / rebuild unit-style,
  // and for fire path use scheduleDependentAgent with a thin local fire by simulating
  // through the public API while stubbing sendPromptToAgent dependencies that
  // startAgentRun uses.
  //
  // We attach the methods startAgentRun needs via prototype tricks in each fire test.

  const agentStorage = {
    get: async (id: string) => records.get(id) ?? null,
    list: async () => Array.from(records.values()),
    upsert: async (record: StoredAgentRecord) => {
      records.set(record.id, record);
    },
  } as unknown as AgentStorage;

  function emit(agent: ManagedAgent) {
    agents.set(agent.id, agent);
    const targeted = subscribers.get(agent.id);
    const event = { type: "agent_state" as const, agent };
    if (targeted) {
      for (const cb of targeted) cb(event);
    }
    const global = subscribers.get("*");
    if (global) {
      for (const cb of global) cb(event);
    }
  }

  function baseRecord(id: string, extra?: Partial<StoredAgentRecord>): StoredAgentRecord {
    return {
      id,
      provider: "codex",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      labels: {},
      lastStatus: "idle",
      ...extra,
    } as StoredAgentRecord;
  }

  return {
    agentManager,
    agentStorage,
    agents,
    records,
    outputs,
    completedTurns,
    prompts,
    emit,
    baseRecord,
    subscribers,
  };
}

beforeEach(() => {
  clearDependencySchedulesForTests();
});

afterEach(() => {
  clearDependencySchedulesForTests();
});

test("validateDependsOn rejects missing dependency ids", async () => {
  const harness = createHarness();
  await expect(
    validateDependsOn({
      dependentAgentId: "child",
      dependsOn: ["missing-dep"],
      agentStorage: harness.agentStorage,
      agentManager: harness.agentManager,
    }),
  ).rejects.toThrow(/not found/);
});

test("validateDependsOn rejects self dependency", async () => {
  const harness = createHarness({
    agents: new Map([["child", makeAgent({ id: "child" })]]),
  });
  await expect(
    validateDependsOn({
      dependentAgentId: "child",
      dependsOn: ["child"],
      agentStorage: harness.agentStorage,
      agentManager: harness.agentManager,
    }),
  ).rejects.toThrow(/itself/);
});

test("validateDependsOn rejects cycles", async () => {
  const a = makeAgent({ id: "a", dependsOn: ["b"] });
  const b = makeAgent({ id: "b", dependsOn: ["c"] });
  const c = makeAgent({ id: "c", dependsOn: ["a"] });
  const harness = createHarness({
    agents: new Map([
      ["a", a],
      ["b", b],
      ["c", c],
    ]),
  });
  await expect(
    validateDependsOn({
      dependentAgentId: "a",
      dependsOn: ["b"],
      agentStorage: harness.agentStorage,
      agentManager: harness.agentManager,
    }),
  ).rejects.toThrow(/cycle/);
});

test("buildDependencyContextBlock injects outputs and marks unreadable", async () => {
  const harness = createHarness({
    outputs: new Map([
      ["dep-1", "hello from dep1"],
      ["dep-2", null],
    ]),
  });
  harness.records.set("dep-1", harness.baseRecord("dep-1", { title: "Dep One" }));
  harness.records.set("dep-2", harness.baseRecord("dep-2", { title: "Dep Two" }));

  const block = await buildDependencyContextBlock(harness, ["dep-1", "dep-2"]);
  expect(block).toContain("<paseo-dependency-context>");
  expect(block).toContain('agentId="dep-1"');
  expect(block).toContain("hello from dep1");
  expect(block).toContain("产出不可读");
});

test("single dependency ready fires injected prompt", async () => {
  const dep = makeAgent({ id: "dep-1", lifecycle: "idle" });
  const child = makeAgent({ id: "child-1", lifecycle: "idle", dependsOn: ["dep-1"] });
  const harness = createHarness({
    agents: new Map([
      ["dep-1", dep],
      ["child-1", child],
    ]),
    outputs: new Map([["dep-1", "UPSTREAM_OUTPUT_XYZ"]]),
  });
  harness.records.set("dep-1", harness.baseRecord("dep-1", { title: "Dep" }));
  harness.records.set(
    "child-1",
    harness.baseRecord("child-1", {
      dependsOn: ["dep-1"],
      dependencyPendingPrompt: "do the work",
    }),
  );

  // Wire sendPromptToAgent internals used by fireSchedule.
  Reflect.set(harness.agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(harness.agentManager, "hasInFlightRun", () => false);
  Reflect.set(harness.agentManager, "streamAgent", (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
    return (async function* noop() {})();
  });
  Reflect.set(harness.agentManager, "replaceAgentRun", async (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
  });
  Reflect.set(harness.agentManager, "setAgentMode", async () => null);
  Reflect.set(harness.agentManager, "waitForAgentRunStart", async () => undefined);

  scheduleDependentAgent({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    logger,
    dependentAgentId: "child-1",
    dependsOn: ["dep-1"],
    initialPrompt: "do the work",
  });

  // Simulate dep running then idle (finish edge).
  harness.emit(makeAgent({ id: "dep-1", lifecycle: "running" }));
  harness.emit(makeAgent({ id: "dep-1", lifecycle: "idle" }));

  await vi.waitFor(() => {
    expect(harness.prompts.length).toBeGreaterThan(0);
  });

  const fired = harness.prompts.find((p) => p.agentId === "child-1");
  expect(fired).toBeTruthy();
  expect(fired!.prompt).toContain("<paseo-dependency-context>");
  expect(fired!.prompt).toContain("UPSTREAM_OUTPUT_XYZ");
  expect(fired!.prompt).toContain("do the work");

  const stored = await harness.agentStorage.get("child-1");
  expect(stored?.dependencyFiredAt).toBeTruthy();
  expect(getActiveDependencyScheduleCountForTests()).toBe(0);
});

test("multi dependency waits until all ready", async () => {
  const harness = createHarness({
    agents: new Map([
      ["dep-a", makeAgent({ id: "dep-a", lifecycle: "idle" })],
      ["dep-b", makeAgent({ id: "dep-b", lifecycle: "idle" })],
      ["child", makeAgent({ id: "child", lifecycle: "idle", dependsOn: ["dep-a", "dep-b"] })],
    ]),
    outputs: new Map([
      ["dep-a", "A"],
      ["dep-b", "B"],
    ]),
  });
  harness.records.set(
    "child",
    harness.baseRecord("child", {
      dependsOn: ["dep-a", "dep-b"],
      dependencyPendingPrompt: "go",
    }),
  );
  Reflect.set(harness.agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(harness.agentManager, "hasInFlightRun", () => false);
  Reflect.set(harness.agentManager, "streamAgent", (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
    return (async function* noop() {})();
  });
  Reflect.set(harness.agentManager, "replaceAgentRun", async (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
  });

  scheduleDependentAgent({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    logger,
    dependentAgentId: "child",
    dependsOn: ["dep-a", "dep-b"],
    initialPrompt: "go",
  });

  harness.emit(makeAgent({ id: "dep-a", lifecycle: "running" }));
  harness.emit(makeAgent({ id: "dep-a", lifecycle: "idle" }));
  await new Promise((r) => setTimeout(r, 20));
  expect(harness.prompts.filter((p) => p.agentId === "child")).toHaveLength(0);

  harness.emit(makeAgent({ id: "dep-b", lifecycle: "running" }));
  harness.emit(makeAgent({ id: "dep-b", lifecycle: "idle" }));

  await vi.waitFor(() => {
    expect(harness.prompts.some((p) => p.agentId === "child")).toBe(true);
  });
  const prompt = harness.prompts.find((p) => p.agentId === "child")!.prompt;
  expect(prompt).toContain("A");
  expect(prompt).toContain("B");
  expect(prompt).toContain("go");
});

test("dependency failure records dependencyFailed and notifies caller", async () => {
  const harness = createHarness({
    agents: new Map([
      ["dep-x", makeAgent({ id: "dep-x", lifecycle: "idle" })],
      ["child", makeAgent({ id: "child", lifecycle: "idle", dependsOn: ["dep-x"] })],
      ["caller", makeAgent({ id: "caller", lifecycle: "idle" })],
    ]),
  });
  harness.records.set(
    "child",
    harness.baseRecord("child", {
      dependsOn: ["dep-x"],
      dependencyPendingPrompt: "never",
    }),
  );
  harness.records.set("caller", harness.baseRecord("caller"));

  Reflect.set(harness.agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(harness.agentManager, "hasInFlightRun", () => false);
  Reflect.set(harness.agentManager, "streamAgent", (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
    return (async function* noop() {})();
  });
  Reflect.set(harness.agentManager, "replaceAgentRun", async (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
  });

  scheduleDependentAgent({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    logger,
    dependentAgentId: "child",
    dependsOn: ["dep-x"],
    initialPrompt: "never",
    callerAgentId: "caller",
  });

  harness.emit(makeAgent({ id: "dep-x", lifecycle: "error", lastError: "boom" } as ManagedAgent));

  await vi.waitFor(async () => {
    const stored = await harness.agentStorage.get("child");
    expect(stored?.dependencyFailed?.reason).toMatch(/dep-x/);
  });

  expect(harness.prompts.some((p) => p.agentId === "child")).toBe(false);
  await vi.waitFor(() => {
    expect(harness.prompts.some((p) => p.agentId === "caller")).toBe(true);
  });
  const callerPrompt = harness.prompts.find((p) => p.agentId === "caller")!.prompt;
  expect(callerPrompt).toContain("dep-x");
  expect(getActiveDependencyScheduleCountForTests()).toBe(0);
});

test("rebuildDependencySchedules fires when deps already completed", async () => {
  const harness = createHarness({
    completedTurns: new Set(["dep-ready"]),
  });
  harness.records.set(
    "waiter",
    harness.baseRecord("waiter", {
      dependsOn: ["dep-ready"],
      dependencyPendingPrompt: "resume work",
    }),
  );
  harness.agents.set("waiter", makeAgent({ id: "waiter", lifecycle: "idle" }));
  harness.outputs.set("dep-ready", "from-restart");

  Reflect.set(harness.agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(harness.agentManager, "hasInFlightRun", () => false);
  Reflect.set(harness.agentManager, "streamAgent", (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
    return (async function* noop() {})();
  });
  Reflect.set(harness.agentManager, "replaceAgentRun", async (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
  });

  const result = await rebuildDependencySchedules({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    logger,
  });

  expect(result.restored).toBe(1);
  expect(result.firedImmediately).toBe(1);

  await vi.waitFor(() => {
    expect(harness.prompts.some((p) => p.agentId === "waiter")).toBe(true);
  });
  expect(harness.prompts.find((p) => p.agentId === "waiter")!.prompt).toContain("from-restart");
  expect(harness.prompts.find((p) => p.agentId === "waiter")!.prompt).toContain("resume work");
});

test("rebuildDependencySchedules reattaches when deps not yet done", async () => {
  const harness = createHarness({
    agents: new Map([
      ["dep-late", makeAgent({ id: "dep-late", lifecycle: "idle" })],
      ["waiter", makeAgent({ id: "waiter", lifecycle: "idle" })],
    ]),
  });
  harness.records.set(
    "waiter",
    harness.baseRecord("waiter", {
      dependsOn: ["dep-late"],
      dependencyPendingPrompt: "later",
    }),
  );
  harness.outputs.set("dep-late", "late-output");

  Reflect.set(harness.agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(harness.agentManager, "hasInFlightRun", () => false);
  Reflect.set(harness.agentManager, "streamAgent", (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
    return (async function* noop() {})();
  });
  Reflect.set(harness.agentManager, "replaceAgentRun", async (agentId: string, prompt: string) => {
    harness.prompts.push({ agentId, prompt });
  });

  const result = await rebuildDependencySchedules({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    logger,
  });
  expect(result.restored).toBe(1);
  expect(result.firedImmediately).toBe(0);
  expect(getActiveDependencyScheduleCountForTests()).toBe(1);

  harness.emit(makeAgent({ id: "dep-late", lifecycle: "running" }));
  harness.emit(makeAgent({ id: "dep-late", lifecycle: "idle" }));

  await vi.waitFor(() => {
    expect(harness.prompts.some((p) => p.agentId === "waiter")).toBe(true);
  });
});
