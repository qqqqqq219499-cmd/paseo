/**
 * Per-daemon in-flight cluster run registry.
 *
 * One cluster run per agent id while a Planner + Spawn + Review is still in
 * flight. Keyed by an owner object (the AgentManager) so the lock is shared
 * across Session instances in the same daemon but isolated across daemons.
 * The lock spans planning → spawning → worker fan-in → evidence gate → the
 * main agent's review turn; it is released only when the run reaches a final
 * `done`/`failed` state (or an error path aborts the whole run).
 */

/** Actionable error when a second long task races an in-flight cluster start. */
export const CLUSTER_RUN_ALREADY_ACTIVE_ERROR =
  "A cluster run is already in progress for this agent. Wait for it to finish before sending another task.";

const activeRunsByOwner = new WeakMap<object, Set<string>>();

/**
 * Try to claim the single cluster-start slot for `agentId` under `owner`.
 * Returns a release function on success, or null when the slot is taken.
 * The release function is idempotent and safe to call multiple times.
 */
export function tryAcquireClusterRun(owner: object, agentId: string): (() => void) | null {
  let runs = activeRunsByOwner.get(owner);
  if (runs === undefined) {
    runs = new Set<string>();
    activeRunsByOwner.set(owner, runs);
  }
  if (runs.has(agentId)) {
    return null;
  }
  runs.add(agentId);

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    runs.delete(agentId);
    if (runs.size === 0) {
      activeRunsByOwner.delete(owner);
    }
  };
}
