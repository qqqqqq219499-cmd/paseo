import { clusterModeLabelPatch } from "@getpaseo/protocol/agent-labels";

export interface ClusterControlSlice {
  supported: boolean;
  enabled: boolean;
  hasClient: boolean;
}

export interface ResolvedClusterControl {
  enabled: boolean;
  disabled: boolean;
}

export function resolveClusterControl(
  slice: ClusterControlSlice | null | undefined,
): ResolvedClusterControl | null {
  if (!slice || !slice.supported) {
    return null;
  }
  return {
    enabled: slice.enabled,
    disabled: !slice.hasClient,
  };
}

/** Draft toolbar shows the cluster toggle only when the host advertises the feature. */
export function isDraftClusterControlAvailable(supported: boolean | null | undefined): boolean {
  return supported === true;
}

/**
 * Labels for draft create / optimistic snapshot.
 * Enabled → `paseo.cluster-mode=on`; disabled → empty (caller omits the field).
 */
export function resolveDraftClusterCreateLabels(enabled: boolean): Record<string, string> {
  if (!enabled) {
    return {};
  }
  return clusterModeLabelPatch(true);
}

export function resolveDraftClusterCreateOptions(
  control: { enabled: boolean } | null | undefined,
): { labels?: Record<string, string> } {
  if (control?.enabled !== true) {
    return {};
  }
  return { labels: clusterModeLabelPatch(true) };
}
