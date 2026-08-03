import type { ClusterDraftPlan } from "./planner.js";
import type { SpawnClusterWorkersResult } from "./spawn.js";
import type { ClusterRunState } from "./types.js";

/**
 * Cluster run state machine (see MVP spec):
 * `cluster_idle → planning → spawning → running → reviewing → done|failed|skipped_single`
 *
 * Phase 3 hard path: tools gate → skip → planning → spawning → running.
 */

/** Minimum prompt length (trimmed) worth fanning out workers for. */
export const MIN_CLUSTERABLE_PROMPT_LENGTH = 8;

const GREETING_PATTERN =
  /^(hi+|hello+|hey+|yo+|你好+|您好+|早上好+|中午好+|下午好+|晚上好+|在吗|在么)\s*[!.,~。！？\s]*$/i;

/** Actionable error when cluster mode is ON but Paseo tools are disabled (AC1). */
export const CLUSTER_TOOLS_DISABLED_ERROR =
  "Cluster mode requires Paseo tools. Open Settings → Host → Agents and enable Enable Paseo tools.";

export const CLUSTER_RUNTIME_NOT_CONFIGURED_ERROR = "Cluster plan/spawn runtime is not configured.";

export interface SkipClusterDecision {
  skip: boolean;
  reason?: string;
}

/** Observer for phase transitions (planning, failed, …). Injectable for tests/logging. */
export type ClusterRunObserver = (state: ClusterRunState) => void;

export type ClusterPlanTask = (prompt: string) => Promise<ClusterDraftPlan>;
export type ClusterSpawnTask = (plan: ClusterDraftPlan) => Promise<SpawnClusterWorkersResult>;

export interface StartClusterRunOptions {
  prompt: string;
  /** From `daemonConfigStore.get().mcp.injectIntoAgents !== false`. */
  paseoToolsEnabled: boolean;
  /** Hidden planner port. Required only after tools/skip gates pass. */
  planTask?: ClusterPlanTask;
  /** Real Paseo worker spawn port. Required only after tools/skip gates pass. */
  spawnTask?: ClusterSpawnTask;
  /** Receives each reported phase (e.g. planning then failed). */
  observer?: ClusterRunObserver;
}

/**
 * Heuristic gate: prompts that are empty, too short, or greetings only should
 * be handled by the main agent directly instead of spawning a cluster.
 */
export function shouldSkipCluster(prompt: string): SkipClusterDecision {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return { skip: true, reason: "empty prompt" };
  }
  if (trimmed.length < MIN_CLUSTERABLE_PROMPT_LENGTH) {
    return { skip: true, reason: `prompt too short (${trimmed.length} chars)` };
  }
  if (GREETING_PATTERN.test(trimmed)) {
    return { skip: true, reason: "greeting only" };
  }
  return { skip: false };
}

/** Initial run state before any planning happens. */
export function createEmptyClusterRun(): ClusterRunState {
  return { phase: "idle" };
}

function report(observer: ClusterRunObserver | undefined, state: ClusterRunState): void {
  observer?.(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stageError(stage: "planning" | "spawn", error: unknown): string {
  const message = errorMessage(error);
  const prefix = stage === "planning" ? "Cluster planning failed" : "Cluster spawn failed";
  return message.startsWith(prefix) ? message : `${prefix}: ${message}`;
}

/**
 * Entry point for the cluster hard path (Phase 3).
 *
 * Order (locked): tools gate → skip → planning → spawning → running.
 * Never silently degrades to single-agent success for long tasks.
 */
export async function startClusterRun(options: StartClusterRunOptions): Promise<ClusterRunState> {
  // Gate before skip: tools off is a hard failure (AC1), never planning.
  if (!options.paseoToolsEnabled) {
    const failed: ClusterRunState = {
      phase: "failed",
      error: CLUSTER_TOOLS_DISABLED_ERROR,
    };
    report(options.observer, failed);
    return failed;
  }

  // Skip before Plan: chat-first (AC3 / AgentCore).
  const decision = shouldSkipCluster(options.prompt);
  if (decision.skip) {
    const skipped: ClusterRunState = {
      phase: "skipped_single",
      reason: decision.reason ?? "skipped",
    };
    report(options.observer, skipped);
    return skipped;
  }

  // Enter planning so observers/logs can see the hard path fired.
  const planning: ClusterRunState = { phase: "planning" };
  report(options.observer, planning);

  if (!options.planTask || !options.spawnTask) {
    const failed: ClusterRunState = {
      phase: "failed",
      error: CLUSTER_RUNTIME_NOT_CONFIGURED_ERROR,
    };
    report(options.observer, failed);
    return failed;
  }

  let plan: ClusterDraftPlan;
  try {
    plan = await options.planTask(options.prompt);
  } catch (error) {
    const failed: ClusterRunState = {
      phase: "failed",
      error: stageError("planning", error),
    };
    report(options.observer, failed);
    return failed;
  }

  const spawning: ClusterRunState = { phase: "spawning" };
  report(options.observer, spawning);

  try {
    const result = await options.spawnTask(plan);
    const running: ClusterRunState = {
      phase: "running",
      workerIds: [...result.workerIds],
    };
    report(options.observer, running);
    return running;
  } catch (error) {
    const failed: ClusterRunState = {
      phase: "failed",
      error: stageError("spawn", error),
    };
    report(options.observer, failed);
    return failed;
  }
}
