import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePaseoHome } from "../../paseo-home.js";
import type { ClusterRole } from "./types.js";

/**
 * Role → provider mapping file at `~/.paseo/orchestration-preferences.json`.
 *
 * Shape:
 * ```json
 * {
 *   "providers": {
 *     "impl": "opencode/opencode-go/deepseek-v4-flash",
 *     "ui": "opencode/opencode-go/deepseek-v4-flash"
 *   }
 * }
 * ```
 * Role keys not present fall back to the shared worker TOML.
 */
export const ORCHESTRATION_PREFERENCES_FILE = "orchestration-preferences.json";

/**
 * Fallback worker config at `~/.ai-shared/cluster-worker.toml`:
 * ```toml
 * [worker]
 * provider = "grok/grok-4.5"
 * mode = "full-access"
 * thinking = "max"
 * auto_archive = true
 *
 * [roles.research]
 * provider = "grok/grok-4.5"
 * ```
 * Parsed with a minimal hand-rolled reader (no new dependency).
 */
export const DEFAULT_CLUSTER_WORKER_TOML = "cluster-worker.toml";

export interface ClusterPreferencesOptions {
  /** Defaults to `resolvePaseoHome()` (honors `PASEO_HOME`). */
  paseoHome?: string;
  /** Defaults to `~/.ai-shared/cluster-worker.toml`. */
  workerTomlPath?: string;
}

export interface OrchestrationPreferencesJson {
  providers?: Partial<Record<ClusterRole, string>>;
}

/** Resolved worker launch profile for a cluster role. `provider` is required. */
export interface ClusterWorkerProfile {
  provider: string;
  mode?: string;
  thinking?: string;
  autoArchive?: boolean;
}

/** Partial fields as they appear in a TOML section. */
export interface ClusterTomlProfileFields {
  provider?: string;
  mode?: string;
  thinking?: string;
  autoArchive?: boolean;
}

export interface ParsedClusterWorkerToml {
  worker: ClusterTomlProfileFields | null;
  roles: Partial<Record<string, ClusterTomlProfileFields>>;
}

/**
 * Resolve the full worker profile for a role.
 *
 * Priority (provider and optional fields):
 * 1. `~/.paseo/orchestration-preferences.json` `providers[role]` — provider only
 * 2. `cluster-worker.toml` `[roles.<role>]`
 * 3. `cluster-worker.toml` `[worker]`
 *
 * JSON only supplies provider. If that provider string differs from the TOML
 * provider, `mode`/`thinking` from TOML are dropped (they belong to the old
 * channel); `autoArchive` may still be kept. Same provider keeps TOML mode/thinking.
 * Returns `null` when no provider can be resolved.
 */
export async function resolveClusterWorkerProfile(
  role: ClusterRole,
  options?: ClusterPreferencesOptions,
): Promise<ClusterWorkerProfile | null> {
  const paseoHome = options?.paseoHome ?? resolvePaseoHome();
  const tomlPath = options?.workerTomlPath ?? defaultClusterWorkerTomlPath();

  const toml = await readClusterWorkerToml(tomlPath);
  const preferences = await readOrchestrationPreferences(paseoHome);

  const fields = applyPreferencesOverride(
    mergeTomlFields(toml, role),
    preferences?.providers?.[role],
  );
  return buildWorkerProfile(fields);
}

/** Merge `[worker]` then `[roles.<role>]` section fields, role section wins. */
function mergeTomlFields(
  toml: ParsedClusterWorkerToml | null,
  role: ClusterRole,
): ClusterTomlProfileFields {
  let fields: ClusterTomlProfileFields = {};
  if (toml?.worker) {
    fields = { ...fields, ...toml.worker };
  }
  const roleSection = toml?.roles?.[role];
  if (roleSection) {
    fields = { ...fields, ...roleSection };
  }
  return fields;
}

/**
 * Apply the JSON provider override. A provider that differs from the TOML one
 * drops TOML `mode`/`thinking` (different channel); `autoArchive` may survive.
 */
function applyPreferencesOverride(
  fields: ClusterTomlProfileFields,
  fromPreferences: string | undefined,
): ClusterTomlProfileFields {
  const tomlProvider = fields.provider?.trim() || undefined;
  if (typeof fromPreferences === "string" && fromPreferences.trim().length > 0) {
    const jsonProvider = fromPreferences.trim();
    if (tomlProvider && jsonProvider !== tomlProvider) {
      // Different channel: do not inherit mode/thinking tuned for the old provider.
      return {
        provider: jsonProvider,
        ...(typeof fields.autoArchive === "boolean" ? { autoArchive: fields.autoArchive } : {}),
      };
    }
    return { ...fields, provider: jsonProvider };
  }
  return fields;
}

