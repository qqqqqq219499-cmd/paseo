import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { asInternals } from "../../../test-utils/class-mocks.js";
import { deriveModelDefinitionsFromACP, type SessionStateResponse } from "../acp-agent.js";
import type { ACPContextUsageResolver } from "../acp-context-usage.js";
import { GrokACPAgentClient } from "./acp-agent.js";

interface GrokClientInternals {
  contextUsageResolver?: ACPContextUsageResolver;
  sessionResponseTransformer?: (response: SessionStateResponse) => SessionStateResponse;
}

describe("GrokACPAgentClient adapters", () => {
  test("wires Grok thinking enrichment and context resolution", () => {
    const client = new GrokACPAgentClient({
      logger: createTestLogger(),
      command: ["grok", "agent", "stdio"],
    });
    const internals = asInternals<GrokClientInternals>(client);

    const transformed = internals.sessionResponseTransformer?.({
      sessionId: "session-1",
      models: {
        currentModelId: "grok-4.5",
        availableModels: [
          {
            modelId: "grok-4.5",
            name: "Grok 4.5",
            _meta: {
              supportsReasoningEffort: true,
              reasoningEfforts: [{ id: "high", label: "High", default: true }],
            },
          },
        ],
      },
    });
    const efforts = transformed?.models?.availableModels?.[0]?._meta?.reasoningEfforts as Array<{
      id: string;
    }>;
    expect(efforts.map((effort) => effort.id)).toEqual(["xhigh", "high", "medium", "low"]);
    expect(
      deriveModelDefinitionsFromACP("grok", transformed?.models, transformed?.configOptions)[0],
    ).toMatchObject({
      id: "grok-4.5",
      defaultThinkingOptionId: "high",
      thinkingOptions: [{ id: "xhigh" }, { id: "high" }, { id: "medium" }, { id: "low" }],
    });

    expect(
      internals.contextUsageResolver?.resolveNotificationUsage?.(
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking" },
          },
          _meta: { totalTokens: 28_000 },
        },
        undefined,
      ),
    ).toEqual({
      contextWindowUsedTokens: 28_000,
      contextWindowMaxTokens: 500_000,
    });
  });
});
