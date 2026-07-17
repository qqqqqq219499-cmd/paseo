import { describe, expect, test } from "vitest";

import {
  deriveCurrentThinkingOptionFromModels,
  deriveThinkingOptionsFromModelMeta,
  resolveThinkingOptionAfterModelChange,
} from "./acp-model-thinking.js";

describe("deriveThinkingOptionsFromModelMeta", () => {
  test("maps ACP reasoning metadata into composer options", () => {
    expect(
      deriveThinkingOptionsFromModelMeta({
        _meta: {
          reasoningEffort: "medium",
          reasoningEfforts: [
            { id: "high", label: "High", default: false },
            { id: "medium", label: "Medium", default: true },
          ],
        },
      }),
    ).toEqual({
      thinkingOptions: [
        { id: "high", label: "High", description: undefined, isDefault: false },
        { id: "medium", label: "Medium", description: undefined, isDefault: true },
      ],
      currentThinkingOptionId: "medium",
    });
  });
});

describe("deriveCurrentThinkingOptionFromModels", () => {
  test("reads the selected model's current reasoning effort", () => {
    expect(
      deriveCurrentThinkingOptionFromModels({
        currentModelId: "grok-4.5",
        availableModels: [
          {
            modelId: "grok-4.5",
            name: "Grok 4.5",
            _meta: {
              reasoningEffort: "high",
              reasoningEfforts: [{ id: "high", label: "High", default: true }],
            },
          },
        ],
      }),
    ).toBe("high");
  });
});

describe("resolveThinkingOptionAfterModelChange", () => {
  test("keeps a requested effort supported by the target model", () => {
    expect(
      resolveThinkingOptionAfterModelChange({
        requestedThinkingOptionId: "high",
        targetFromMeta: {
          thinkingOptions: [
            { id: "high", label: "High" },
            { id: "low", label: "Low" },
          ],
          currentThinkingOptionId: "low",
        },
      }),
    ).toBe("high");
  });

  test("falls back to the target model effort when the requested effort is unsupported", () => {
    expect(
      resolveThinkingOptionAfterModelChange({
        requestedThinkingOptionId: "xhigh",
        targetFromMeta: {
          thinkingOptions: [
            { id: "high", label: "High" },
            { id: "low", label: "Low" },
          ],
          currentThinkingOptionId: "low",
        },
      }),
    ).toBe("low");
  });
});
