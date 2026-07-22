import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { AgentUsage } from "../../agent-sdk-types.js";
import type { ACPContextUsageResolver } from "../acp-context-usage.js";

/**
 * Kimi Code CLI stores per-session event logs at
 * `$KIMI_CODE_HOME/sessions/<wd-slug-hash>/<sessionId>/agents/main/wire.jsonl`.
 * Each LLM request appends a `usage.record` line whose four components
 * (`inputOther` + `output` + `inputCacheRead` + `inputCacheCreation`) sum to
 * the context occupancy after that request — the same total agent-core keeps
 * in `context.tokenCount` (see kimi-code `packages/agent-core/src/agent/context/index.ts`).
 * The context window size lives in `$KIMI_CODE_HOME/config.toml` under
 * `[models."<alias>"] max_context_size`.
 *
 * kimi acp does not (yet) emit ACP `usage_update` notifications, so — like the
 * Grok provider — Paseo reads those local files to drive the composer context
 * ring. When a future kimi release emits standard `usage_update`, those events
 * take precedence on arrival and this disk reader stays as the fallback.
 */

/** Tail window scanned for the latest `usage.record` — wire.jsonl grows unbounded. */
const WIRE_TAIL_BYTES = 256 * 1024;
/** Minimum interval between two tail parses per session (stat mtime gates most calls). */
const MIN_READ_INTERVAL_MS = 500;

export function resolveKimiHome(env: NodeJS.ProcessEnv, homedirFn: () => string): string {
  return env["KIMI_CODE_HOME"] || join(homedirFn(), ".kimi-code");
}

/** Session ids are minted by the CLI (`session_<uuid>`); refuse anything path-like. */
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId);
}

/**
 * Locate `$KIMI_CODE_HOME/sessions/<cwd-key>/<sessionId>/` by walking cwd keys —
 * same approach as the Grok provider, robust to the CLI's workspace-registry
 * bucket renames (we never recompute the `wd_<slug>_<hash>` key).
 */
export function findKimiSessionDir(kimiHome: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) {
    return null;
  }
  const sessionsRoot = join(kimiHome, "sessions");
  if (!existsSync(sessionsRoot)) {
    return null;
  }

  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(sessionsRoot, entry.name, sessionId);
    if (existsSync(join(candidate, "agents", "main", "wire.jsonl"))) {
      return candidate;
    }
  }
  return null;
}

interface KimiWireUsage {
  contextTokensUsed: number;
  modelAlias: string | null;
}

