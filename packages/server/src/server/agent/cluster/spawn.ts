import type { BoundCreateAgentCommand, CreateAgentFromMcpInput } from "../create-agent/create.js";
import type { ClusterDraftPlan, ClusterDraftWorkerSpec } from "./planner.js";
import type { ClusterPreferencesOptions, ClusterWorkerProfile } from "./preferences.js";
import { resolveClusterWorkerProfile } from "./preferences.js";
import type { ClusterPlan, ClusterRole, WorkerSpec } from "./types.js";

export interface SpawnMainAgentContext {
  id: string;
  cwd: string;
  workspaceId?: string;
}

export interface SpawnClusterWorkersOptions {
  plan: ClusterDraftPlan;
  mainAgent: SpawnMainAgentContext;
  /** Bound `createAgentCommand` (kind mcp only). */
  createAgent: BoundCreateAgentCommand;
  /** Passed to default profile resolution when `resolveProfile` is omitted. */
  preferences?: ClusterPreferencesOptions;
  /**
   * Optional inject for tests. Defaults to `resolveClusterWorkerProfile`.
   * Must return null when the role has no usable provider.
   */
  resolveProfile?: (
    role: ClusterRole,
  ) => Promise<ClusterWorkerProfile | null> | ClusterWorkerProfile | null;
}

export interface SpawnClusterWorkersResult {
  /** Plan with every worker's provider filled from resolved profiles. */
  plan: ClusterPlan;
  /** Graph node id → real agent UUID. */
  agentIdByNodeId: Record<string, string>;
  /** Creation order of real agent UUIDs. */
  workerIds: string[];
}

/**
 * Resolve every worker profile, then create agents layer-by-layer via the
 * bound `createAgent` (mcp only). Same-layer workers run with Promise.all.
 *
 * Fails before any create when a role lacks a provider. Mid-spawn failures
 * include already-created real agent ids in the error message.
 */
export async function spawnClusterWorkers(
  options: SpawnClusterWorkersOptions,
): Promise<SpawnClusterWorkersResult> {
  const { plan, mainAgent, createAgent } = options;
  const resolveProfile =
    options.resolveProfile ??
    ((role: ClusterRole) => resolveClusterWorkerProfile(role, options.preferences));

  // Resolve all profiles first — no partial fan-out when config is missing.
  const profileByNodeId = new Map<string, ClusterWorkerProfile>();
  for (const worker of plan.workers) {
    const profile = await resolveProfile(worker.role);
    if (!profile?.provider?.trim()) {
      throw new Error(
        `Cluster spawn failed: no provider configured for role "${worker.role}" (worker "${worker.id}"). ` +
          `Set providers.${worker.role} in orchestration-preferences.json or [roles.${worker.role}] / [worker] in cluster-worker.toml.`,
      );
    }
    profileByNodeId.set(worker.id, profile);
  }

  const assignedPlan: ClusterPlan = {
    id: plan.id,
    goal: plan.goal,
    workers: plan.workers.map((worker) => {
      const profile = profileByNodeId.get(worker.id)!;
      return {
        ...worker,
        provider: profile.provider,
      } satisfies WorkerSpec;
    }),
  };

  const layers = topologicalLayers(plan.workers);
  const agentIdByNodeId: Record<string, string> = {};
  const workerIds: string[] = [];

  try {
    for (const layer of layers) {
      // Record each success immediately so a sibling failure still reports real ids.
      // Settle the whole layer before judging failure: a fast-failing sibling must
      // not hide a slow-success sibling's real UUID from the error message.
      const settled = await Promise.allSettled(
        layer.map(async (worker) => {
          const profile = profileByNodeId.get(worker.id)!;
          const dependsOn = mapDependsOn(worker.dependsOn, agentIdByNodeId);
          const input = buildCreateInput({
            worker,
            profile,
            mainAgent,
            planGoal: plan.goal,
            dependsOn,
          });
          const result = await createAgent(input);
          // Record real UUID first so prompt-start failures still report partial ids.
          const agentId = result.snapshot?.id;
          if (typeof agentId !== "string" || agentId.trim().length === 0) {
            throw new Error(
              `Cluster spawn failed: createAgent for worker "${worker.id}" returned no snapshot.id`,
            );
          }
          agentIdByNodeId[worker.id] = agentId;
          workerIds.push(agentId);

          if (result.initialPromptError != null) {
            const message = formatUnknownError(result.initialPromptError);
            throw new Error(
              `Cluster spawn initialPromptError for worker "${worker.id}": ${message}`,
            );
          }
        }),
      );
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected) {
        throw rejected.reason;
      }
    }
  } catch (error) {
    const created = Object.entries(agentIdByNodeId)
      .map(([nodeId, agentId]) => `${nodeId}=${agentId}`)
      .join(", ");
    const base = formatUnknownError(error);
    if (workerIds.length === 0) {
      throw error instanceof Error ? error : new Error(base);
    }
    throw new Error(
      `Cluster spawn failed after creating ${workerIds.length} worker(s) [${created}]: ${base}`,
      { cause: error },
    );
  }

  return {
    plan: assignedPlan,
    agentIdByNodeId,
    workerIds,
  };
}

