import { formatSystemNotificationPrompt } from "../agent-prompt.js";
import {
  assembleReviewPacket,
  buildMainReviewPrompt,
  evidenceBandForRole,
  gateOneWorker,
  type ReviewPacket,
  type ReviewPacketWorker,
} from "./review.js";
import type { SpawnClusterWorkersResult } from "./spawn.js";
import type { WorkerSpec } from "./types.js";
import type { ClusterWorkerOutcome } from "./wait-workers.js";

/**
 * Injectable runtime port for the cluster fan-in + review pass. Session binds
 * the real AgentManager wait/send primitives; tests substitute a fake.
 */
export interface ClusterReviewPort {
  waitForClusterWorkers(workerIds: string[]): Promise<ClusterWorkerOutcome[]>;
  waitForClusterAgentTurn(agentId: string): Promise<ClusterWorkerOutcome>;
  sendPrompt(agentId: string, prompt: string): Promise<void>;
}

export interface RunClusterReviewOptions {
  /** Full spawn result — plan (scope/criteria) + real UUID mapping. */
  spawnResult: SpawnClusterWorkersResult;
  /** The raw user request the whole cluster run answers. */
  originalUserRequest: string;
  mainAgentId: string;
  port: ClusterReviewPort;
}

export type ClusterReviewFinal =
  | { phase: "done"; workerIds: string[] }
  | { phase: "failed"; error: string };

export interface ClusterReviewResult {
  final: ClusterReviewFinal;
  packet: ReviewPacket;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hard-fail worker entry: no evidence gate, no bounce, verdict always fail. */
function failWorker(
  worker: WorkerSpec,
  agentId: string,
  terminalStatus: string,
  reason: string,
  finalText: string,
): ReviewPacketWorker {
  return {
    nodeId: worker.id,
    agentId,
    title: worker.title,
    role: worker.role,
    terminalStatus,
    scopeAllow: worker.scope.allow,
    scopeDeny: worker.scope.deny,
    successCriteria: worker.successCriteria,
    finalText,
    verdict: { ok: false, band: evidenceBandForRole(worker.role), reason, bounceOnce: false },
    bounced: false,
  };
}

/**
 * Gate one completed worker's evidence with at most one bounce. Any bounce
 * send/wait error or non-completed bounce outcome converges to verdict fail —
 * it must never throw out of the whole fan-in.
 */
async function gateCompletedWorker(
  worker: WorkerSpec,
  agentId: string,
  lastMessage: string | null,
  port: ClusterReviewPort,
): Promise<ReviewPacketWorker> {
  let bounceFailure: string | null = null;

  const result = await gateOneWorker({
    worker: { nodeId: worker.id, agentId, title: worker.title, role: worker.role },
    initialMessage: lastMessage,
    bounce: async (prompt) => {
      try {
        await port.sendPrompt(agentId, formatSystemNotificationPrompt(prompt));
      } catch (error) {
        bounceFailure = `send failed: ${formatError(error)}`;
        return null;
      }
      let after: ClusterWorkerOutcome;
      try {
        after = await port.waitForClusterAgentTurn(agentId);
      } catch (error) {
        bounceFailure = `wait failed: ${formatError(error)}`;
        return null;
      }
      if (after.status !== "completed") {
        bounceFailure = `${after.status}${after.error ? `: ${after.error}` : ""}`;
        return null;
      }
      return after.lastMessage;
    },
  });

  let verdict = result.verdict;
  if (bounceFailure !== null) {
    verdict = {
      ok: false,
      band: verdict.band,
      reason: `bounce_failed: ${bounceFailure}`,
      bounceOnce: false,
    };
  }

  return {
    nodeId: worker.id,
    agentId,
    title: worker.title,
    role: worker.role,
    terminalStatus: "completed",
    scopeAllow: worker.scope.allow,
    scopeDeny: worker.scope.deny,
    successCriteria: worker.successCriteria,
    finalText: result.finalText,
    verdict,
    bounced: result.bounced,
  };
}

/**
 * Fan-in → evidence gate → single main review.
 *
 * 1. Wait for every worker's first turn (all outcomes, input order).
 * 2. Non-completed outcomes are hard fails — a stale/leftover lastMessage can
 *    never turn them ok, and they are never bounced.
 * 3. Completed workers pass `gateOneWorker` (at most one bounce each).
 * 4. Assemble the review packet and wake the main agent exactly once.
 * 5. Main turn completed + packet.allOk → done; anything else → failed with
 *    an explicit, visible error.
 */
export async function runClusterReview(
  options: RunClusterReviewOptions,
): Promise<ClusterReviewResult> {
  const { spawnResult, mainAgentId, port } = options;
  const { plan } = spawnResult;

  const outcomes = await port.waitForClusterWorkers(spawnResult.workerIds);
  const outcomeByAgentId = new Map(outcomes.map((outcome) => [outcome.agentId, outcome]));

  const workers: ReviewPacketWorker[] = await Promise.all(
    plan.workers.map(async (worker) => {
      const agentId = spawnResult.agentIdByNodeId[worker.id];
      if (!agentId) {
        return failWorker(
          worker,
          "(missing)",
          "missing",
          `no UUID mapped for node "${worker.id}"`,
          "",
        );
      }
      const outcome = outcomeByAgentId.get(agentId);
      if (!outcome) {
        return failWorker(worker, agentId, "missing", `no outcome reported for ${agentId}`, "");
      }
      if (outcome.status !== "completed") {
        return failWorker(
          worker,
          agentId,
          outcome.status,
          outcome.error ?? `worker ${outcome.status}`,
          outcome.lastMessage ?? "",
        );
      }
      return await gateCompletedWorker(worker, agentId, outcome.lastMessage, port);
    }),
  );

  const packet = assembleReviewPacket(workers);

  const reviewPrompt = buildMainReviewPrompt({
    originalUserRequest: options.originalUserRequest,
    planGoal: plan.goal,
    packet,
  });

  try {
    await port.sendPrompt(mainAgentId, formatSystemNotificationPrompt(reviewPrompt));
  } catch (error) {
    return {
      final: {
        phase: "failed",
        error: `Cluster review failed: sending review to main agent failed: ${formatError(error)}`,
      },
      packet,
    };
  }

  let mainOutcome: ClusterWorkerOutcome;
  try {
    mainOutcome = await port.waitForClusterAgentTurn(mainAgentId);
  } catch (error) {
    return {
      final: {
        phase: "failed",
        error: `Cluster review failed: waiting for main agent turn failed: ${formatError(error)}`,
      },
      packet,
    };
  }

  if (mainOutcome.status !== "completed") {
    return {
      final: {
        phase: "failed",
        error: `Cluster review failed: main agent ${mainOutcome.status}${
          mainOutcome.error ? `: ${mainOutcome.error}` : ""
        }`,
      },
      packet,
    };
  }

  if (!packet.allOk) {
    return {
      final: {
        phase: "failed",
        error: `Cluster run failed: ${packet.failedAgentIds.join(", ")} did not pass evidence review`,
      },
      packet,
    };
  }

  return { final: { phase: "done", workerIds: [...spawnResult.workerIds] }, packet };
}
