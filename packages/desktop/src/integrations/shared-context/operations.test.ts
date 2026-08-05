import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSharedContextStatus,
  resolveCommandInvocation,
  syncSharedContext,
  type SharedContextRuntime,
  type SharedContextTargets,
} from "./operations";

const MCPPROXY_URL = "http://127.0.0.1:8933/mcp/";

interface Sandbox {
  root: string;
  targets: SharedContextTargets;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-shared-context-"));
  const home = path.join(root, "home");
  const sharedSkillsDir = path.join(home, ".ai-shared", "skills");
  return {
    root,
    targets: {
      sharedPromptPath: path.join(home, ".ai-shared", "AGENTS.md"),
      sharedSkillsDir,
      standardSkillsDir: path.join(home, ".agents", "skills"),
      providers: [
        {
          id: "alpha",
          label: "Alpha AI",
          command: "alpha",
          promptPath: path.join(home, ".alpha", "AGENTS.md"),
          skills: { kind: "link", path: path.join(home, ".alpha", "skills") },
          mcp: {
            kind: "command",
            configPath: path.join(home, ".alpha", "config.toml"),
            checkArgs: ["mcp", "get", "mcpproxy"],
            addArgs: ["mcp", "add", "mcpproxy", "--url", MCPPROXY_URL],
          },
        },
        {
          id: "beta",
          label: "Beta AI",
          command: "beta",
          promptPath: path.join(home, ".beta", "RULES.md"),
          skills: { kind: "link", path: path.join(home, ".beta", "skills") },
          mcp: {
            kind: "json",
            configPath: path.join(home, ".beta", "mcp.json"),
          },
        },
        {
          id: "gamma",
          label: "Gamma AI",
          command: "gamma",
          promptPath: path.join(home, ".gamma", "AGENTS.md"),
          skills: {
            kind: "command",
            checkArgs: ["config", "get", "skills.external_dirs"],
            addArgs: ["config", "set", "skills.external_dirs", sharedSkillsDir],
          },
          mcp: {
            kind: "command",
            configPath: path.join(home, ".gamma", "config.yaml"),
            checkArgs: ["mcp", "list"],
            addArgs: ["mcp", "add", "mcpproxy", "--url", MCPPROXY_URL],
          },
        },
        {
          id: "missing",
          label: "Missing AI",
          command: "missing",
          promptPath: path.join(home, ".missing", "AGENTS.md"),
          skills: { kind: "link", path: path.join(home, ".missing", "skills") },
          mcp: {
            kind: "command",
            checkArgs: ["mcp", "list"],
            addArgs: ["mcp", "add", "mcpproxy", "--url", MCPPROXY_URL],
          },
        },
      ],
    },
  };
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

function createRuntime(overrides: Partial<SharedContextRuntime> = {}): SharedContextRuntime {
  return {
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    probeMcpProxy: vi.fn(async () => true),
    isCommandAvailable: vi.fn(async (command: string) => command !== "missing"),
    runCommand: vi.fn(async (_command: string, args: string[]) => ({
      stdout:
        args[0] === "config"
          ? path.join(os.tmpdir(), "paseo-shared-context-placeholder", "skills")
          : MCPPROXY_URL,
      stderr: "",
    })),
    ...overrides,
  };
}

async function sameFile(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

describe("shared AI context", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("reports generic per-provider capabilities and ignores clients that are not installed", async () => {
    const prompt = "one prompt";
    await writeFile(sandbox.targets.sharedPromptPath, prompt);
    await writeFile(path.join(sandbox.targets.sharedSkillsDir, "paseo", "SKILL.md"), "skill");
    const configured = new Set(["alpha", "beta", "gamma"]);
    const runtime = createRuntime({
      runCommand: vi.fn(async (command, args) => {
        let stdout = "";
        if (args[0] === "config") {
          stdout = sandbox.targets.sharedSkillsDir;
        } else if (configured.has(command)) {
          stdout = MCPPROXY_URL;
        }
        return { stdout, stderr: "" };
      }),
    });

    await syncSharedContext(sandbox.targets, runtime);
    const status = await getSharedContextStatus(sandbox.targets, runtime);

    expect(status.state).toBe("ready");
    expect(status.canonical).toEqual({ promptExists: true, skillsExist: true });
    expect(status.mcpProxyReachable).toBe(true);
    expect(status.providers.map((provider) => provider.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "missing",
    ]);
    expect(status.providers.find((provider) => provider.id === "alpha")).toMatchObject({
      detected: true,
      prompt: "synced",
      skills: "synced",
      mcp: "synced",
    });
    expect(status.providers.find((provider) => provider.id === "missing")).toMatchObject({
      detected: false,
      prompt: "unsupported",
      skills: "unsupported",
      mcp: "unsupported",
    });
  });

  it("seeds from the first installed prompt and projects one source using links", async () => {
    const alpha = sandbox.targets.providers[0];
    const beta = sandbox.targets.providers[1];
    if (!alpha?.promptPath || !beta?.promptPath || beta.skills.kind !== "link") {
      throw new Error("invalid test targets");
    }
    await writeFile(alpha.promptPath, "alpha prompt");
    await writeFile(beta.promptPath, "beta prompt");
    await writeFile(path.join(beta.skills.path, "beta-only", "SKILL.md"), "beta skill");
    await writeFile(
      beta.mcp.configPath,
      JSON.stringify({ mcpServers: { keep: { command: "x" } } }),
    );
    let configured = false;
    const runtime = createRuntime({
      runCommand: vi.fn(async (_command, args) => {
        if (args.includes("add") || args.includes("set")) configured = true;
        if (!configured) throw new Error("not configured");
        return {
          stdout: args[0] === "config" ? sandbox.targets.sharedSkillsDir : MCPPROXY_URL,
          stderr: "",
        };
      }),
    });

    const status = await syncSharedContext(sandbox.targets, runtime);

    expect(status.state).toBe("ready");
    expect(await fs.readFile(sandbox.targets.sharedPromptPath, "utf8")).toBe("alpha prompt");
    expect(await sameFile(sandbox.targets.sharedPromptPath, alpha.promptPath)).toBe(true);
    expect(await sameFile(sandbox.targets.sharedPromptPath, beta.promptPath)).toBe(true);
    expect(await fs.readFile(`${beta.promptPath}.paseo-backup-20260102T030405Z`, "utf8")).toBe(
      "beta prompt",
    );
    expect(
      await fs.readFile(
        path.join(sandbox.targets.sharedSkillsDir, "beta-only", "SKILL.md"),
        "utf8",
      ),
    ).toBe("beta skill");
    expect(await fs.realpath(sandbox.targets.standardSkillsDir)).toBe(
      await fs.realpath(sandbox.targets.sharedSkillsDir),
    );
    expect(await fs.realpath(beta.skills.path)).toBe(
      await fs.realpath(sandbox.targets.sharedSkillsDir),
    );

    const betaConfig = JSON.parse(await fs.readFile(beta.mcp.configPath, "utf8")) as {
      mcpServers: Record<string, { command?: string; url?: string }>;
    };
    expect(betaConfig.mcpServers.keep).toEqual({ command: "x" });
    expect(betaConfig.mcpServers.mcpproxy).toEqual({ url: MCPPROXY_URL });
    expect(
      JSON.parse(await fs.readFile(`${beta.mcp.configPath}.paseo-backup-20260102T030405Z`, "utf8")),
    ).toEqual({ mcpServers: { keep: { command: "x" } } });
  });

  it("marks one drifting installed provider without product-specific fields", async () => {
    const runtime = createRuntime();
    await writeFile(sandbox.targets.sharedPromptPath, "prompt");
    await writeFile(path.join(sandbox.targets.sharedSkillsDir, "shared", "SKILL.md"), "skill");

    const status = await getSharedContextStatus(sandbox.targets, runtime);

    expect(status.state).toBe("drift");
    expect(status.providers[0]).toMatchObject({
      id: "alpha",
      detected: true,
      prompt: "drift",
      skills: "drift",
    });
    expect(status).not.toHaveProperty("prompt.claudeSynced");
    expect(status).not.toHaveProperty("mcp.grokConfigured");
  });

  it("does not require capabilities that an installed client does not expose", async () => {
    sandbox.targets.providers = [
      {
        id: "promptless",
        label: "Promptless AI",
        command: "promptless",
        skills: { kind: "link", path: path.join(sandbox.root, "promptless-skills") },
        mcp: { kind: "json", configPath: path.join(sandbox.root, "promptless-mcp.json") },
      },
    ];
    await writeFile(sandbox.targets.sharedPromptPath, "prompt");
    await writeFile(path.join(sandbox.targets.sharedSkillsDir, "shared", "SKILL.md"), "skill");
    const runtime = createRuntime();

    const status = await syncSharedContext(sandbox.targets, runtime);

    expect(status.state).toBe("ready");
    expect(status.providers[0]).toMatchObject({
      detected: true,
      prompt: "unsupported",
      skills: "synced",
      mcp: "synced",
    });
  });

  it("refuses to invent a canonical prompt when no installed provider has one", async () => {
    await expect(syncSharedContext(sandbox.targets, createRuntime())).rejects.toThrow(
      "No installed provider prompt found",
    );
  });

  it("runs Windows command shims through cmd.exe", () => {
    expect(
      resolveCommandInvocation(
        "win32",
        "codex",
        ["mcp", "get", "mcpproxy"],
        "C:\\Windows\\System32\\cmd.exe",
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "codex", "mcp", "get", "mcpproxy"],
    });
  });

  it("recognizes CLI status written to stderr", async () => {
    sandbox.targets.providers = [
      {
        id: "stderr-ai",
        label: "Stderr AI",
        command: "stderr-ai",
        mcp: {
          kind: "command",
          checkArgs: ["mcp", "list"],
          addArgs: ["mcp", "add", "mcpproxy", MCPPROXY_URL],
        },
      },
    ];
    await writeFile(sandbox.targets.sharedPromptPath, "prompt");
    await fs.mkdir(sandbox.targets.sharedSkillsDir, { recursive: true });
    const runtime = createRuntime({
      runCommand: vi.fn(async () => ({ stdout: "", stderr: `mcpproxy ${MCPPROXY_URL}` })),
    });

    const status = await getSharedContextStatus(sandbox.targets, runtime);

    expect(status.state).toBe("ready");
    expect(status.providers[0]?.mcp).toBe("synced");
  });
});
