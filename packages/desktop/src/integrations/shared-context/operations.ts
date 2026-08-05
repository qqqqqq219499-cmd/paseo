import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSharedContextTargets } from "./paths.js";

export const MCPPROXY_URL = "http://127.0.0.1:8933/mcp/";
const MCPPROXY_HEALTH_URL = "http://127.0.0.1:8933/healthz";
const IGNORED_SKILL_NAMES = new Set([".system"]);
const execFileAsync = promisify(execFile);

export type SharedContextState = "not-configured" | "drift" | "ready";
export type SharedContextCapabilityState = "synced" | "drift" | "unsupported";

interface LinkSkillsTarget {
  kind: "link";
  path: string;
}

interface CommandSkillsTarget {
  kind: "command";
  checkArgs: string[];
  addArgs: string[];
  configPath?: string;
}

interface CommandMcpTarget {
  kind: "command";
  checkArgs: string[];
  addArgs: string[];
  configPath?: string;
}

interface JsonMcpTarget {
  kind: "json";
  configPath: string;
}

export interface SharedContextProviderTarget {
  id: string;
  label: string;
  command: string;
  promptPath?: string;
  skills?: LinkSkillsTarget | CommandSkillsTarget;
  mcp?: CommandMcpTarget | JsonMcpTarget;
}

export interface SharedContextTargets {
  sharedPromptPath: string;
  sharedSkillsDir: string;
  standardSkillsDir: string;
  providers: SharedContextProviderTarget[];
}

export interface SharedContextProviderStatus {
  id: string;
  label: string;
  detected: boolean;
  prompt: SharedContextCapabilityState;
  skills: SharedContextCapabilityState;
  mcp: SharedContextCapabilityState;
}

