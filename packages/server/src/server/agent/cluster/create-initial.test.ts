import { describe, expect, test } from "vitest";
import { CLUSTER_MODE_LABEL, CLUSTER_MODE_ON_VALUE } from "@getpaseo/protocol/agent-labels";
import { shouldRouteCreateInitialThroughCluster } from "./create-initial.js";

describe("shouldRouteCreateInitialThroughCluster", () => {
  test("routes when cluster label is on and prompt is non-empty", () => {
    expect(
      shouldRouteCreateInitialThroughCluster(
        { [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE },
        "  do the work  ",
      ),
    ).toBe(true);
  });

  test("does not route when cluster is off", () => {
    expect(
      shouldRouteCreateInitialThroughCluster({ [CLUSTER_MODE_LABEL]: "off" }, "do the work"),
    ).toBe(false);
  });

  test("does not route when labels are missing", () => {
    expect(shouldRouteCreateInitialThroughCluster(undefined, "do the work")).toBe(false);
    expect(shouldRouteCreateInitialThroughCluster({}, "do the work")).toBe(false);
  });

  test("does not route when prompt is empty", () => {
    expect(
      shouldRouteCreateInitialThroughCluster(
        { [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE },
        "   ",
      ),
    ).toBe(false);
    expect(
      shouldRouteCreateInitialThroughCluster(
        { [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE },
        undefined,
      ),
    ).toBe(false);
  });
});
