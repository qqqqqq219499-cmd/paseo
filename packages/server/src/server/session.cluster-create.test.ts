import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { CLUSTER_MODE_LABEL, CLUSTER_MODE_ON_VALUE } from "@getpaseo/protocol/agent-labels";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { Session } from "./session.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent/agent-sdk-types.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  asSessionLogger,
  asDownloadTokenStore,
  asPushTokenStore,
  asChatService,
  asScheduleService,
  asLoopService,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asSessionInternals,
  createProviderSnapshotManagerStub,
  findByType,
} from "./test-utils/session-stubs.js";
import { CLUSTER_TOOLS_DISABLED_ERROR } from "./agent/cluster/orchestrator.js";

const CREATE_AGENT_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class TrackingCreateSession implements AgentSession {
  readonly provider = "codex";
  readonly id = "create-agent-test-session";
  readonly capabilities = CREATE_AGENT_TEST_CAPABILITIES;
  static startTurnCount = 0;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    TrackingCreateSession.startTurnCount += 1;
    return { turnId: "turn-1" };
  }

  subscribe(): () => void {
    return () => {};
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class TrackingCreateClient implements AgentClient {
  readonly provider = "codex";
  readonly capabilities = CREATE_AGENT_TEST_CAPABILITIES;

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    return new TrackingCreateSession(config);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new TrackingCreateSession({
      provider: this.provider,
      cwd: overrides?.cwd ?? process.cwd(),
    });
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "gpt-test", label: "GPT Test", isDefault: true }],
      modes: [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface TestSession {
  handleMessage(message: unknown): Promise<void>;
}

function asTestSession(session: Session): TestSession {
  return asSessionInternals<TestSession>(session);
}

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  TrackingCreateSession.startTurnCount = 0;
  delete process.env.PASEO_CLUSTER_LEGACY_HARDPATH;
});