export interface SharedContextStatus {
  state: SharedContextState;
  canonical: {
    promptExists: boolean;
    skillsExist: boolean;
  };
  mcpProxyReachable: boolean;
  providers: SharedContextProviderStatus[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface SharedContextRuntime {
  now: () => Date;
  probeMcpProxy: () => Promise<boolean>;
  isCommandAvailable: (command: string) => Promise<boolean>;
  runCommand: (command: string, args: string[]) => Promise<CommandResult>;
}

export function resolveCommandInvocation(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
  comSpec = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: comSpec, args: ["/d", "/s", "/c", command, ...args] }
    : { command, args };
}

async function executeCommand(
  command: string,
  args: string[],
  timeout: number,
): Promise<CommandResult> {
  const invocation = resolveCommandInvocation(process.platform, command, args);
  const result = await execFileAsync(invocation.command, invocation.args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

const defaultRuntime: SharedContextRuntime = {
  now: () => new Date(),
  probeMcpProxy: async () => {
    try {
      const response = await fetch(MCPPROXY_HEALTH_URL, { signal: AbortSignal.timeout(3_000) });
      return response.ok;
    } catch {
      return false;
    }
  },
  isCommandAvailable: async (command) => {
    try {
      await executeCommand(command, ["--version"], 10_000);
      return true;
    } catch {
      return false;
    }
  },
  runCommand: (command, args) => executeCommand(command, args, 20_000),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function directoryExists(dirPath: string): Promise<boolean> {
  return fs
    .stat(dirPath)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

async function pathsPointToSameFile(leftPath: string, rightPath: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    fs.stat(leftPath).catch(() => null),
    fs.stat(rightPath).catch(() => null),
  ]);
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

async function pathsPointToSameDirectory(leftPath: string, rightPath: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    fs.realpath(leftPath).catch(() => null),
    fs.realpath(rightPath).catch(() => null),
  ]);
  if (left === null || right === null) return false;
  return process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}

function outputIncludes(output: string, expected: string): boolean {
  return process.platform === "win32"
    ? output.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
    : output.includes(expected);
}

async function commandIncludes(
  runtime: SharedContextRuntime,
  command: string,
  args: string[],
  expected: string,
): Promise<boolean> {
  try {
    const result = await runtime.runCommand(command, args);
    return outputIncludes(`${result.stdout}\n${result.stderr}`, expected);
  } catch {
    return false;
  }
}

async function jsonMcpConfigured(configPath: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return false;
    const proxy = parsed.mcpServers.mcpproxy;
    return isRecord(proxy) && proxy.url === MCPPROXY_URL;
  } catch {
    return false;
  }
}

async function getProviderStatus(
  target: SharedContextProviderTarget,
  detected: boolean,
  targets: SharedContextTargets,
  runtime: SharedContextRuntime,
): Promise<SharedContextProviderStatus> {
  if (!detected) {
    return {
      id: target.id,
      label: target.label,
      detected: false,
      prompt: "unsupported",
      skills: "unsupported",
      mcp: "unsupported",
    };
  }

  let prompt: SharedContextCapabilityState = "unsupported";
  if (target.promptPath) {
    prompt = (await pathsPointToSameFile(targets.sharedPromptPath, target.promptPath))
      ? "synced"
      : "drift";
  }
  let skills: SharedContextCapabilityState = "unsupported";
  if (target.skills?.kind === "link") {
    skills = (await pathsPointToSameDirectory(targets.sharedSkillsDir, target.skills.path))
      ? "synced"
      : "drift";
  } else if (target.skills?.kind === "command") {
    skills = (await commandIncludes(
      runtime,
      target.command,
      target.skills.checkArgs,
      targets.sharedSkillsDir,
    ))
      ? "synced"
      : "drift";
  }

  let mcp: SharedContextCapabilityState = "unsupported";
  if (target.mcp?.kind === "command") {
    mcp = (await commandIncludes(
      runtime,
      target.command,
      target.mcp.checkArgs,
      MCPPROXY_URL.replace(/\/$/, ""),
    ))
      ? "synced"
      : "drift";
  } else if (target.mcp?.kind === "json") {
    mcp = (await jsonMcpConfigured(target.mcp.configPath)) ? "synced" : "drift";
  }

  return { id: target.id, label: target.label, detected, prompt, skills, mcp };
}

async function detectProviders(
  targets: SharedContextTargets,
  runtime: SharedContextRuntime,
): Promise<boolean[]> {
  return Promise.all(
    targets.providers.map((provider) => runtime.isCommandAvailable(provider.command)),
  );
}

export async function getSharedContextStatus(
  targets = resolveSharedContextTargets(),
  runtime = defaultRuntime,
): Promise<SharedContextStatus> {
  const [promptExists, skillsExist, mcpProxyReachable, detected] = await Promise.all([
    fileExists(targets.sharedPromptPath),
    directoryExists(targets.sharedSkillsDir),
    runtime.probeMcpProxy(),
    detectProviders(targets, runtime),
  ]);
  const providers = await Promise.all(
    targets.providers.map((provider, index) =>
      getProviderStatus(provider, detected[index] === true, targets, runtime),
    ),
  );
  const hasDrift = providers.some(
    (provider) =>
      provider.detected &&
      (provider.prompt === "drift" || provider.skills === "drift" || provider.mcp === "drift"),
  );

  let state: SharedContextState = "drift";
  if (!promptExists && !skillsExist) {
    state = "not-configured";
  } else if (promptExists && skillsExist && mcpProxyReachable && !hasDrift) {
    state = "ready";
  }
  return {
    state,
    canonical: { promptExists, skillsExist },
    mcpProxyReachable,
    providers,
  };
}

function backupSuffix(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".000", "");
}

async function backupFileOnce(
  filePath: string | undefined,
  runtime: SharedContextRuntime,
  backedUp: Set<string>,
): Promise<void> {
  if (!filePath || backedUp.has(filePath) || !(await fileExists(filePath))) return;
  await fs.copyFile(filePath, `${filePath}.paseo-backup-${backupSuffix(runtime.now())}`);
  backedUp.add(filePath);
}

async function seedCanonicalPrompt(
  targets: SharedContextTargets,
  detected: boolean[],
): Promise<void> {
  if (await fileExists(targets.sharedPromptPath)) return;
  for (const [index, provider] of targets.providers.entries()) {
    if (!detected[index] || !provider.promptPath) continue;
    const prompt = await fs.readFile(provider.promptPath).catch(() => null);
    if (!prompt) continue;
    await fs.mkdir(path.dirname(targets.sharedPromptPath), { recursive: true });
    await fs.writeFile(targets.sharedPromptPath, prompt);
    return;
  }
  throw new Error("No installed provider prompt found to seed the shared context.");
}

async function linkPrompt(
  sourcePath: string,
  targetPath: string,
  runtime: SharedContextRuntime,
  backedUp: Set<string>,
): Promise<void> {
  if (await pathsPointToSameFile(sourcePath, targetPath)) return;
  await backupFileOnce(targetPath, runtime, backedUp);
  await fs.rm(targetPath, { force: true });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.link(sourcePath, targetPath);
}

