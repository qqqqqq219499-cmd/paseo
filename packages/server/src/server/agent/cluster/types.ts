export type ClusterRole = "impl" | "ui" | "research" | "planning" | "audit";

export type ClusterIsolation = "shared" | "worktree";

export interface WorkerScope {
  allow: string[];
  deny: string[];
}

export interface WorkerSpec {
  /** Task graph node id, unique within the cluster plan. */
  id: string;
  title: string;
  goal: string;
  role: ClusterRole;
  provider: string;
  scope: WorkerScope;
  isolation: ClusterIsolation;
  dependsOn?: string[];
  successCriteria: string[];
  autoArchive?: boolean;
}

export interface ClusterPlan {
  id: string;
  goal: string;
  workers: WorkerSpec[];
}

/**
 * Cluster run state machine, mirroring the MVP spec:
 * `cluster_idle → planning → spawning → running → reviewing → done|failed|skipped_single`
 */
export type ClusterRunState =
  | { phase: "idle" }
  | { phase: "planning" }
  | { phase: "spawning" }
  | { phase: "running"; workerIds: string[] }
  | { phase: "reviewing"; workerIds: string[] }
  | { phase: "done"; workerIds: string[] }
  | { phase: "failed"; error: string }
  | { phase: "skipped_single"; reason: string };
