export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/** Session-level cluster orchestration mode. Value is "on" when enabled. */
export const CLUSTER_MODE_LABEL = "paseo.cluster-mode";
export const CLUSTER_MODE_ON_VALUE = "on";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function isClusterModeEnabled(labels: Record<string, unknown> | null | undefined): boolean {
  const value = labels?.[CLUSTER_MODE_LABEL];
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === CLUSTER_MODE_ON_VALUE || normalized === "true" || normalized === "1";
}

export function clusterModeLabelPatch(enabled: boolean): Record<string, string> {
  return { [CLUSTER_MODE_LABEL]: enabled ? CLUSTER_MODE_ON_VALUE : "off" };
}
