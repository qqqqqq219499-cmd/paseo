import type { Logger } from "pino";

import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  formatSystemNotificationPrompt,
  sendPromptToAgent,
  setupFinishNotification,
} from "./agent-prompt.js";

const PER_DEPENDENCY_OUTPUT_LIMIT = 4_000;
const TOTAL_DEPENDENCY_OUTPUT_LIMIT = 16_000;

export interface DependencySchedulerDeps {
  agentManager: Pick<
    AgentManager,
    "getAgent" | "subscribe" | "getLastAssistantMessage" | "agentHasCompletedTurn"
  >;
  agentStorage: Pick<AgentStorage, "get" | "list" | "upsert">;
  logger: Logger;
}

export interface ScheduleDependentAgentParams extends DependencySchedulerDeps {
  dependentAgentId: string;
  dependsOn: string[];
  initialPrompt: string;
  callerAgentId?: string;
  notifyOnFinish?: boolean;
  /**
   * When true (daemon rebuild), deps that already have assistant output count as ready
   * without waiting for a fresh running→idle edge.
   */
  treatCompletedDepsAsReady?: boolean;
}

export interface ValidateDependsOnParams {
  dependentAgentId: string;
  dependsOn: string[];
  agentStorage: Pick<AgentStorage, "get">;
  agentManager: Pick<AgentManager, "getAgent">;
  /** Optional extra records for cycle walk (e.g. in-memory graph). */
  resolveDependsOn?: (agentId: string) => Promise<string[] | undefined>;
}

type ReadyState = "pending" | "ready" | "failed";

interface ActiveSchedule {
  dependentAgentId: string;
  dependsOn: string[];
  initialPrompt: string;
  callerAgentId?: string;
  notifyOnFinish: boolean;
  treatCompletedDepsAsReady: boolean;
  depState: Map<string, ReadyState>;
  unsubscribers: Array<() => void>;
  fired: boolean;
  selfUnsubscriber: (() => void) | null;
}

const activeSchedules = new Map<string, ActiveSchedule>();

export function clearDependencySchedulesForTests(): void {
  for (const schedule of activeSchedules.values()) {
    cleanupSchedule(schedule);
  }
  activeSchedules.clear();
}

export function getActiveDependencyScheduleCountForTests(): number {
  return activeSchedules.size;
}

/**
 * Validate dependency ids exist and the dependsOn graph has no cycle through this agent.
 */
export async function validateDependsOn(params: ValidateDependsOnParams): Promise<void> {
  const dependsOn = normalizeDependsOn(params.dependsOn);
  if (dependsOn.length === 0) {
    return;
  }

  if (dependsOn.includes(params.dependentAgentId)) {
    throw new Error(`dependsOn cannot include the agent itself (${params.dependentAgentId})`);
  }

  for (const depId of dependsOn) {
    const live = params.agentManager.getAgent(depId);
    const stored = live ? null : await params.agentStorage.get(depId);
    if (!live && !stored) {
      throw new Error(`dependsOn agent not found: ${depId}`);
    }
  }

  await assertNoDependsOnCycle({
    startId: params.dependentAgentId,
    edgesFromStart: dependsOn,
    agentStorage: params.agentStorage,
    agentManager: params.agentManager,
    resolveDependsOn: params.resolveDependsOn,
  });
}

