import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getStructuredAgentResponse } from "../agent-response-loop.js";
import type { BoundCreateAgentCommand } from "../create-agent/create.js";
import type { AgentPromptInput, AgentRunResult } from "../agent-sdk-types.js";
import type { ClusterIsolation, ClusterRole, WorkerScope } from "./types.js";

/** Planner output worker — no provider (assigned server-side in Phase 3B). */
export interface ClusterDraftWorkerSpec {
  id: string;
  title: string;
  goal: string;
  role: ClusterRole;
  scope: WorkerScope;
  isolation: ClusterIsolation;
  dependsOn?: string[];
  successCriteria: string[];
  autoArchive?: boolean;
}

/** Planner output plan — providers not present / not trusted. */
export interface ClusterDraftPlan {
  id: string;
  goal: string;
  workers: ClusterDraftWorkerSpec[];
}

const CLUSTER_ROLES = ["impl", "ui", "research", "planning", "audit"] as const;
const CLUSTER_ISOLATIONS = ["shared", "worktree"] as const;

const ClusterDraftWorkerSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  role: z.enum(CLUSTER_ROLES),
  scope: z.object({
    allow: z.array(z.string().min(1)).min(1),
    deny: z.array(z.string()).default([]),
  }),
  isolation: z.enum(CLUSTER_ISOLATIONS),
  dependsOn: z.array(z.string().min(1)).optional(),
  successCriteria: z.array(z.string()).default([]),
  autoArchive: z.boolean().optional(),
});

/**
 * Shape-level schema for structured planner responses.
 * Semantic DAG rules live in {@link validateClusterDraftPlanSemantics}.
 * Provider is intentionally omitted — never accepted from planner JSON.
 */
export const ClusterDraftPlanSchema = z.object({
  id: z.string().min(1).optional(),
  goal: z.string().min(1),
  workers: z.array(ClusterDraftWorkerSpecSchema).min(1).max(6),
});

export class ClusterPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterPlannerError";
  }
}

export class ClusterPlannerValidationError extends ClusterPlannerError {
  readonly validationErrors: string[];

  constructor(message: string, validationErrors: string[]) {
    super(message);
    this.name = "ClusterPlannerValidationError";
    this.validationErrors = validationErrors;
  }
}

export interface ClusterPlannerAgentManager {
  runAgent: (agentId: string, prompt: AgentPromptInput) => Promise<AgentRunResult>;
  closeAgent: (agentId: string) => Promise<void>;
  deleteAgentState: (agentId: string) => Promise<void>;
}

export interface RunClusterPlannerOptions {
  /** User prompt already past chat-first / skip gates. */
  prompt: string;
  /** Provider/model string for the hidden planner agent. */
  plannerProvider: string;
  /** Optional mode id forwarded to createAgent (e.g. full-access). */
  plannerMode?: string;
  /** Optional thinking option id forwarded to createAgent. */
  plannerThinking?: string;
  mainAgent: {
    cwd: string;
    workspaceId?: string;
  };
  createAgent: BoundCreateAgentCommand;
  agentManager: ClusterPlannerAgentManager;
  /** Optional override for unit tests. */
  getStructuredResponse?: typeof getStructuredAgentResponse;
}

/** Roles that write code and must not share allow scopes while concurrent. */
function isWritableClusterRole(role: ClusterRole): boolean {
  return role === "impl" || role === "ui";
}

/**
 * Normalize a scope.allow entry for overlap checks:
 * - unify `\` → `/`
 * - collapse repeated `/`
 * - strip trailing glob tokens (`**`, `*`) and trailing `/`
 */
export function normalizeScopeAllowPath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  // Strip trailing glob / slash pieces repeatedly.
  for (;;) {
    const next = path
      .replace(/\/\*\*$/u, "")
      .replace(/\/\*$/u, "")
      .replace(/\*\*$/u, "")
      .replace(/\*$/u, "")
      .replace(/\/$/u, "");
    if (next === path) {
      break;
    }
    path = next;
  }
  return path;
}

