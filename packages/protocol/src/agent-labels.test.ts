import { describe, expect, test } from "vitest";
import {
  CLUSTER_MODE_LABEL,
  CLUSTER_MODE_ON_VALUE,
  clusterModeLabelPatch,
  getParentAgentIdFromLabels,
  isClusterModeEnabled,
  isDelegatedAgent,
  PARENT_AGENT_ID_LABEL,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("reads cluster mode from the dedicated label", () => {
    expect(isClusterModeEnabled({})).toBe(false);
    expect(isClusterModeEnabled({ [CLUSTER_MODE_LABEL]: "off" })).toBe(false);
    expect(isClusterModeEnabled({ [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE })).toBe(true);
    expect(isClusterModeEnabled({ [CLUSTER_MODE_LABEL]: " ON " })).toBe(true);
    expect(isClusterModeEnabled({ [CLUSTER_MODE_LABEL]: "true" })).toBe(true);
    expect(isClusterModeEnabled({ [CLUSTER_MODE_LABEL]: "1" })).toBe(true);
    expect(clusterModeLabelPatch(true)).toEqual({ [CLUSTER_MODE_LABEL]: "on" });
    expect(clusterModeLabelPatch(false)).toEqual({ [CLUSTER_MODE_LABEL]: "off" });
  });
});
