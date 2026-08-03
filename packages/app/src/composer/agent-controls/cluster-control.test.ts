import { describe, expect, it } from "vitest";
import {
  isDraftClusterControlAvailable,
  resolveClusterControl,
  resolveDraftClusterCreateLabels,
  resolveDraftClusterCreateOptions,
  type ClusterControlSlice,
} from "./cluster";
import { CLUSTER_MODE_LABEL, CLUSTER_MODE_ON_VALUE } from "@getpaseo/protocol/agent-labels";

function slice(overrides: Partial<ClusterControlSlice> = {}): ClusterControlSlice {
  return {
    supported: true,
    enabled: false,
    hasClient: true,
    ...overrides,
  };
}

describe("resolveClusterControl", () => {
  it("returns null when the host does not advertise cluster mode", () => {
    expect(resolveClusterControl(slice({ supported: false, enabled: true }))).toBeNull();
  });

  it("returns null when there is no session slice", () => {
    expect(resolveClusterControl(null)).toBeNull();
    expect(resolveClusterControl(undefined)).toBeNull();
  });

  it("surfaces the label state as enabled when cluster mode is on", () => {
    expect(resolveClusterControl(slice({ enabled: true }))).toEqual({
      enabled: true,
      disabled: false,
    });
  });

  it("reports enabled=false when the label is off", () => {
    expect(resolveClusterControl(slice({ enabled: false }))).toEqual({
      enabled: false,
      disabled: false,
    });
  });

  it("disables the toggle when the session client is unavailable", () => {
    expect(resolveClusterControl(slice({ hasClient: false }))).toEqual({
      enabled: false,
      disabled: true,
    });
  });
});

describe("draft cluster control availability", () => {
  it("exposes the control only when the host advertises clusterMode", () => {
    expect(isDraftClusterControlAvailable(true)).toBe(true);
    expect(isDraftClusterControlAvailable(false)).toBe(false);
    expect(isDraftClusterControlAvailable(undefined)).toBe(false);
    expect(isDraftClusterControlAvailable(null)).toBe(false);
  });
});

describe("resolveDraftClusterCreateLabels", () => {
  it("sends paseo.cluster-mode=on when the draft toggle is enabled", () => {
    expect(resolveDraftClusterCreateLabels(true)).toEqual({
      [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE,
    });
  });

  it("returns an empty object when the draft toggle is off (caller omits labels)", () => {
    expect(resolveDraftClusterCreateLabels(false)).toEqual({});
  });
});

describe("resolveDraftClusterCreateOptions", () => {
  it("includes labels only for an enabled draft control", () => {
    expect(resolveDraftClusterCreateOptions({ enabled: true })).toEqual({
      labels: { [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE },
    });
    expect(resolveDraftClusterCreateOptions({ enabled: false })).toEqual({});
    expect(resolveDraftClusterCreateOptions(null)).toEqual({});
    expect(resolveDraftClusterCreateOptions(undefined)).toEqual({});
  });
});
