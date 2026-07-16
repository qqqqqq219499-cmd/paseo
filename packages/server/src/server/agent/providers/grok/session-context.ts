import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveGrokHome } from "../../../../services/grok/grok-auth-file.js";
import type { AgentUsage } from "../../agent-sdk-types.js";

/** Default Grok Build context window (matches CLI chrome + signals.contextWindowTokens). */
export const GROK_DEFAULT_CONTEXT_WINDOW_TOKENS = 500_000;

/**
 * Locate `$GROK_HOME/sessions/<cwd-key>/<sessionId>/` by walking cwd keys.
 * Layout matches Grok CLI on-disk sessions (same helper used by the old fork path).
 */
export function findGrokSessionDir(grokHome: string, sessionId: string): string | null {
  const sessionsRoot = join(grokHome, "sessions");
  if (!existsSync(sessionsRoot)) {
    return null;
  }

  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(sessionsRoot, entry.name, sessionId);
    if (
      existsSync(join(candidate, "summary.json")) ||
      existsSync(join(candidate, "signals.json"))
    ) {
      return candidate;
    }
  }
  return null;
}

export interface GrokSignalsContext {
  contextTokensUsed: number;
  contextWindowTokens: number;
}

/**
 * Read live context occupancy from Grok's `signals.json`.
 * CLI footer "28K / 500K" is this same pair.
 */
export function readGrokSignalsContext(sessionDir: string): GrokSignalsContext | null {
  const signalsPath = join(sessionDir, "signals.json");
  if (!existsSync(signalsPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(signalsPath, "utf8")) as Record<string, unknown>;
    const used = raw.contextTokensUsed;
    const max = raw.contextWindowTokens;
    if (
      typeof used !== "number" ||
      !Number.isFinite(used) ||
      used < 0 ||
      typeof max !== "number" ||
      !Number.isFinite(max) ||
      max <= 0
    ) {
      return null;
    }
    return { contextTokensUsed: used, contextWindowTokens: max };
  } catch {
    return null;
  }
}

/**
 * Resolve Grok context usage for a session id, using `$GROK_HOME` resolution.
 * Returns AgentUsage fields for the composer context ring.
 */
export function resolveGrokContextUsageFromDisk(input: {
  sessionId: string | null | undefined;
  grokHome?: string;
  env?: NodeJS.ProcessEnv;
  homedirFn?: () => string;
}): AgentUsage | undefined {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }

  const grokHome =
    input.grokHome ?? resolveGrokHome(input.env ?? process.env, input.homedirFn ?? homedir);
  const sessionDir = findGrokSessionDir(grokHome, sessionId);
  if (!sessionDir) {
    return undefined;
  }

  const signals = readGrokSignalsContext(sessionDir);
  if (!signals) {
    return undefined;
  }

  return {
    contextWindowUsedTokens: signals.contextTokensUsed,
    contextWindowMaxTokens: signals.contextWindowTokens,
  };
}