/** Same path, or one is an ancestor directory of the other. */
export function scopeAllowPathsOverlap(left: string, right: string): boolean {
  const a = normalizeScopeAllowPath(left);
  const b = normalizeScopeAllowPath(right);
  if (a.length === 0 || b.length === 0) {
    // Empty after glob strip (e.g. "**") = whole tree — overlaps everything.
    return true;
  }
  if (a === b) {
    return true;
  }
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Transitive closure of dependsOn edges: node → all ancestors it depends on. */
function buildTransitiveDependsOn(workers: ClusterDraftWorkerSpec[]): Map<string, Set<string>> {
  const direct = new Map<string, string[]>();
  for (const worker of workers) {
    direct.set(worker.id, [...(worker.dependsOn ?? [])]);
  }

  const closure = new Map<string, Set<string>>();
  const visit = (nodeId: string, stack: Set<string>): Set<string> => {
    const cached = closure.get(nodeId);
    if (cached) {
      return cached;
    }
    const reached = new Set<string>();
    if (stack.has(nodeId)) {
      // Cycle: stop expanding this branch; cycle error is reported separately.
      return reached;
    }
    stack.add(nodeId);
    for (const dep of direct.get(nodeId) ?? []) {
      reached.add(dep);
      for (const transitive of visit(dep, stack)) {
        reached.add(transitive);
      }
    }
    stack.delete(nodeId);
    closure.set(nodeId, reached);
    return reached;
  };

  for (const worker of workers) {
    visit(worker.id, new Set());
  }
  return closure;
}

function areSerialByDependsOn(
  leftId: string,
  rightId: string,
  transitive: Map<string, Set<string>>,
): boolean {
  return (
    (transitive.get(leftId)?.has(rightId) ?? false) ||
    (transitive.get(rightId)?.has(leftId) ?? false)
  );
}

/**
 * Overlap messages for one concurrent writable pair.
 * Serial pairs (transitive dependsOn either way) may share scopes and are skipped.
 */
function collectConcurrentPairOverlapMessages(
  left: ClusterDraftWorkerSpec,
  right: ClusterDraftWorkerSpec,
  transitive: Map<string, Set<string>>,
): string[] {
  if (areSerialByDependsOn(left.id, right.id, transitive)) {
    return [];
  }
  const messages: string[] = [];
  for (const leftPath of left.scope.allow) {
    for (const rightPath of right.scope.allow) {
      if (scopeAllowPathsOverlap(leftPath, rightPath)) {
        messages.push(
          `workers.${left.id} & workers.${right.id}: concurrent ${left.role}/${right.role} scope.allow overlap ` +
            `("${leftPath}" vs "${rightPath}") — serialise with dependsOn or split scopes`,
        );
      }
    }
  }
  return messages;
}

/**
 * Concurrent impl/ui workers must not share the same or nested scope.allow paths.
 * Serial pairs (transitive dependsOn either way) may share scopes.
 */
function collectConcurrentWritableScopeOverlapErrors(plan: ClusterDraftPlan): string[] {
  const errors: string[] = [];
  const workers = plan.workers;
  const transitive = buildTransitiveDependsOn(workers);

  for (let i = 0; i < workers.length; i += 1) {
    const left = workers[i];
    if (!left || !isWritableClusterRole(left.role)) {
      continue;
    }
    for (let j = i + 1; j < workers.length; j += 1) {
      const right = workers[j];
      if (!right || !isWritableClusterRole(right.role)) {
        continue;
      }
      errors.push(...collectConcurrentPairOverlapMessages(left, right, transitive));
    }
  }

  return errors;
}

function normalizeDraftPlan(raw: z.infer<typeof ClusterDraftPlanSchema>): ClusterDraftPlan {
  return {
    id: raw.id?.trim() || randomUUID(),
    goal: raw.goal.trim(),
    workers: raw.workers.map((worker) => ({
      id: worker.id.trim(),
      title: worker.title.trim(),
      goal: worker.goal.trim(),
      role: worker.role,
      scope: {
        allow: worker.scope.allow.map((entry) => entry.trim()).filter(Boolean),
        deny: (worker.scope.deny ?? []).map((entry) => entry.trim()).filter(Boolean),
      },
      isolation: worker.isolation,
      ...(worker.dependsOn && worker.dependsOn.length > 0
        ? { dependsOn: worker.dependsOn.map((entry) => entry.trim()).filter(Boolean) }
        : {}),
      successCriteria: worker.successCriteria ?? [],
      ...(worker.autoArchive === undefined ? {} : { autoArchive: worker.autoArchive }),
    })),
  };
}

/**
 * Explicit semantic checks beyond Zod shape: unique ids, non-empty allow,
 * dependsOn references, no self-deps, no duplicate edges, no cycles,
 * concurrent impl/ui scope.allow overlap.
 */
export function validateClusterDraftPlanSemantics(plan: ClusterDraftPlan): string[] {
  const errors: string[] = [];
  const workers = plan.workers;

  if (workers.length < 1 || workers.length > 6) {
    errors.push(`workers: must contain 1..6 entries (got ${workers.length})`);
  }

  const seenIds = new Set<string>();
  for (const worker of workers) {
    if (!worker.id) {
      errors.push("workers: id must be non-empty");
      continue;
    }
    if (seenIds.has(worker.id)) {
      errors.push(`workers: duplicate id "${worker.id}"`);
    }
    seenIds.add(worker.id);

    if (!worker.scope.allow || worker.scope.allow.length === 0) {
      errors.push(`workers.${worker.id}: scope.allow must be non-empty`);
    }
  }

  const idSet = new Set(workers.map((worker) => worker.id));
  for (const worker of workers) {
    const dependsOn = worker.dependsOn ?? [];
    const edgeSeen = new Set<string>();
    for (const dep of dependsOn) {
      if (dep === worker.id) {
        errors.push(`workers.${worker.id}: dependsOn cannot include self`);
        continue;
      }
      if (!idSet.has(dep)) {
        errors.push(`workers.${worker.id}: dependsOn references unknown id "${dep}"`);
        continue;
      }
      if (edgeSeen.has(dep)) {
        errors.push(`workers.${worker.id}: duplicate dependsOn edge "${dep}"`);
        continue;
      }
      edgeSeen.add(dep);
    }
  }

  // Cycle detection (DFS).
  const adjacency = new Map<string, string[]>();
  for (const worker of workers) {
    adjacency.set(worker.id, [...(worker.dependsOn ?? [])]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      const cyclePath =
        cycleStart >= 0 ? [...stack.slice(cycleStart), nodeId].join(" -> ") : nodeId;
      errors.push(`dependsOn: cycle detected (${cyclePath})`);
      return true;
    }
    if (visited.has(nodeId)) {
      return false;
    }
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const dep of adjacency.get(nodeId) ?? []) {
      if (visit(dep)) {
        return true;
      }
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  for (const worker of workers) {
    if (visit(worker.id)) {
      break;
    }
  }

  // Only enforce writable-scope exclusivity when the DAG has no cycle report yet
  // (cycle graphs already fail; overlap still checked for acyclic concurrent pairs).
  errors.push(...collectConcurrentWritableScopeOverlapErrors(plan));

  return errors;
}

/** Parse + normalize + semantic validate planner JSON. */
export function validateClusterDraftPlan(value: unknown): ClusterDraftPlan {
  const parsed = ClusterDraftPlanSchema.safeParse(value);
  if (!parsed.success) {
    const validationErrors = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new ClusterPlannerValidationError(
      "Cluster plan failed schema validation",
      validationErrors,
    );
  }

  // Drop any untrusted provider keys that may have been present on input objects.
  const plan = normalizeDraftPlan(parsed.data);
  const semanticErrors = validateClusterDraftPlanSemantics(plan);
  if (semanticErrors.length > 0) {
    throw new ClusterPlannerValidationError(
      "Cluster plan failed semantic validation",
      semanticErrors,
    );
  }
  return plan;
}

/**
 * Zod schema that also enforces semantic DAG rules so
 * {@link getStructuredAgentResponse} retries on invalid graphs.
 */
export const ClusterPlanStructuredSchema = ClusterDraftPlanSchema.superRefine((raw, ctx) => {
  const plan = normalizeDraftPlan(raw);
  for (const error of validateClusterDraftPlanSemantics(plan)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error,
    });
  }
});