function buildCreateInput(params: {
  worker: ClusterDraftWorkerSpec;
  profile: ClusterWorkerProfile;
  mainAgent: SpawnMainAgentContext;
  planGoal: string;
  dependsOn: string[];
}): CreateAgentFromMcpInput {
  const { worker, profile, mainAgent, planGoal, dependsOn } = params;
  // Cluster workers must stay alive (not auto-archived) until the orchestrator
  // finishes the unified review / evidence bounce. Archiving closes the runtime
  // and drops the worker from the Subagents track, so autoArchive is pinned off
  // regardless of worker/profile config. Phase 5 cleanup is out of scope here.
  const autoArchive = false;

  const input: CreateAgentFromMcpInput = {
    kind: "mcp",
    provider: profile.provider,
    title: worker.title,
    initialPrompt: buildWorkerInitialPrompt({
      planGoal,
      worker,
      dependsOnNodeIds: worker.dependsOn ?? [],
      dependsOnAgentIds: dependsOn,
    }),
    cwd: mainAgent.cwd,
    background: true,
    // Cluster workers never page the main agent per worker; the orchestrator
    // reviews all results in one pass after the whole cluster settles.
    notifyOnFinish: false,
    unattended: true,
    autoArchive,
    promptFailure: "return-error",
    callerAgentId: mainAgent.id,
  };

  if (profile.mode) {
    input.mode = profile.mode;
  }
  if (profile.thinking) {
    input.thinking = profile.thinking;
  }
  if (dependsOn.length > 0) {
    input.dependsOn = dependsOn;
  }

  if (worker.isolation === "worktree") {
    input.worktree = { action: "branch-off" };
  } else {
    // shared: reuse main workspace + cwd
    if (mainAgent.workspaceId) {
      input.workspaceId = mainAgent.workspaceId;
    }
  }

  return input;
}

export function buildWorkerInitialPrompt(params: {
  planGoal: string;
  worker: ClusterDraftWorkerSpec;
  dependsOnNodeIds: string[];
  dependsOnAgentIds: string[];
}): string {
  const { planGoal, worker, dependsOnNodeIds, dependsOnAgentIds } = params;
  const allow = worker.scope.allow.length > 0 ? worker.scope.allow.join(", ") : "(none)";
  const deny = worker.scope.deny.length > 0 ? worker.scope.deny.join(", ") : "(none)";
  const criteria =
    worker.successCriteria.length > 0
      ? worker.successCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
      : "  (none listed)";

  let depsSection = "Dependencies: none — you may start immediately.";
  if (dependsOnNodeIds.length > 0) {
    const pairs = dependsOnNodeIds.map((nodeId, i) => {
      const agentId = dependsOnAgentIds[i] ?? "(pending)";
      return `  - graph node "${nodeId}" → agent ${agentId}`;
    });
    depsSection = [
      "Dependencies (wait for these agents to finish a turn before your prompt runs):",
      ...pairs,
      "Use their outputs when available; do not redo their work.",
    ].join("\n");
  }

  return [
    "# Cluster worker assignment",
    "",
    `## Overall goal`,
    planGoal,
    "",
    `## Your task (${worker.id})`,
    `Title: ${worker.title}`,
    `Role: ${worker.role}`,
    `Isolation: ${worker.isolation}`,
    "",
    "### Worker goal",
    worker.goal,
    "",
    "### Scope",
    `Allow: ${allow}`,
    `Deny: ${deny}`,
    "",
    "### Success criteria",
    criteria,
    "",
    depsSection,
    "",
    "## Hard rules",
    "- Do NOT create, spawn, or delegate to other agents (no create_agent / fan-out).",
    "- Do NOT commit, push, deploy, or force-push.",
    "- Do NOT ask the user questions; if blocked, report the blocker with evidence and stop.",
    "- Stay inside Allow paths; never touch Deny paths.",
    "",
    "## Required return",
    "- List files you changed (paths).",
    "- Paste verification evidence (commands run + key output).",
    "- State which success criteria are met or failed.",
  ].join("\n");
}

/** Kahn-style layering: each layer is a set of nodes whose deps are already scheduled. */
export function topologicalLayers(workers: ClusterDraftWorkerSpec[]): ClusterDraftWorkerSpec[][] {
  const byId = new Map(workers.map((w) => [w.id, w]));
  if (byId.size !== workers.length) {
    throw new Error("Cluster spawn failed: duplicate worker ids in plan");
  }

  for (const worker of workers) {
    for (const dep of worker.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error(
          `Cluster spawn failed: worker "${worker.id}" dependsOn unknown node "${dep}"`,
        );
      }
      if (dep === worker.id) {
        throw new Error(`Cluster spawn failed: worker "${worker.id}" depends on itself`);
      }
    }
  }

  const remaining = new Set(workers.map((w) => w.id));
  const layers: ClusterDraftWorkerSpec[][] = [];
  const scheduled = new Set<string>();

  while (remaining.size > 0) {
    const layer: ClusterDraftWorkerSpec[] = [];
    for (const id of remaining) {
      const worker = byId.get(id)!;
      const deps = worker.dependsOn ?? [];
      if (deps.every((d) => scheduled.has(d))) {
        layer.push(worker);
      }
    }
    if (layer.length === 0) {
      throw new Error(`Cluster spawn failed: dependsOn cycle among [${[...remaining].join(", ")}]`);
    }
    layers.push(layer);
    for (const worker of layer) {
      remaining.delete(worker.id);
      scheduled.add(worker.id);
    }
  }

  return layers;
}

function mapDependsOn(
  dependsOn: string[] | undefined,
  agentIdByNodeId: Record<string, string>,
): string[] {
  if (!dependsOn || dependsOn.length === 0) {
    return [];
  }
  return dependsOn.map((nodeId) => {
    const agentId = agentIdByNodeId[nodeId];
    if (!agentId) {
      throw new Error(`Cluster spawn failed: dependency node "${nodeId}" has no agent UUID yet`);
    }
    return agentId;
  });
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
