import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Fallback CEO instruction block shipped with the repo, so cluster mode works
 * on any host even without a local cluster skill file. Kept short and generic
 * about worker models on purpose: the machine-specific model policy lives in
 * the host's local cluster skill (see {@link readCeoInstructions}) and is
 * enforced server-side by the create-agent worker guardrail. The block tells
 * the lead agent to answer in the user's own language.
 */
export const CEO_INSTRUCTIONS_FALLBACK = `You are operating in Cluster Mode as the lead agent (the "CEO") for this session.

Your role:
- You are the single voice the user hears. You understand the request, plan the work, delegate it, verify the results, and report back in your own words.
- Chat-first. Answer small or single-step asks directly yourself. Do not assemble a team for trivia, greetings, or a quick question. Delegate only when the work has real scale or structure — several independent subtasks, or a broad investigation across many sources.
- When you do delegate: first make your plan visible in the chat (break the work into tasks with non-overlapping boundaries), then spawn workers with the Paseo \`create_agent\` tool. Workers show up in the sidebar automatically.
- Delegate the hands-on work to worker agents rather than doing it yourself. Use cheaper, faster worker models than your own tier for that work; keep planning, boundary-setting, and final verification for yourself. Your host's worker configuration decides which worker models are allowed — do not spawn workers on your own model tier.
- After workers return, verify their work against real evidence — files, diffs, tests — never just their self-report, then summarize what actually happened.
- Keep control: resolve conflicts, decide boundaries, and do the final acceptance yourself.
- Speak to the user in the user's own language.

Do not turn this into a silent background process. Plan out loud, delegate visibly, and report honestly — including what you could not verify.`;

/**
 * Host-local cluster skill. When present it wins over the repo fallback, so a
 * machine can pin its own delegation rules (worker models, permissions, house
 * style). Read once and cached; editing the skill requires a daemon reload.
 */
const LOCAL_CLUSTER_SKILL_PATH = path.join(
  os.homedir(),
  ".ai-shared",
  "skills",
  "cluster",
  "SKILL.md",
);

/**
 * Env flag to keep the legacy hidden-planner hard path (auto plan + auto spawn
 * + background review) instead of the default CEO lead mode. Off unless set to
 * "1" — kept for rollback and for the hard-path regression tests.
 */
export function isClusterLegacyHardPathEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PASEO_CLUSTER_LEGACY_HARDPATH === "1";
}

let cachedInstructions: string | null = null;

/**
 * Resolve the CEO instruction block for cluster mode.
 *
 * Prefers the host's local cluster skill so machine-specific delegation rules
 * win; falls back to {@link CEO_INSTRUCTIONS_FALLBACK} when the file is missing,
 * unreadable, or empty. Cached in-process — editing the skill takes effect on
 * the next daemon reload, not mid-session.
 */
export async function readCeoInstructions(): Promise<string> {
  if (cachedInstructions !== null) {
    return cachedInstructions;
  }
  try {
    const local = await readFile(LOCAL_CLUSTER_SKILL_PATH, "utf8");
    const trimmed = local.trim();
    if (trimmed.length > 0) {
      cachedInstructions = trimmed;
      return cachedInstructions;
    }
  } catch {
    // No local skill (or unreadable) — use the shipped fallback.
  }
  cachedInstructions = CEO_INSTRUCTIONS_FALLBACK;
  return cachedInstructions;
}

/** Reset the in-process cache. Test-only. */
export function resetCeoInstructionsCacheForTests(): void {
  cachedInstructions = null;
}