export function buildClusterPlannerPrompt(userPrompt: string): string {
  return [
    "You are the hidden cluster planner for Paseo.",
    "Chat-first skip/greeting handling already happened outside this step.",
    "Your only job is to produce a task graph for parallel workers.",
    "",
    "Output rules:",
    "- Respond with JSON only. No markdown fences, no prose before or after.",
    "- Do not include provider/model fields. The server assigns providers later.",
    "- Prefer 2–3 workers by default. Hard maximum is 6.",
    "- Use 1 worker only when the task truly cannot be parallelized.",
    "- Each worker must have a non-empty scope.allow path/glob list.",
    "- dependsOn is the only serial/parallel control (graph node ids only).",
    "- Do not invent parallel-mode enums.",
    "- Default isolation: impl and ui → worktree; research and audit → shared;",
    "  planning → shared unless it will edit code (then worktree).",
    "- Never assign the same writable scope to workers that can run in parallel",
    "  (workers without a dependsOn edge between them).",
    "- Keep worker goals narrowly scoped with clear successCriteria.",
    "",
    "User task:",
    userPrompt.trim(),
  ].join("\n");
}

function resolveRunFinalText(result: AgentRunResult): string {
  if (result.finalText.trim()) {
    return result.finalText;
  }
  for (let index = result.timeline.length - 1; index >= 0; index -= 1) {
    const item = result.timeline[index];
    if (item?.type === "assistant_message" && item.text.trim()) {
      return item.text;
    }
  }
  return "";
}

