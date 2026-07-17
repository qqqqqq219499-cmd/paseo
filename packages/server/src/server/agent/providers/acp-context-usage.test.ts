import { describe, expect, test } from "vitest";

import { mapACPUsageUpdate, mergeACPContextUsage } from "./acp-context-usage.js";

describe("mapACPUsageUpdate", () => {
  test("maps context occupancy and USD cost", () => {
    expect(
      mapACPUsageUpdate({
        used: 42_000,
        size: 200_000,
        cost: { amount: 0.12, currency: "USD" },
      }),
    ).toEqual({
      contextWindowUsedTokens: 42_000,
      contextWindowMaxTokens: 200_000,
      totalCostUsd: 0.12,
    });
  });

  test("rejects invalid context occupancy", () => {
    expect(mapACPUsageUpdate({ used: 10, size: 0 })).toBeUndefined();
    expect(mapACPUsageUpdate({ used: -1, size: 100 })).toBeUndefined();
  });
});

describe("mergeACPContextUsage", () => {
  test("preserves prior cost when a provider only updates token occupancy", () => {
    expect(
      mergeACPContextUsage(
        {
          contextWindowUsedTokens: 10,
          contextWindowMaxTokens: 100,
          totalCostUsd: 0.2,
        },
        {
          contextWindowUsedTokens: 20,
          contextWindowMaxTokens: 100,
        },
      ),
    ).toEqual({
      contextWindowUsedTokens: 20,
      contextWindowMaxTokens: 100,
      totalCostUsd: 0.2,
    });
  });

  test("returns undefined for a no-op update", () => {
    const usage = {
      contextWindowUsedTokens: 20,
      contextWindowMaxTokens: 100,
    };
    expect(mergeACPContextUsage(usage, usage)).toBeUndefined();
  });
});
