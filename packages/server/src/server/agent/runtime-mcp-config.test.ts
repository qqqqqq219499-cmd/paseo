import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { withRuntimeMcpProxyServer, withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer cap-token" },
    });
  });

  test("omits the header when no token is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
    });
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: null,
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers).toBeUndefined();
  });
});

describe("withRuntimeMcpProxyServer", () => {
  test("injects MCPProxy alongside the internal Paseo server", () => {
    const withPaseo = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    const result = withRuntimeMcpProxyServer({
      config: withPaseo,
      mcpProxyUrl: "http://127.0.0.1:8933/mcp/",
    });

    expect(result.mcpServers).toEqual({
      mcpproxy: { type: "http", url: "http://127.0.0.1:8933/mcp/" },
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      },
    });
  });

  test("preserves an explicit per-agent MCPProxy override", () => {
    const result = withRuntimeMcpProxyServer({
      config: {
        ...BASE_CONFIG,
        mcpServers: {
          mcpproxy: { type: "http", url: "http://127.0.0.1:9999/mcp" },
        },
      },
      mcpProxyUrl: "http://127.0.0.1:8933/mcp/",
    });

    expect(result.mcpServers?.mcpproxy).toEqual({
      type: "http",
      url: "http://127.0.0.1:9999/mcp",
    });
  });
});