async function cleanupPlannerAgent(
  agentManager: ClusterPlannerAgentManager,
  agentId: string,
): Promise<void> {
  let closeError: unknown = null;
  try {
    await agentManager.closeAgent(agentId);
  } catch (error) {
    closeError = error;
  }
  try {
    await agentManager.deleteAgentState(agentId);
  } catch (deleteError) {
    if (closeError != null) {
      throw closeError;
    }
    throw deleteError;
  }
  if (closeError != null) {
    throw closeError;
  }
}

/**
 * Run the hidden internal planner agent and return a validated draft plan.
 * Always closes + deletes the planner agent; cleanup errors never mask planner failures.
 */
export async function runClusterPlanner(
  options: RunClusterPlannerOptions,
): Promise<ClusterDraftPlan> {
  const structured = options.getStructuredResponse ?? getStructuredAgentResponse;
  const plannerPrompt = buildClusterPlannerPrompt(options.prompt);

  const created = await options.createAgent({
    kind: "mcp",
    provider: options.plannerProvider,
    title: "cluster-planner",
    cwd: options.mainAgent.cwd,
    workspaceId: options.mainAgent.workspaceId,
    ...(options.plannerMode !== undefined ? { mode: options.plannerMode } : {}),
    ...(options.plannerThinking !== undefined ? { thinking: options.plannerThinking } : {}),
    unattended: true,
    promptFailure: "return-error",
    background: true,
    notifyOnFinish: false,
    internal: true,
    // No initialPrompt: structured loop owns all prompts.
    // No callerAgentId: planner must not join Subagents track.
  });

  const agentId = created.snapshot.id;
  let plannerError: unknown = null;
  let plan: ClusterDraftPlan | null = null;

  try {
    const raw = await structured({
      caller: async (nextPrompt) => {
        const run = await options.agentManager.runAgent(agentId, nextPrompt);
        if (run.canceled) {
          throw new ClusterPlannerError(`Cluster planner ${agentId} was canceled`);
        }
        const text = resolveRunFinalText(run);
        if (!text.trim()) {
          throw new ClusterPlannerError(`Cluster planner ${agentId} returned empty finalText`);
        }
        return text;
      },
      prompt: plannerPrompt,
      schema: ClusterPlanStructuredSchema,
      maxRetries: 1,
      schemaName: "ClusterPlan",
    });

    plan = validateClusterDraftPlan(raw);
  } catch (error) {
    plannerError = error;
  }

  try {
    await cleanupPlannerAgent(options.agentManager, agentId);
  } catch (cleanupError) {
    if (plannerError == null) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new ClusterPlannerError(String(cleanupError));
    }
    // Preserve the original planner failure; ignore cleanup noise.
  }

  if (plannerError != null) {
    throw plannerError;
  }
  if (!plan) {
    throw new ClusterPlannerError("Cluster planner produced no plan");
  }
  return plan;
}
