import { describe, expect, test } from "vitest";

import type { SessionStateResponse } from "../acp-agent.js";
import {
  enrichGrokModelReasoningEfforts,
  enrichGrokSessionReasoningEfforts,
  mergeGrokCliReasoningEfforts,
} from "./reasoning-efforts.js";

describe("mergeGrokCliReasoningEfforts", () => {
  test("adds CLI xhigh when the model menu only lists high/medium/low", () => {
    const merged = mergeGrokCliReasoningEfforts([
      { id: "high", label: "High Effort", default: true },
      { id: "medium", label: "Medium Effort", default: false },
      { id: "low", label: "Low Effort", default: false },
    ]);

    expect(merged.map((entry) => (entry as { id: string }).id)).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
    expect((merged[1] as { default?: boolean }).default).toBe(true);
  });

  test("preserves extra per-model menu ids after the CLI set", () => {
    const merged = mergeGrokCliReasoningEfforts([
      { id: "high", label: "High", default: true },
      { id: "deep", label: "Deep", default: false },
    ]);

    expect(merged.map((entry) => (entry as { id: string }).id)).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
      "deep",
    ]);
  });
});

describe("enrichGrokModelReasoningEfforts", () => {
  test("syncs CLI efforts onto models that support reasoning", () => {
    const enriched = enrichGrokModelReasoningEfforts({
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", label: "High Effort", default: true },
          { id: "medium", label: "Medium Effort", default: false },
          { id: "low", label: "Low Effort", default: false },
        ],
      },
    });

    const efforts = enriched._meta?.reasoningEfforts as Array<{ id: string }>;
    expect(efforts.map((entry) => entry.id)).toEqual(["xhigh", "high", "medium", "low"]);
  });

  test("leaves non-reasoning models untouched", () => {
    const model = {
      modelId: "grok-composer-2.5-fast",
      name: "Composer 2.5",
      _meta: { supportsReasoningEffort: false },
    };

    expect(enrichGrokModelReasoningEfforts(model)).toBe(model);
  });
});

describe("enrichGrokSessionReasoningEfforts", () => {
  test("enriches only reasoning-capable models in the session payload", () => {
    const response = {
      sessionId: "session-1",
      models: {
        currentModelId: "grok-4.5",
        availableModels: [
          {
            modelId: "grok-4.5",
            name: "Grok 4.5",
            _meta: {
              reasoningEfforts: [
                { id: "high", label: "High Effort", default: true },
                { id: "low", label: "Low Effort", default: false },
              ],
            },
          },
          {
            modelId: "grok-composer-2.5-fast",
            name: "Composer 2.5",
            _meta: {},
          },
        ],
      },
      configOptions: [],
    } as SessionStateResponse;

    const enriched = enrichGrokSessionReasoningEfforts(response);
    const grokEfforts = enriched.models?.availableModels?.[0]?._meta?.reasoningEfforts as Array<{
      id: string;
    }>;
    expect(grokEfforts.map((entry) => entry.id)).toEqual(["xhigh", "high", "medium", "low"]);
    expect(enriched.models?.availableModels?.[1]).toEqual(response.models?.availableModels?.[1]);
  });
});
