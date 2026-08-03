import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import {
  parseClusterWorkerToml,
  parseTomlWorkerProvider,
  readOrchestrationPreferences,
  readTomlWorkerProvider,
  resolveClusterWorkerProfile,
  resolveWorkerProvider,
} from "./preferences.js";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "cluster-preferences-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reads role -> provider mapping from orchestration-preferences.json", async () => {
  await withTempDir(async (root) => {
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "orchestration-preferences.json"),
      JSON.stringify({
        providers: {
          impl: "opencode/opencode-go/deepseek-v4-flash",
          ui: "opencode/opencode-go/deepseek-v4-flash",
        },
      }),
      "utf8",
    );

    expect(await resolveWorkerProvider("impl", { paseoHome })).toBe(
      "opencode/opencode-go/deepseek-v4-flash",
    );
    expect(await resolveWorkerProvider("ui", { paseoHome })).toBe(
      "opencode/opencode-go/deepseek-v4-flash",
    );
  });
});

test("trims whitespace around providers", async () => {
  await withTempDir(async (root) => {
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "orchestration-preferences.json"),
      JSON.stringify({ providers: { research: "  grok/grok-4.5  " } }),
      "utf8",
    );

    expect(await resolveWorkerProvider("research", { paseoHome })).toBe("grok/grok-4.5");
  });
});

test("falls back to [worker].provider in cluster-worker.toml when JSON misses the role", async () => {
  await withTempDir(async (root) => {
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "orchestration-preferences.json"),
      JSON.stringify({ providers: { impl: "opencode/opencode-go/deepseek-v4-flash" } }),
      "utf8",
    );
    const workerTomlPath = path.join(root, "cluster-worker.toml");
    await writeFile(
      workerTomlPath,
      ["[worker]", 'provider = "grok/grok-4.5"', ""].join("\n"),
      "utf8",
    );

    expect(await resolveWorkerProvider("audit", { paseoHome, workerTomlPath })).toBe(
      "grok/grok-4.5",
    );
  });
});

test("falls back to TOML when the JSON file is missing", async () => {
  await withTempDir(async (root) => {
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    const workerTomlPath = path.join(root, "cluster-worker.toml");
    await writeFile(
      workerTomlPath,
      ["[worker]", 'provider = "grok/grok-4.5"', ""].join("\n"),
      "utf8",
    );

    expect(await resolveWorkerProvider("impl", { paseoHome, workerTomlPath })).toBe(
      "grok/grok-4.5",
    );
  });
});

test("returns null when neither source is configured", async () => {
  await withTempDir(async (root) => {
    expect(
      await resolveWorkerProvider("impl", {
        paseoHome: path.join(root, ".paseo"),
        workerTomlPath: path.join(root, "missing.toml"),
      }),
    ).toBeNull();
  });
});

test("returns null for unreadable JSON without throwing", async () => {
  await withTempDir(async (root) => {
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    await writeFile(path.join(paseoHome, "orchestration-preferences.json"), "{ not json", "utf8");

    expect(await readOrchestrationPreferences(paseoHome)).toBeNull();
  });
});

test("parseTomlWorkerProvider ignores comments and other sections", () => {
  const toml = [
    "# comment",
    "",
    "[candidates.grok-server]",
    'provider = "grok-server/api/grok-4.5"',
    "",
    "[worker]",
    'provider = "grok/grok-4.5"',
    'mode = "bypassPermissions"',
    "auto_archive = true",
    "",
    "[candidates.kimi-k3]",
    'provider = "kimi/kimi-code/k3"',
  ].join("\n");

  expect(parseTomlWorkerProvider(toml)).toBe("grok/grok-4.5");
});

test("parseTomlWorkerProvider returns null when [worker] is absent", () => {
  expect(
    parseTomlWorkerProvider('[candidates.grok-native]\nprovider = "grok/grok-4.5"'),
  ).toBeNull();
});

test("readTomlWorkerProvider returns null for a missing file", async () => {
  await withTempDir(async (root) => {
    expect(await readTomlWorkerProvider(path.join(root, "missing.toml"))).toBeNull();
  });
});