async function assertNoDependsOnCycle(params: {
  startId: string;
  edgesFromStart: string[];
  agentStorage: Pick<AgentStorage, "get">;
  agentManager: Pick<AgentManager, "getAgent">;
  resolveDependsOn?: (agentId: string) => Promise<string[] | undefined>;
}): Promise<void> {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const loadEdges = async (agentId: string): Promise<string[]> => {
    if (agentId === params.startId) {
      return params.edgesFromStart;
    }
    if (params.resolveDependsOn) {
      const resolved = await params.resolveDependsOn(agentId);
      if (resolved) {
        return normalizeDependsOn(resolved);
      }
    }
    const live = params.agentManager.getAgent(agentId);
    if (live?.dependsOn) {
      return normalizeDependsOn(live.dependsOn);
    }
    const stored = await params.agentStorage.get(agentId);
    return normalizeDependsOn(stored?.dependsOn ?? []);
  };

  const dfs = async (nodeId: string): Promise<void> => {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      throw new Error(`dependsOn cycle detected involving agent ${nodeId}`);
    }
    visiting.add(nodeId);
    const edges = await loadEdges(nodeId);
    for (const next of edges) {
      await dfs(next);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  await dfs(params.startId);
}

export function normalizeDependsOn(dependsOn: string[] | undefined): string[] {
  if (!dependsOn || dependsOn.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dependsOn) {
    const id = raw.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * After the dependent agent is created (session up, no initial prompt yet),
 * watch dependencies and fire the deferred initial prompt once all are ready.
 */
export function scheduleDependentAgent(params: ScheduleDependentAgentParams): void {
  const dependsOn = normalizeDependsOn(params.dependsOn);
  if (dependsOn.length === 0) {
    return;
  }

  cancelDependencySchedule(params.dependentAgentId);

  const schedule: ActiveSchedule = {
    dependentAgentId: params.dependentAgentId,
    dependsOn,
    initialPrompt: params.initialPrompt,
    callerAgentId: params.callerAgentId,
    notifyOnFinish: params.notifyOnFinish === true,
    treatCompletedDepsAsReady: params.treatCompletedDepsAsReady === true,
    depState: new Map(dependsOn.map((id) => [id, "pending" as ReadyState])),
    unsubscribers: [],
    fired: false,
    selfUnsubscriber: null,
  };
  activeSchedules.set(params.dependentAgentId, schedule);

  // Clean up if the dependent itself is archived/closed before firing.
  schedule.selfUnsubscriber = params.agentManager.subscribe(
    (event) => {
      if (event.type !== "agent_state") {
        return;
      }
      if (event.agent.id !== params.dependentAgentId) {
        return;
      }
      if (event.agent.lifecycle === "closed") {
        cancelDependencySchedule(params.dependentAgentId);
      }
    },
    { agentId: params.dependentAgentId, replayState: false },
  );

  for (const depId of dependsOn) {
    watchDependency(params, schedule, depId);
  }

  // Immediate readiness check (already-idle deps, or restart path helpers).
  void evaluateSchedule(params, schedule).catch((error) => {
    params.logger.error(
      { err: error, dependentAgentId: params.dependentAgentId },
      "dependency schedule initial evaluation failed",
    );
  });
}

function watchDependency(
  deps: DependencySchedulerDeps,
  schedule: ActiveSchedule,
  depId: string,
): void {
  let hasSeenRunning = false;
  let unsubscribe: (() => void) | null = null;

  unsubscribe = deps.agentManager.subscribe(
    (event) => {
      if (schedule.fired) {
        return;
      }
      if (event.type !== "agent_state" || event.agent.id !== depId) {
        return;
      }

      const lifecycle = event.agent.lifecycle;
      if (lifecycle === "running") {
        hasSeenRunning = true;
        return;
      }
      if (lifecycle === "error") {
        schedule.depState.set(depId, "failed");
        void failSchedule(deps, schedule, `dependency ${depId} errored`).catch((error) => {
          deps.logger.error(
            { err: error, dependentAgentId: schedule.dependentAgentId, depId },
            "dependency failure propagation failed",
          );
        });
        return;
      }
      if (lifecycle === "closed") {
        // Closed without a completed ready mark → treat as failed.
        if (schedule.depState.get(depId) !== "ready") {
          schedule.depState.set(depId, "failed");
          void failSchedule(deps, schedule, `dependency ${depId} closed before completing`).catch(
            (error) => {
              deps.logger.error(
                { err: error, dependentAgentId: schedule.dependentAgentId, depId },
                "dependency failure propagation failed",
              );
            },
          );
        }
        return;
      }
      if (lifecycle === "idle" && hasSeenRunning) {
        schedule.depState.set(depId, "ready");
        void evaluateSchedule(deps, schedule).catch((error) => {
          deps.logger.error(
            { err: error, dependentAgentId: schedule.dependentAgentId, depId },
            "dependency schedule evaluation failed",
          );
        });
      }
    },
    { agentId: depId, replayState: false },
  );

  schedule.unsubscribers.push(() => unsubscribe?.());

  // Catch already-running deps so the subsequent idle edge counts.
  const snap = deps.agentManager.getAgent(depId);
  if (snap?.lifecycle === "running") {
    hasSeenRunning = true;
  }
}

async function evaluateSchedule(
  deps: DependencySchedulerDeps,
  schedule: ActiveSchedule,
): Promise<void> {
  if (schedule.fired) {
    return;
  }

  // Refresh readiness from live state / completed turns for pending deps.
  for (const depId of schedule.dependsOn) {
    if (schedule.depState.get(depId) !== "pending") {
      continue;
    }
    const snap = deps.agentManager.getAgent(depId);
    if (snap?.lifecycle === "error") {
      schedule.depState.set(depId, "failed");
      await failSchedule(deps, schedule, `dependency ${depId} errored`);
      return;
    }
    if (snap?.lifecycle === "closed") {
      schedule.depState.set(depId, "failed");
      await failSchedule(deps, schedule, `dependency ${depId} closed before completing`);
      return;
    }
    // Restart path only: already-finished deps count without a fresh idle edge.
    if (schedule.treatCompletedDepsAsReady) {
      const completed = await deps.agentManager.agentHasCompletedTurn(depId);
      if (completed) {
        schedule.depState.set(depId, "ready");
        continue;
      }
    }
  }

  if ([...schedule.depState.values()].some((s) => s === "failed")) {
    const failedId =
      [...schedule.depState.entries()].find(([, state]) => state === "failed")?.[0] ?? "unknown";
    await failSchedule(deps, schedule, `dependency ${failedId} failed`);
    return;
  }

  if (![...schedule.depState.values()].every((s) => s === "ready")) {
    return;
  }

  await fireSchedule(deps, schedule);
}

async function fireSchedule(
  deps: DependencySchedulerDeps,
  schedule: ActiveSchedule,
): Promise<void> {
  if (schedule.fired) {
    return;
  }
  schedule.fired = true;
  cleanupSchedule(schedule);
  activeSchedules.delete(schedule.dependentAgentId);

  const record = await deps.agentStorage.get(schedule.dependentAgentId);
  if (record?.dependencyFiredAt || record?.dependencyFailed) {
    deps.logger.info(
      { dependentAgentId: schedule.dependentAgentId },
      "dependency schedule already settled; skipping fire",
    );
    return;
  }
  if (record?.archivedAt) {
    deps.logger.info(
      { dependentAgentId: schedule.dependentAgentId },
      "dependent agent archived before dependency fire; skipping",
    );
    return;
  }

  const contextBlock = await buildDependencyContextBlock(deps, schedule.dependsOn);
  const prompt = `${contextBlock}\n\n${schedule.initialPrompt}`;

  const firedAt = new Date().toISOString();
  if (record) {
    const { dependencyPendingPrompt: _cleared, ...rest } = record;
    await deps.agentStorage.upsert({
      ...rest,
      dependencyFiredAt: firedAt,
      updatedAt: firedAt,
    });
  }

  await sendPromptToAgent({
    agentManager: deps.agentManager as AgentManager,
    agentStorage: deps.agentStorage as AgentStorage,
    agentId: schedule.dependentAgentId,
    prompt,
    logger: deps.logger,
  });

  if (schedule.notifyOnFinish && schedule.callerAgentId) {
    setupFinishNotification({
      agentManager: deps.agentManager as AgentManager,
      agentStorage: deps.agentStorage as AgentStorage,
      childAgentId: schedule.dependentAgentId,
      callerAgentId: schedule.callerAgentId,
      requireParentOwnership: true,
      logger: deps.logger,
    });
  }
}

async function failSchedule(
  deps: DependencySchedulerDeps,
  schedule: ActiveSchedule,
  reason: string,
): Promise<void> {
  if (schedule.fired) {
    return;
  }
  schedule.fired = true;
  cleanupSchedule(schedule);
  activeSchedules.delete(schedule.dependentAgentId);

  const at = new Date().toISOString();
  const record = await deps.agentStorage.get(schedule.dependentAgentId);
  if (record && !record.dependencyFiredAt && !record.dependencyFailed) {
    await deps.agentStorage.upsert({
      ...record,
      dependencyFailed: { reason, at },
      updatedAt: at,
    });
  }

  if (schedule.callerAgentId) {
    const body = `Dependent agent ${schedule.dependentAgentId} was not started: ${reason}.`;
    try {
      await sendPromptToAgent({
        agentManager: deps.agentManager as AgentManager,
        agentStorage: deps.agentStorage as AgentStorage,
        agentId: schedule.callerAgentId,
        prompt: formatSystemNotificationPrompt(body),
        unarchive: false,
        logger: deps.logger,
      });
    } catch (error) {
      deps.logger.error(
        {
          err: error,
          callerAgentId: schedule.callerAgentId,
          dependentAgentId: schedule.dependentAgentId,
        },
        "failed to notify caller about dependency failure",
      );
    }
  }
}

export async function buildDependencyContextBlock(
  deps: Pick<DependencySchedulerDeps, "agentManager" | "agentStorage">,
  dependsOn: string[],
): Promise<string> {
  const parts: string[] = [];
  let remaining = TOTAL_DEPENDENCY_OUTPUT_LIMIT;

  for (const depId of dependsOn) {
    if (remaining <= 0) {
      parts.push(
        `<dependency agentId="${escapeXmlAttr(depId)}" title="">\n(产出截断：总长上限)\n</dependency>`,
      );
      continue;
    }

    const title = await resolveAgentTitle(deps, depId);
    let output: string | null = null;
    try {
      output = await deps.agentManager.getLastAssistantMessage(depId);
    } catch {
      output = null;
    }

    let body: string;
    if (output == null || output.trim().length === 0) {
      body = "产出不可读";
    } else {
      const capped = truncateText(output, Math.min(PER_DEPENDENCY_OUTPUT_LIMIT, remaining));
      body = capped;
      remaining -= capped.length;
    }

    parts.push(
      `<dependency agentId="${escapeXmlAttr(depId)}" title="${escapeXmlAttr(title)}">\n${body}\n</dependency>`,
    );
  }

  return `<paseo-dependency-context>\n${parts.join("\n")}\n</paseo-dependency-context>`;
}

async function resolveAgentTitle(
  deps: Pick<DependencySchedulerDeps, "agentManager" | "agentStorage">,
  agentId: string,
): Promise<string> {
  const live = deps.agentManager.getAgent(agentId) as ManagedAgent | undefined;
  if (live?.labels || live) {
    // ManagedAgent title is not on the live object; prefer storage.
  }
  const stored = await deps.agentStorage.get(agentId);
  return stored?.title?.trim() || agentId;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function cleanupSchedule(schedule: ActiveSchedule): void {
  for (const unsub of schedule.unsubscribers) {
    try {
      unsub();
    } catch {
      // ignore
    }
  }
  schedule.unsubscribers = [];
  if (schedule.selfUnsubscriber) {
    try {
      schedule.selfUnsubscriber();
    } catch {
      // ignore
    }
    schedule.selfUnsubscriber = null;
  }
}

export function cancelDependencySchedule(dependentAgentId: string): void {
  const schedule = activeSchedules.get(dependentAgentId);
  if (!schedule) {
    return;
  }
  schedule.fired = true;
  cleanupSchedule(schedule);
  activeSchedules.delete(dependentAgentId);
}

/**
 * Daemon restart rebuild: re-attach schedules for agents that still wait on deps.
 * Exported so bootstrap (or tests) can call after agent storage is loaded.
 */
export async function rebuildDependencySchedules(
  deps: DependencySchedulerDeps,
): Promise<{ restored: number; firedImmediately: number }> {
  const records = await deps.agentStorage.list();
  let restored = 0;
  let firedImmediately = 0;

  for (const record of records) {
    const dependsOn = normalizeDependsOn(record.dependsOn);
    if (dependsOn.length === 0) {
      continue;
    }
    if (record.dependencyFiredAt || record.dependencyFailed || record.archivedAt) {
      continue;
    }

    const initialPrompt = record.dependencyPendingPrompt?.trim() ?? "";
    if (!initialPrompt) {
      deps.logger.warn(
        { agentId: record.id },
        "skipping dependency rebuild: no pending initial prompt",
      );
      continue;
    }

    const scheduleParams: ScheduleDependentAgentParams = {
      ...deps,
      dependentAgentId: record.id,
      dependsOn,
      initialPrompt,
      notifyOnFinish: false,
      treatCompletedDepsAsReady: true,
    };

    let allReady = true;
    for (const depId of dependsOn) {
      const ready = await deps.agentManager.agentHasCompletedTurn(depId);
      if (!ready) {
        allReady = false;
        break;
      }
    }

    scheduleDependentAgent(scheduleParams);
    restored += 1;
    if (allReady) {
      firedImmediately += 1;
    }
  }

  return { restored, firedImmediately };
}