function readWireTail(wirePath: string): string {
  const size = statSync(wirePath).size;
  const fd = openSync(wirePath, "r");
  try {
    const length = Math.min(size, WIRE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function sumUsageComponents(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const record = usage as Record<string, unknown>;
  const parts = [
    record["inputOther"],
    record["output"],
    record["inputCacheRead"],
    record["inputCacheCreation"],
  ];
  let total = 0;
  for (const part of parts) {
    if (typeof part !== "number" || !Number.isFinite(part) || part < 0) {
      return null;
    }
    total += part;
  }
  return total;
}

/**
 * Read live context occupancy from the wire.jsonl tail: the LAST `usage.record`
 * with a non-zero total (mirroring agent-core, which only overwrites its token
 * count when the provider reports usage), plus the model alias it belongs to.
 */
export function readKimiWireUsage(sessionDir: string): KimiWireUsage | null {
  const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
  if (!existsSync(wirePath)) {
    return null;
  }

  let tail: string;
  try {
    tail = readWireTail(wirePath);
  } catch {
    return null;
  }

  const lines = tail.split("\n");
  let contextTokensUsed: number | null = null;
  let modelAlias: string | null = null;
  // A partial first line is possible when the tail window starts mid-record —
  // scanning from the end makes that harmless.
  for (let index = lines.length - 1; index >= 0 && contextTokensUsed === null; index--) {
    const line = lines[index]!.trim();
    if (!line.includes("\"usage.record\"")) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { type?: unknown; model?: unknown; usage?: unknown };
      if (event.type !== "usage.record") {
        continue;
      }
      const total = sumUsageComponents(event.usage);
      if (total === null || total <= 0) {
        continue;
      }
      contextTokensUsed = total;
      if (typeof event.model === "string" && event.model.length > 0) {
        modelAlias = event.model;
      }
    } catch {
      // Truncated line at the tail boundary — keep scanning older records.
    }
  }

  return contextTokensUsed === null ? null : { contextTokensUsed, modelAlias };
}

/**
 * Extract `max_context_size` for a model alias from `$KIMI_CODE_HOME/config.toml`.
 * Narrow parser for the CLI's machine-written shape — flat `key = value` lines
 * under `[models."<alias>"]` headers — so Paseo does not need a TOML dependency.
 */
export function readKimiModelContextWindow(kimiHome: string, modelAlias: string): number | null {
  const configPath = join(kimiHome, "config.toml");
  if (!existsSync(configPath) || modelAlias.includes("]")) {
    return null;
  }

  let toml: string;
  try {
    toml = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  const header = `[models."${modelAlias}"]`;
  const start = toml.indexOf(header);
  if (start === -1) {
    return null;
  }
  const body = toml.slice(start + header.length);
  const nextSection = body.search(/\r?\n\s*\[/);
  const section = nextSection === -1 ? body : body.slice(0, nextSection);
  const match = /^\s*max_context_size\s*=\s*(\d+)\s*$/m.exec(section);
  if (!match) {
    return null;
  }
  const size = Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * Resolve Kimi context usage for a session id from local CLI files.
 * Returns AgentUsage fields for the composer context ring.
 */
export function resolveKimiContextUsageFromDisk(input: {
  sessionId: string | null | undefined;
  kimiHome?: string;
  env?: NodeJS.ProcessEnv;
  homedirFn?: () => string;
}): AgentUsage | undefined {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }

  const kimiHome = input.kimiHome ?? resolveKimiHome(input.env ?? process.env, input.homedirFn ?? homedir);
  const sessionDir = findKimiSessionDir(kimiHome, sessionId);
  if (!sessionDir) {
    return undefined;
  }

  const wire = readKimiWireUsage(sessionDir);
  if (!wire) {
    return undefined;
  }

  const maxTokens = wire.modelAlias
    ? readKimiModelContextWindow(kimiHome, wire.modelAlias)
    : null;
  if (maxTokens === null) {
    return undefined;
  }

  return {
    contextWindowUsedTokens: wire.contextTokensUsed,
    contextWindowMaxTokens: maxTokens,
  };
}

interface WireReadCacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  readAt: number;
  usage: AgentUsage | undefined;
}

export function createKimiContextUsageResolver(
  options: {
    kimiHome?: string;
    env?: NodeJS.ProcessEnv;
    homedirFn?: () => string;
    nowFn?: () => number;
  } = {},
): ACPContextUsageResolver {
  const now = options.nowFn ?? Date.now;
  const cache = new Map<string, WireReadCacheEntry>();

  const resolveFresh = (sessionId: string): AgentUsage | undefined =>
    resolveKimiContextUsageFromDisk({ sessionId, ...options });

  return {
    resolveInitialUsage: (sessionId) => resolveFresh(sessionId),
    resolveNotificationUsage: (notification: SessionNotification, _currentUsage) => {
      const sessionId = notification.sessionId;
      if (!sessionId) {
        return undefined;
      }
      const kimiHome =
        options.kimiHome ?? resolveKimiHome(options.env ?? process.env, options.homedirFn ?? homedir);
      const sessionDir = findKimiSessionDir(kimiHome, sessionId);
      if (!sessionDir) {
        return undefined;
      }
      const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
      let stat;
      try {
        stat = statSync(wirePath);
      } catch {
        return undefined;
      }
      const cached = cache.get(sessionId);
      // wire.jsonl is appended on every agent event; only re-parse the tail
      // when the file actually grew past our last read and the throttle
      // interval elapsed. Usage records land once per LLM step, so the ring
      // still tracks consumption promptly.
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.sizeBytes === stat.size
      ) {
        return undefined;
      }
      if (cached && now() - cached.readAt < MIN_READ_INTERVAL_MS) {
        return undefined;
      }
      const usage = resolveFresh(sessionId);
      cache.set(sessionId, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size, readAt: now(), usage });
      return usage;
    },
  };
}