test("TOML [roles.<role>] overrides [worker] for the same fields", async () => {
  await withTempDir(async (root) => {
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    const workerTomlPath = path.join(root, "cluster-worker.toml");
    await writeFile(
      workerTomlPath,
      [
        "[worker]",
        'provider = "opencode/opencode-go/deepseek-v4-flash"',
        'mode = "full-access"',
        'thinking = "max"',
        "auto_archive = true",
        "",
        "[roles.research]",
        'provider = "grok/grok-4.5"',
        'mode = "bypassPermissions"',
        'thinking = "high"',
        "auto_archive = false",
      ].join("\n"),
      "utf8",
    );

    const research = await resolveClusterWorkerProfile("research", { paseoHome, workerTomlPath });
    expect(research).toEqual({
      provider: "grok/grok-4.5",
      mode: "bypassPermissions",
      thinking: "high",
      autoArchive: false,
    });

    const impl = await resolveClusterWorkerProfile("impl", { paseoHome, workerTomlPath });
    expect(impl).toEqual({
      provider: "opencode/opencode-go/deepseek-v4-flash",
      mode: "full-access",
      thinking: "max",
      autoArchive: true,
    });
  });
});

test("JSON providers[role] different from TOML drops mode/thinking but keeps autoArchive", async () => {
  await withTempDir(async (root) => {
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "orchestration-preferences.json"),
      JSON.stringify({ providers: { impl: "opencode/custom/impl-model" } }),
      "utf8",
    );
    const workerTomlPath = path.join(root, "cluster-worker.toml");
    await writeFile(
      workerTomlPath,
      [
        "[worker]",
        'provider = "opencode/opencode-go/deepseek-v4-flash"',
        'mode = "full-access"',
        'thinking = "max"',
        "auto_archive = true",
        "",
        "[roles.impl]",
        'provider = "grok/grok-4.5"',
        'mode = "bypassPermissions"',
        'thinking = "high"',
      ].join("\n"),
      "utf8",
    );

    const profile = await resolveClusterWorkerProfile("impl", { paseoHome, workerTomlPath });
    expect(profile?.provider).toBe("opencode/custom/impl-model");
    expect(profile?.mode).toBeUndefined();
    expect(profile?.thinking).toBeUndefined();
    expect(profile?.autoArchive).toBe(true);
  });
});

test("JSON providers[role] same as TOML keeps mode/thinking/autoArchive", async () => {
  await withTempDir(async (root) => {
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "orchestration-preferences.json"),
      JSON.stringify({ providers: { impl: "grok/grok-4.5" } }),
      "utf8",
    );
    const workerTomlPath = path.join(root, "cluster-worker.toml");
    await writeFile(
      workerTomlPath,
      [
        "[roles.impl]",
        'provider = "grok/grok-4.5"',
        'mode = "bypassPermissions"',
        'thinking = "high"',
        "auto_archive = false",
      ].join("\n"),
      "utf8",
    );

    const profile = await resolveClusterWorkerProfile("impl", { paseoHome, workerTomlPath });
    expect(profile).toEqual({
      provider: "grok/grok-4.5",
      mode: "bypassPermissions",
      thinking: "high",
      autoArchive: false,
    });
  });
});

test("parseClusterWorkerToml reads mode, thinking, auto_archive from worker and roles", () => {
  const parsed = parseClusterWorkerToml(
    [
      "[worker]",
      'provider = "opencode/opencode-go/deepseek-v4-flash"',
      'mode = "full-access"',
      'thinking = "max"',
      "auto_archive = true",
      "",
      "[roles.audit]",
      'provider = "grok/grok-4.5"',
      'mode = "bypassPermissions"',
      'thinking = "high"',
      "auto_archive = false",
    ].join("\n"),
  );

  expect(parsed.worker).toEqual({
    provider: "opencode/opencode-go/deepseek-v4-flash",
    mode: "full-access",
    thinking: "max",
    autoArchive: true,
  });
  expect(parsed.roles.audit).toEqual({
    provider: "grok/grok-4.5",
    mode: "bypassPermissions",
    thinking: "high",
    autoArchive: false,
  });
});
