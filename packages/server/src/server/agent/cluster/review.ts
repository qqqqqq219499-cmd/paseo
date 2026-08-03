import type { ClusterRole } from "./types.js";

/** Evidence requirement band for a cluster role. */
export type EvidenceBand = "write" | "research";

export interface EvidenceVerdict {
  ok: boolean;
  band: EvidenceBand;
  reason?: string;
  /** True when attempt 0 failed and a single bounce is still allowed. */
  bounceOnce: boolean;
}

export interface GateWorkerMeta {
  nodeId: string;
  agentId: string;
  title: string;
  role: ClusterRole;
}

export interface GateOneWorkerOptions {
  worker: GateWorkerMeta;
  /** First-attempt final message (attempt 0). */
  initialMessage: string | null;
  /**
   * Injectable bounce: sends the bounce prompt to the real agent and returns
   * its second-attempt last message. Only called for a failed attempt 0.
   */
  bounce?: (prompt: string) => Promise<string | null>;
}

export interface GateOneWorkerResult {
  verdict: EvidenceVerdict;
  bounced: boolean;
  finalText: string;
  /** Set when the worker was bounced (attempt 1). */
  bouncePrompt?: string;
}

export interface ReviewPacketWorker {
  nodeId: string;
  agentId: string;
  title: string;
  role: ClusterRole;
  terminalStatus: string;
  scopeAllow: string[];
  scopeDeny: string[];
  successCriteria: string[];
  finalText: string;
  verdict: EvidenceVerdict;
  bounced: boolean;
}

export interface ReviewPacket {
  allOk: boolean;
  failedAgentIds: string[];
  workers: ReviewPacketWorker[];
}

export interface BuildMainReviewPromptParams {
  originalUserRequest: string;
  planGoal: string;
  packet: ReviewPacket;
  /** Per-worker final-message cap in chars (default 4000). */
  maxWorkerChars?: number;
}

export interface BuildEvidenceBouncePromptParams {
  nodeId: string;
  agentId: string;
  title: string;
  role: ClusterRole;
  reason: string;
  /** Bounce attempt ordinal, formatted as `${attempt}/2`. */
  attempt: number;
}

const MIN_EVIDENCE_CHARS = 40;
const DEFAULT_MAX_WORKER_CHARS = 4000;
const MAX_BOUNCE_ATTEMPTS = 2;

const BARE_DONE_PATTERN = /^(?:done|completed|finished|ok|完成|已完成|搞定|好了)[.!。！]*$/i;

const WRITE_FILE_SIGNAL =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|cs|c|cpp|h|hpp|css|scss|html|lua|sql|sh|ps1|json|ya?ml|toml|md)\b|file[:：]|files? (?:changed|modified|created|edited|written)|路径|文件/i;

const WRITE_VERIFY_SIGNAL =
  /\b(?:npm|pnpm|yarn|bun|npx|node|python3?|pytest|vitest|jest|tsc|tsgo|eslint|oxlint|oxfmt|prettier|cargo|make|docker|typecheck)\b|go (?:test|build)|git (?:diff|status|log)|验证|测试|通过|命令|结果|evidence|verification|passed|green/i;

const RESEARCH_VERIFIABLE_SIGNAL =
  /行号|符号|函数|方法|接口|定义在|位于|路径|文件|结论|发现|证据|出处|引用|line\s*\d+|lines?\s*\d+|@\w+|function|symbol|conclusion|finding|evidence|reference|defined in|located at/i;

/** impl/ui write code; research/planning/audit produce verifiable findings. */
export function evidenceBandForRole(role: ClusterRole): EvidenceBand {
  return role === "impl" || role === "ui" ? "write" : "research";
}

/**
 * Minimal evidence gate for a worker's final message.
 * attempt 0 failures allow one bounce; attempt 1 never bounces again.
 */
export function evaluateWorkerEvidence(
  role: ClusterRole,
  lastMessage: string | null,
  attempt: 0 | 1,
): EvidenceVerdict {
  const band = evidenceBandForRole(role);
  const canBounce = attempt === 0;
  const text = lastMessage?.trim() ?? "";

  if (text.length === 0) {
    return { ok: false, band, reason: "empty", bounceOnce: canBounce };
  }
  if (BARE_DONE_PATTERN.test(text)) {
    return { ok: false, band, reason: "bare_done", bounceOnce: canBounce };
  }
  if (text.length < MIN_EVIDENCE_CHARS) {
    return { ok: false, band, reason: "too_short", bounceOnce: canBounce };
  }

  if (band === "write") {
    const hasFiles = WRITE_FILE_SIGNAL.test(text);
    const hasVerification = WRITE_VERIFY_SIGNAL.test(text);
    if (!hasFiles && !hasVerification) {
      return { ok: false, band, reason: "no_evidence", bounceOnce: canBounce };
    }
    if (!hasFiles) {
      return { ok: false, band, reason: "missing_file_evidence", bounceOnce: canBounce };
    }
    if (!hasVerification) {
      return { ok: false, band, reason: "missing_verification_evidence", bounceOnce: canBounce };
    }
    return { ok: true, band, bounceOnce: false };
  }

  if (!RESEARCH_VERIFIABLE_SIGNAL.test(text)) {
    return { ok: false, band, reason: "no_verifiable_findings", bounceOnce: canBounce };
  }
  return { ok: true, band, bounceOnce: false };
}