async function createClusterCreateHarness(options: {
  injectIntoAgents: boolean;
  labels?: Record<string, string>;
  initialPrompt?: string;
  /**
   * Opt into the legacy hidden-planner hard path (default cluster behavior is
   * now CEO lead mode). Tests that assert the old auto-plan/auto-spawn wiring
   * set this so they exercise the retained rollback path.
   */
  legacyHardPath?: boolean;
}) {
  if (options.legacyHardPath) {
    process.env.PASEO_CLUSTER_LEGACY_HARDPATH = "1";
  }
  const workdir = mkdtempSync(path.join(tmpdir(), "paseo-cluster-create-"));
  workdirs.push(workdir);
  const repo = path.join(workdir, "repo");
  mkdirSync(repo, { recursive: true });

  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const agentStorage = new AgentStorage(path.join(workdir, "agents"), asSessionLogger(logger));
  const agentManager = new AgentManager({
    clients: { codex: new TrackingCreateClient() },
    registry: agentStorage,
    logger: asSessionLogger(logger),
    idFactory: () => "00000000-0000-4000-8000-000000000c01",
  });
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(workdir, "projects.json"),
    asSessionLogger(logger),
  );
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(workdir, "workspaces.json"),
    asSessionLogger(logger),
  );
  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "proj-1",
      rootPath: repo,
      kind: "git",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: repo,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );

  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    new Session({
      clientId: "test-client",
      serverId: "test-server",
      scopes: ["*"],
      appVersion: null,
      onMessage: (message) => emitted.push(message),
      logger: asSessionLogger(logger),
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome: path.join(workdir, "paseo-home"),
      agentManager,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      chatService: asChatService(),
      scheduleService: asScheduleService(),
      loopService: asLoopService(),
      checkoutDiffManager: asCheckoutDiffManager({
        subscribe: async () => ({
          initial: { cwd: repo, files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        onWorkspaceStateMayHaveChanged: () => {},
        invalidateForge: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      workspaceGitService: createNoopWorkspaceGitService({
        getCheckout: async (cwd: string) => ({
          cwd,
          isGit: true,
          currentBranch: "main",
          remoteUrl: null,
          worktreeRoot: repo,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        }),
      }),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: options.injectIntoAgents }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: null,
    }),
  );

  await session.handleMessage({
    type: "create_agent_request",
    requestId: "req-cluster-create",
    workspaceId: "ws-1",
    config: { provider: "codex", cwd: repo },
    labels: options.labels ?? {},
    initialPrompt: options.initialPrompt,
    attachments: [],
  });

  return { agentManager, emitted, logger, workdir };
}

test("legacy hard path: cluster create routes long initialPrompt through the hidden-planner gate", async () => {
  const prompt =
    "并行写两个临时文件并验证它们存在：.tmp/cluster-create-a.txt 和 .tmp/cluster-create-b.txt";
  const { agentManager, emitted, logger } = await createClusterCreateHarness({
    injectIntoAgents: true,
    labels: { [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE },
    initialPrompt: prompt,
    legacyHardPath: true,
  });

  const created = findByType(emitted, "status");
  expect(created?.payload).toMatchObject({
    status: "agent_created",
    requestId: "req-cluster-create",
  });

  const [agent] = agentManager.listAgents();
  expect(agent?.labels?.[CLUSTER_MODE_LABEL]).toBe(CLUSTER_MODE_ON_VALUE);

  // Cluster owns the first turn: user message is persisted by the gate, not by
  // a normal provider startTurn on create.
  const timeline = agentManager.getTimeline(agent!.id);
  expect(timeline.some((item) => item.type === "user_message" && item.text === prompt)).toBe(true);
  expect(TrackingCreateSession.startTurnCount).toBe(0);

  // Background planning starts immediately after the gate returns handled.
  await vi.waitFor(() => {
    expect(
      logger.info.mock.calls.some((call: unknown[]) => call[1] === "agent.session.cluster_run"),
    ).toBe(true);
  });
});

test("legacy hard path: cluster create fails hard when Paseo tools are off", async () => {
  const { agentManager, emitted } = await createClusterCreateHarness({
    injectIntoAgents: false,
    labels: { [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE },
    initialPrompt: "写两个文件并验证它们都成功落盘",
    legacyHardPath: true,
  });

  expect(agentManager.listAgents()).toHaveLength(0);
  const failed = findByType(emitted, "status");
  expect(failed?.payload).toMatchObject({
    status: "agent_create_failed",
    requestId: "req-cluster-create",
    error: CLUSTER_TOOLS_DISABLED_ERROR,
  });
});

test("create_agent_request without cluster label still starts a single-agent initial turn", async () => {
  const { agentManager, emitted } = await createClusterCreateHarness({
    injectIntoAgents: true,
    labels: {},
    initialPrompt: "say hello and stop",
  });

  expect(findByType(emitted, "status")?.payload).toMatchObject({
    status: "agent_created",
  });
  expect(agentManager.listAgents()).toHaveLength(1);
  expect(TrackingCreateSession.startTurnCount).toBeGreaterThan(0);
});

test("cluster mode (CEO lead, default) runs a main-agent turn with a clean user message", async () => {
  const prompt = "重构鉴权中间件并补齐单元测试，覆盖登录、登出、令牌过期三条路径，分别落到独立文件";
  const { agentManager } = await createClusterCreateHarness({
    injectIntoAgents: true,
    labels: { [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE },
    initialPrompt: prompt,
  });

  const [agent] = agentManager.listAgents();
  expect(agent?.labels?.[CLUSTER_MODE_LABEL]).toBe(CLUSTER_MODE_ON_VALUE);

  // CEO lead mode does NOT hijack the turn: the main agent actually runs
  // (unlike the legacy hard path, which leaves startTurnCount at 0).
  expect(TrackingCreateSession.startTurnCount).toBeGreaterThan(0);

  // The user sees their own message verbatim in the timeline — the CEO
  // instruction block is sent inside a suppressed <paseo-system> envelope,
  // never surfaced as a user_message.
  const timeline = agentManager.getTimeline(agent!.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");
  expect(userMessages.some((item) => item.text === prompt)).toBe(true);
  expect(
    userMessages.some(
      (item) => item.text.includes("<paseo-system>") || item.text.includes("<user-request>"),
    ),
  ).toBe(false);
});
