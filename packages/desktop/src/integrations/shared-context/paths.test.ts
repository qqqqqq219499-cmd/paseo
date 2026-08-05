import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MCPPROXY_URL } from "./operations";
import { resolveSharedContextTargets } from "./paths";

describe("shared context provider adapters", () => {
  it("covers every supported installed AI client family", () => {
    const targets = resolveSharedContextTargets(path.join(os.tmpdir(), "paseo-home"), {
      LOCALAPPDATA: path.join(os.tmpdir(), "local-app-data"),
    });

    expect(targets.providers.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "grok",
      "kimi",
      "gemini",
      "hermes",
      "cursor",
    ]);
  });

  it("configures Hermes MCP without an interactive authentication prompt", () => {
    const targets = resolveSharedContextTargets(path.join(os.tmpdir(), "paseo-home"), {
      LOCALAPPDATA: path.join(os.tmpdir(), "local-app-data"),
    });
    const hermes = targets.providers.find((provider) => provider.id === "hermes");

    expect(hermes?.mcp).toEqual({
      kind: "command",
      configPath: path.join(os.tmpdir(), "local-app-data", "hermes", "config.yaml"),
      checkArgs: ["config", "get", "mcp_servers.mcpproxy.url"],
      addArgs: ["config", "set", "mcp_servers.mcpproxy.url", MCPPROXY_URL],
    });
  });
});
