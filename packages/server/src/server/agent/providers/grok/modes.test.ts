import { describe, expect, test } from "vitest";

import type { SessionStateResponse } from "../acp-agent.js";
import { enrichGrokSessionModes, GROK_MODES, normalizeGrokModeId } from "./modes.js";

describe("normalizeGrokModeId", () => {
  test("maps CLI aliases onto stable mode ids", () => {
    expect(normalizeGrokModeId("always-approve")).toBe("bypassPermissions");
    expect(normalizeGrokModeId("yolo")).toBe("bypassPermissions");
    expect(normalizeGrokModeId("plan")).toBe("plan");
    expect(normalizeGrokModeId("dontAsk")).toBe("dontAsk");
    expect(normalizeGrokModeId("default")).toBe("default");
  });
});

describe("enrichGrokSessionModes", () => {
  test("injects CLI modes when ACP returns modes:null", () => {
    const response = {
      sessionId: "s1",
      modes: null,
      models: null,
      configOptions: [],
    } as SessionStateResponse;

    const enriched = enrichGrokSessionModes(response);
    expect(enriched.modes?.availableModes?.map((mode) => mode.id)).toEqual(
      GROK_MODES.map((mode) => mode.id),
    );
    expect(enriched.modes?.currentModeId).toBe("default");
  });

  test("keeps ACP-provided modes when present", () => {
    const response = {
      sessionId: "s1",
      modes: {
        availableModes: [{ id: "custom", name: "Custom" }],
        currentModeId: "custom",
      },
      models: null,
      configOptions: [],
    } as SessionStateResponse;

    expect(enrichGrokSessionModes(response)).toBe(response);
  });
});