/** Build the launch profile; `null` when no provider can be resolved. */
function buildWorkerProfile(fields: ClusterTomlProfileFields): ClusterWorkerProfile | null {
  const provider = fields.provider?.trim();
  if (!provider) {
    return null;
  }

  const profile: ClusterWorkerProfile = { provider };
  if (typeof fields.mode === "string" && fields.mode.trim().length > 0) {
    profile.mode = fields.mode.trim();
  }
  if (typeof fields.thinking === "string" && fields.thinking.trim().length > 0) {
    profile.thinking = fields.thinking.trim();
  }
  if (typeof fields.autoArchive === "boolean") {
    profile.autoArchive = fields.autoArchive;
  }
  return profile;
}

/**
 * Resolve the worker provider for a role, preferring
 * `~/.paseo/orchestration-preferences.json` providers and falling back to
 * TOML `[roles.<role>]` then `[worker].provider`.
 * Returns `null` when neither source is readable or configured.
 */
export async function resolveWorkerProvider(
  role: ClusterRole,
  options?: ClusterPreferencesOptions,
): Promise<string | null> {
  const profile = await resolveClusterWorkerProfile(role, options);
  return profile?.provider ?? null;
}

export async function readOrchestrationPreferences(
  paseoHome: string,
): Promise<OrchestrationPreferencesJson | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(paseoHome, ORCHESTRATION_PREFERENCES_FILE), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as OrchestrationPreferencesJson;
  } catch {
    return null;
  }
}

export async function readTomlWorkerProvider(tomlPath: string): Promise<string | null> {
  const parsed = await readClusterWorkerToml(tomlPath);
  const provider = parsed?.worker?.provider?.trim();
  return provider && provider.length > 0 ? provider : null;
}

export async function readClusterWorkerToml(
  tomlPath: string,
): Promise<ParsedClusterWorkerToml | null> {
  let raw: string;
  try {
    raw = await readFile(tomlPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
  return parseClusterWorkerToml(raw);
}

/**
 * Minimal TOML reader for `[worker]` and `[roles.<name>]` sections.
 * Keys: `provider`, `mode`, `thinking`, `auto_archive`.
 */
export function parseClusterWorkerToml(tomlText: string): ParsedClusterWorkerToml {
  const result: ParsedClusterWorkerToml = {
    worker: null,
    roles: {},
  };

  let current: { kind: "worker" } | { kind: "role"; name: string } | null = null;
  let currentFields: ClusterTomlProfileFields = {};

  const flush = () => {
    if (!current) {
      return;
    }
    if (current.kind === "worker") {
      result.worker = { ...currentFields };
    } else {
      result.roles[current.name] = { ...currentFields };
    }
  };

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      flush();
      currentFields = {};
      if (line === "[worker]") {
        current = { kind: "worker" };
      } else {
        const roleMatch = /^\[roles\.([^\]]+)\]$/.exec(line);
        if (roleMatch) {
          current = { kind: "role", name: roleMatch[1].trim() };
        } else {
          current = null;
        }
      }
      continue;
    }
    if (!current) {
      continue;
    }

    const stringMatch = /^(provider|mode|thinking)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (stringMatch) {
      const key = stringMatch[1] as "provider" | "mode" | "thinking";
      const value = stringMatch[2].trim();
      if (value.length > 0) {
        currentFields[key] = value;
      }
      continue;
    }

    const boolMatch = /^auto_archive\s*=\s*(true|false)\s*$/i.exec(line);
    if (boolMatch) {
      currentFields.autoArchive = boolMatch[1].toLowerCase() === "true";
    }
  }
  flush();
  return result;
}

/** Minimal TOML reader: only the `provider = "..."` key inside `[worker]`. */
export function parseTomlWorkerProvider(tomlText: string): string | null {
  const provider = parseClusterWorkerToml(tomlText).worker?.provider?.trim();
  return provider && provider.length > 0 ? provider : null;
}

function defaultClusterWorkerTomlPath(): string {
  return path.join(os.homedir(), ".ai-shared", DEFAULT_CLUSTER_WORKER_TOML);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
