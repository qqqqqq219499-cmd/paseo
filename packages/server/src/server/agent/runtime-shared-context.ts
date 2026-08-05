import os from "node:os";
import path from "node:path";

export interface RuntimeSharedContext {
  promptPath: string;
  skillsDir: string;
  mcpProxyUrl: string;
  nativePromptPaths?: Record<string, string>;
}

export function resolveRuntimeSharedContext(homeDir = os.homedir()): RuntimeSharedContext {
  const hermesHome =
    process.env.HERMES_HOME ??
    (process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "hermes")
      : path.join(homeDir, ".hermes"));
  return {
    promptPath: path.join(homeDir, ".ai-shared", "AGENTS.md"),
    skillsDir: path.join(homeDir, ".ai-shared", "skills"),
    mcpProxyUrl: "http://127.0.0.1:8933/mcp/",
    nativePromptPaths: {
      claude: path.join(homeDir, ".claude", "CLAUDE.md"),
      codex: path.join(homeDir, ".codex", "AGENTS.md"),
      grok: path.join(homeDir, ".grok", "AGENTS.md"),
      kimi: path.join(homeDir, ".kimi-code", "AGENTS.md"),
      gemini: path.join(homeDir, ".gemini", "GEMINI.md"),
      hermes: path.join(hermesHome, "AGENTS.md"),
    },
  };
}