async function mergeProviderOnlySkills(sourceDir: string, targetDir: string): Promise<void> {
  if (
    !(await directoryExists(targetDir)) ||
    (await pathsPointToSameDirectory(sourceDir, targetDir))
  ) {
    return;
  }
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_SKILL_NAMES.has(entry.name)) continue;
    const destination = path.join(sourceDir, entry.name);
    if (await directoryExists(destination)) continue;
    await fs.cp(path.join(targetDir, entry.name), destination, { recursive: true });
  }
}

async function linkSkillsDirectory(
  sourceDir: string,
  targetDir: string,
  runtime: SharedContextRuntime,
): Promise<void> {
  if (await pathsPointToSameDirectory(sourceDir, targetDir)) return;
  await mergeProviderOnlySkills(sourceDir, targetDir);
  const targetExists = await fs.lstat(targetDir).catch(() => null);
  if (targetExists) {
    await fs.rename(targetDir, `${targetDir}.paseo-backup-${backupSuffix(runtime.now())}`);
  }
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.symlink(sourceDir, targetDir, process.platform === "win32" ? "junction" : "dir");
}

async function ensureCanonicalSkills(
  targets: SharedContextTargets,
  detected: boolean[],
): Promise<void> {
  await fs.mkdir(targets.sharedSkillsDir, { recursive: true });
  for (const [index, provider] of targets.providers.entries()) {
    if (!detected[index] || provider.skills?.kind !== "link") continue;
    await mergeProviderOnlySkills(targets.sharedSkillsDir, provider.skills.path);
  }
}

async function configureJsonMcp(
  configPath: string,
  runtime: SharedContextRuntime,
  backedUp: Set<string>,
): Promise<void> {
  if (await jsonMcpConfigured(configPath)) return;
  let parsed: Record<string, unknown> = {};
  if (await fileExists(configPath)) {
    const raw: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!isRecord(raw)) throw new Error(`Expected an object in ${configPath}`);
    parsed = raw;
  }
  const existingServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  await backupFileOnce(configPath, runtime, backedUp);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      { ...parsed, mcpServers: { ...existingServers, mcpproxy: { url: MCPPROXY_URL } } },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function syncProvider(
  provider: SharedContextProviderTarget,
  targets: SharedContextTargets,
  runtime: SharedContextRuntime,
  backedUp: Set<string>,
): Promise<void> {
  if (provider.promptPath) {
    await linkPrompt(targets.sharedPromptPath, provider.promptPath, runtime, backedUp);
  }
  if (provider.skills?.kind === "link") {
    await linkSkillsDirectory(targets.sharedSkillsDir, provider.skills.path, runtime);
  } else if (
    provider.skills?.kind === "command" &&
    !(await commandIncludes(
      runtime,
      provider.command,
      provider.skills.checkArgs,
      targets.sharedSkillsDir,
    ))
  ) {
    await backupFileOnce(provider.skills.configPath, runtime, backedUp);
    await runtime.runCommand(provider.command, provider.skills.addArgs);
  }

  if (provider.mcp?.kind === "json") {
    await configureJsonMcp(provider.mcp.configPath, runtime, backedUp);
  } else if (
    provider.mcp?.kind === "command" &&
    !(await commandIncludes(
      runtime,
      provider.command,
      provider.mcp.checkArgs,
      MCPPROXY_URL.replace(/\/$/, ""),
    ))
  ) {
    await backupFileOnce(provider.mcp.configPath, runtime, backedUp);
    await runtime.runCommand(provider.command, provider.mcp.addArgs);
  }
}

export async function syncSharedContext(
  targets = resolveSharedContextTargets(),
  runtime = defaultRuntime,
): Promise<SharedContextStatus> {
  const detected = await detectProviders(targets, runtime);
  await seedCanonicalPrompt(targets, detected);
  await ensureCanonicalSkills(targets, detected);
  await linkSkillsDirectory(targets.sharedSkillsDir, targets.standardSkillsDir, runtime);
  const backedUp = new Set<string>();
  for (const [index, provider] of targets.providers.entries()) {
    if (!detected[index]) continue;
    await syncProvider(provider, targets, runtime, backedUp);
  }
  return getSharedContextStatus(targets, runtime);
}
