import { describe, expect, test } from "vitest";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { findInlineSwarmAnchorIds, isCreateAgentToolCallItem } from "./inline-swarm-model";

function agentToolCall(id: string, name: string): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(0),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name,
        status: "completed",
        error: null,
        detail: { type: "unknown", input: null, output: null },
      },
    },
  };
}

function orchestratorToolCall(id: string, toolName: string): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(0),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName,
        arguments: {},
        status: "completed",
      },
    },
  };
}

function assistantMessage(id: string): StreamItem {
  return { kind: "assistant_message", id, text: "hello", timestamp: new Date(0) };
}

describe("isCreateAgentToolCallItem", () => {
  test("matches provider-native paseo tool names", () => {
    expect(isCreateAgentToolCallItem(agentToolCall("a", "mcp__paseo__create_agent"))).toBe(true);
    expect(isCreateAgentToolCallItem(agentToolCall("b", "paseo.create_agent"))).toBe(true);
    expect(isCreateAgentToolCallItem(agentToolCall("c", "create_agent"))).toBe(true);
    expect(isCreateAgentToolCallItem(agentToolCall("d", "paseo_create_agent"))).toBe(true);
    expect(isCreateAgentToolCallItem(agentToolCall("e", "mcp__paseo_voice__create_agent"))).toBe(
      true,
    );
  });

  test("rejects other tools and non-agent sources", () => {
    expect(isCreateAgentToolCallItem(agentToolCall("a", "mcp__other__create_agent"))).toBe(false);
    expect(isCreateAgentToolCallItem(agentToolCall("b", "Bash"))).toBe(false);
    expect(isCreateAgentToolCallItem(agentToolCall("c", "mcp__paseo__list_agents"))).toBe(false);
    expect(isCreateAgentToolCallItem(orchestratorToolCall("d", "mcp__paseo__create_agent"))).toBe(
      false,
    );
    expect(isCreateAgentToolCallItem(assistantMessage("e"))).toBe(false);
  });
});

describe("findInlineSwarmAnchorIds", () => {
  test("anchors the last call of a consecutive create_agent run", () => {
    const items = [
      agentToolCall("c1", "mcp__paseo__create_agent"),
      agentToolCall("c2", "mcp__paseo__create_agent"),
      agentToolCall("c3", "mcp__paseo__create_agent"),
    ];
    expect([...findInlineSwarmAnchorIds(items)]).toEqual(["c3"]);
  });

  test("splits runs interrupted by any other stream item", () => {
    const items = [
      agentToolCall("c1", "mcp__paseo__create_agent"),
      assistantMessage("m1"),
      agentToolCall("c2", "paseo.create_agent"),
      agentToolCall("t1", "Bash"),
      agentToolCall("c3", "create_agent"),
    ];
    expect([...findInlineSwarmAnchorIds(items)].sort()).toEqual(["c1", "c2", "c3"]);
  });

  test("returns an empty set without create_agent anchors", () => {
    expect(findInlineSwarmAnchorIds([]).size).toBe(0);
    expect(
      findInlineSwarmAnchorIds([assistantMessage("m1"), agentToolCall("t1", "Read")]).size,
    ).toBe(0);
  });
});
