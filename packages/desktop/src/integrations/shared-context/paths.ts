import os from "node:os";
import path from "node:path";
import {
  MCPPROXY_URL,
  type SharedContextProviderTarget,
  type SharedContextTargets,
} from "./operations.js";

function resolveHermesHome(homeDir: string, env: NodeJS.ProcessEnv): string {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "hermes");
  }
  return path.join(homeDir, ".hermes");
}

export function resolveSharedContextTargets(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): SharedContextTargets {
  const sharedSkillsDir = path.join(homeDir, ".ai-shared", "skills");
  const hermesHome = resolveHermesHome(homeDir, env);
  const providers: SharedContextProviderTarget[] = [
    {
      id: "claude",
      label: "Claude",
      command: "claude",
      promptPath: path.join(homeDir, ".claude", "CLAUDE.md"),
      skills: { kind: "link", path: path.join(homeDir, ".claude", "skills") },
      mcp: {
        kind: "command",
        configPath: path.join(homeDir, ".claude.json"),
        checkArgs: ["mcp", "get", "mcpproxy"],
        addArgs: ["mcp", "add", "--scope", "user", "--transport", "http", "mcpproxy", MCPPROXY_URL],
      },
    },
    {
      id: "codex",
      label: "Codex",
      command: "codex",
      promptPath: path.join(homeDir, ".codex", "AGENTS.md"),
      skills: { kind: "link", path: path.join(homeDir, ".codex", "skills") },
      mcp: {
        kind: "command",
        configPath: path.join(homeDir, ".codex", "config.toml"),
        checkArgs: ["mcp", "get", "mcpproxy"],
        addArgs: ["mcp", "add", "mcpproxy", "--url", MCPPROXY_URL],
      },
    },
    {
      id: "grok",
      label: "Grok",
      command: "grok",
      promptPath: path.join(homeDir, ".grok", "AGENTS.md"),
      skills: { kind: "link", path: path.join(homeDir, ".grok", "skills") },
      mcp: {
        kind: "command",
        configPath: path.join(homeDir, ".grok", "config.toml"),
        checkArgs: ["mcp", "list"],
        addArgs: ["mcp", "add", "--scope", "user", "--transport", "http", "mcpproxy", MCPPROXY_URL],
      },
    },
    {
      id: "kimi",
      label: "Kimi Code",
      command: "kimi",
      promptPath: path.join(homeDir, ".kimi-code", "AGENTS.md"),
      skills: { kind: "link", path: path.join(homeDir, ".kimi-code", "skills") },
      mcp: { kind: "json", configPath: path.join(homeDir, ".kimi-code", "mcp.json") },
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      command: "gemini",
      promptPath: path.join(homeDir, ".gemini", "GEMINI.md"),
      skills: { kind: "link", path: path.join(homeDir, ".agents", "skills") },
      mcp: {
        kind: "command",
        configPath: path.join(homeDir, ".gemini", "settings.json"),
        checkArgs: ["mcp", "list"],
        addArgs: ["mcp", "add", "--scope", "user", "--transport", "http", "mcpproxy", MCPPROXY_URL],
      },
    },
    {
      id: "hermes",
      label: "Hermes",
      command: "hermes",
      promptPath: path.join(hermesHome, "AGENTS.md"),
      skills: {
        kind: "command",
        configPath: path.join(hermesHome, "config.yaml"),
        checkArgs: ["config", "get", "skills.external_dirs"],
        addArgs: ["config", "set", "skills.external_dirs", sharedSkillsDir],
      },
      mcp: {
        kind: "command",
        configPath: path.join(hermesHome, "config.yaml"),
        checkArgs: ["config", "get", "mcp_servers.mcpproxy.url"],
        addArgs: ["config", "set", "mcp_servers.mcpproxy.url", MCPPROXY_URL],
      },
    },
    {
      id: "cursor",
      label: "Cursor Agent",
      command: "cursor-agent",
      skills: { kind: "link", path: path.join(homeDir, ".agents", "skills") },
      mcp: { kind: "json", configPath: path.join(homeDir, ".cursor", "mcp.json") },
    },
  ];

  return {
    sharedPromptPath: path.join(homeDir, ".ai-shared", "AGENTS.md"),
    sharedSkillsDir,
    standardSkillsDir: path.join(homeDir, ".agents", "skills"),
    providers,
  };
}
