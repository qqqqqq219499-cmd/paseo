import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isClusterModeEnabled } from "@getpaseo/protocol/agent-labels";

/**
 * Hard guardrail enforcing the machine's cluster worker-model policy: when a
 * cluster-mode lead agent (the "CEO") spawns a worker via create_agent, the
 * worker's provider must be one the host's cluster config allows. Stops the
 * lead from delegating to its own expensive tier (e.g. Claude) instead of the
 * cheap/fast workers the config pins.
 *
 * The allow-list is the set of provider ids (the segment before the first "/")
 * that appear on any `provider = "..."` line in the host's
 * `~/.ai-shared/cluster-worker.toml` — covering [worker], [roles.*], and
 * [candidates.*]. This is a soft policy surface the user owns: adding a
 * provider to that file authorizes it.
 *
 * No config file → no policy → allow everything. This keeps the guardrail a
 * no-op on hosts that never opted into a worker policy (the shipping product,
 * CI), so it can never break an unconfigured cluster.
 */

const DEFAULT_CLUSTER_WORKER_TOML_PATH = path.join(
  os.homedir(),
  ".ai-shared",
  "cluster-worker.toml",
);

const PROVIDER_LINE_PATTERN = /^\s*provider\s*=\s*"([^"]+)"/gm;

export class ClusterWorkerProviderNotAllowedError extends Error {
  readonly code = "cluster_worker_provider_not_allowed" as const;

  constructor(
    readonly requestedProvider: string,
    readonly allowedProviders: string[],
  ) {
    super(
      `Cluster mode: the lead agent may only delegate to configured worker models ` +
        `(${allowedProviders.join(", ")}), not "${requestedProvider}". ` +
        `Add the provider to ~/.ai-shared/cluster-worker.toml to allow it.`,
    );
    this.name = "ClusterWorkerProviderNotAllowedError";
  }
}

/** Provider id = the segment before the first "/" (e.g. "opencode/x/y" → "opencode"). */
function providerId(providerValue: string): string {
  const trimmed = providerValue.trim();
  const slashIndex = trimmed.indexOf("/");
  return (slashIndex > 0 ? trimmed.slice(0, slashIndex) : trimmed).trim();
}

/**
 * Read the allowed worker provider ids from the host cluster config.
 * Returns null when the file is missing/unreadable/empty — meaning "no policy,
 * allow anything".
 */
export async function readAllowedWorkerProviderIds(
  tomlPath: string = DEFAULT_CLUSTER_WORKER_TOML_PATH,
): Promise<Set<string> | null> {
  let raw: string;
  try {
    raw = await readFile(tomlPath, "utf8");
  } catch {
    return null;
  }
  const ids = new Set<string>();
  for (const match of raw.matchAll(PROVIDER_LINE_PATTERN)) {
    const id = providerId(match[1]);
    if (id.length > 0) {
      ids.add(id);
    }
  }
  return ids.size > 0 ? ids : null;
}

/**
 * Throw if a cluster-mode lead agent tries to spawn a worker on a provider the
 * host config does not allow. No-op when the parent is not in cluster mode, or
 * when no worker policy is configured.
 */
export async function assertClusterWorkerProviderAllowed(params: {
  requestedProvider: string;
  parentLabels: Record<string, unknown> | null | undefined;
  tomlPath?: string;
}): Promise<void> {
  if (!isClusterModeEnabled(params.parentLabels)) {
    return;
  }
  const allowed = await readAllowedWorkerProviderIds(params.tomlPath);
  if (!allowed) {
    return;
  }
  const requestedId = providerId(params.requestedProvider);
  if (!allowed.has(requestedId)) {
    throw new ClusterWorkerProviderNotAllowedError(params.requestedProvider, [...allowed].sort());
  }
}
