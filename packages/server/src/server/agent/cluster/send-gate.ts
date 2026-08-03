import {
  startClusterRun,
  type ClusterPlanTask,
  type ClusterRunObserver,
  type ClusterSpawnTask,
  type StartClusterRunOptions,
} from "./orchestrator.js";
import type { ClusterRunState } from "./types.js";

/**
 * Session-facing decision for `send_agent_message_request` under cluster mode.
 *
 * OFF → continue single (orchestrator never called).
 * ON + skip → notice + continue single.
 * ON + failed → throw (Session maps to accepted=false).
 * Phase 3 may add a fully-handled branch without continuing single.
 */
export type ClusterSendGateDecision =
  | { action: "continue_single" }
  | { action: "continue_single_with_notice"; notice: string; reason: string }
  | { action: "handled"; state: ClusterRunState };

export class ClusterSendGateError extends Error {
  readonly code = "cluster_send_gate_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "ClusterSendGateError";
  }
}

export function buildClusterSkipNotice(reason: string): string {
  return `Cluster mode skipped this message (${reason}); continuing as a single agent.`;
}

export type ClusterRunFn = (options: StartClusterRunOptions) => Promise<ClusterRunState>;

export interface ResolveClusterSendGateOptions {
  clusterModeEnabled: boolean;
  prompt: string;
  paseoToolsEnabled: boolean;
  /** Injectable for unit tests; defaults to `startClusterRun`. */
  runCluster?: ClusterRunFn;
  planTask?: ClusterPlanTask;
  spawnTask?: ClusterSpawnTask;
  observer?: ClusterRunObserver;
}

/**
 * Pure send-path router used by Session before `sendPromptToAgent`.
 *
 * - Cluster OFF: bypass orchestrator entirely.
 * - Cluster ON: run orchestrator; skip → continue with notice; failed → throw.
 */
export async function resolveClusterSendGate(
  options: ResolveClusterSendGateOptions,
): Promise<ClusterSendGateDecision> {
  if (!options.clusterModeEnabled) {
    return { action: "continue_single" };
  }

  const runCluster = options.runCluster ?? startClusterRun;
  const result = await runCluster({
    prompt: options.prompt,
    paseoToolsEnabled: options.paseoToolsEnabled,
    planTask: options.planTask,
    spawnTask: options.spawnTask,
    observer: options.observer,
  });

  if (result.phase === "skipped_single") {
    return {
      action: "continue_single_with_notice",
      notice: buildClusterSkipNotice(result.reason),
      reason: result.reason,
    };
  }

  if (result.phase === "failed") {
    throw new ClusterSendGateError(result.error);
  }

  // Once real workers exist, cluster owns the send. Phase 4 advances running
  // through reviewing/done without falling through to the main provider turn.
  if (result.phase === "running" || result.phase === "reviewing" || result.phase === "done") {
    return { action: "handled", state: result };
  }

  throw new ClusterSendGateError(`Cluster run stopped in unexpected phase "${result.phase}".`);
}