export function buildEvidenceBouncePrompt(params: BuildEvidenceBouncePromptParams): string {
  return [
    "# Cluster review: evidence required",
    "",
    `- Graph node id: ${params.nodeId}`,
    `- Agent id (UUID): ${params.agentId}`,
    `- Title: ${params.title}`,
    `- Role: ${params.role}`,
    `- Attempt: ${params.attempt}/${MAX_BOUNCE_ATTEMPTS}`,
    "",
    "## Why this response was rejected",
    params.reason,
    "",
    "## What to do now",
    "- Do NOT repeat a bare 'Done'. Provide concrete, verifiable evidence.",
    "- Impl/ui workers: list the file paths you changed AND paste verification",
    "  (commands run + key output, e.g. tests/lint/typecheck).",
    "- Research/planning/audit workers: cite paths, symbols, line numbers,",
    "  conclusions, or findings the reviewer can check. No diff required.",
    "- If the work cannot be completed, state the blocker with evidence.",
    "- Never invent files, commands, or results.",
  ].join("\n");
}

/** Gate one worker: evaluate attempt 0, bounce at most once, then terminate. */
export async function gateOneWorker(options: GateOneWorkerOptions): Promise<GateOneWorkerResult> {
  const { worker } = options;
  const first = evaluateWorkerEvidence(worker.role, options.initialMessage, 0);
  if (first.ok || !first.bounceOnce || !options.bounce) {
    return {
      verdict: first,
      bounced: false,
      finalText: options.initialMessage ?? "",
    };
  }

  const bouncePrompt = buildEvidenceBouncePrompt({
    nodeId: worker.nodeId,
    agentId: worker.agentId,
    title: worker.title,
    role: worker.role,
    reason: first.reason ?? "no evidence",
    attempt: MAX_BOUNCE_ATTEMPTS,
  });

  const secondMessage = await options.bounce(bouncePrompt);
  const second = evaluateWorkerEvidence(worker.role, secondMessage, 1);
  return {
    verdict: second,
    bounced: true,
    finalText: secondMessage ?? "",
    bouncePrompt,
  };
}

export function assembleReviewPacket(workers: ReviewPacketWorker[]): ReviewPacket {
  const failedAgentIds = workers.filter((w) => !w.verdict.ok).map((w) => w.agentId);
  return {
    allOk: failedAgentIds.length === 0,
    failedAgentIds,
    workers,
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n… (truncated from ${text.length} chars)`;
}

function renderWorkerSection(worker: ReviewPacketWorker, maxWorkerChars: number): string {
  const criteria =
    worker.successCriteria.length > 0
      ? worker.successCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
      : "  (none listed)";
  return [
    `## Worker ${worker.nodeId} — ${worker.title}`,
    `- Node id: ${worker.nodeId}`,
    `- Agent id (UUID): ${worker.agentId}`,
    `- Title: ${worker.title}`,
    `- Role: ${worker.role}`,
    `- Terminal status: ${worker.terminalStatus}`,
    `- Scope allow: ${worker.scopeAllow.length > 0 ? worker.scopeAllow.join(", ") : "(none)"}`,
    `- Scope deny: ${worker.scopeDeny.length > 0 ? worker.scopeDeny.join(", ") : "(none)"}`,
    "- Success criteria:",
    criteria,
    `- Evidence verdict: ${worker.verdict.ok ? "ok" : "fail"} (${worker.verdict.band}${worker.verdict.reason ? `, reason: ${worker.verdict.reason}` : ""})`,
    `- Bounced: ${worker.bounced ? "yes" : "no"}`,
    "- Final message:",
    truncateText(worker.finalText, maxWorkerChars),
  ].join("\n");
}

export function buildMainReviewPrompt(params: BuildMainReviewPromptParams): string {
  const maxWorkerChars = params.maxWorkerChars ?? DEFAULT_MAX_WORKER_CHARS;
  const sections = params.packet.workers
    .map((w) => renderWorkerSection(w, maxWorkerChars))
    .join("\n\n");
  const failedIds =
    params.packet.failedAgentIds.length > 0 ? params.packet.failedAgentIds.join(", ") : "(none)";
  return [
    "# Cluster review",
    "",
    "## Original user request",
    params.originalUserRequest.trim(),
    "",
    "## Plan goal",
    params.planGoal.trim(),
    "",
    "## Overall verdict",
    `- allOk: ${params.packet.allOk}`,
    `- failedAgentIds: ${failedIds}`,
    "",
    "## Worker results",
    sections,
    "",
    "## Hard rules",
    "- You are the single outward voice for this cluster run; reply only with your review conclusions.",
    "- Do NOT create, spawn, or continue any cluster worker agents (no create_agent / fan-out).",
    "- If any worker verdict is fail, you MUST NOT claim the overall task succeeded.",
    "- Never invent files, commands, test output, or evidence that workers did not report.",
  ].join("\n");
}
