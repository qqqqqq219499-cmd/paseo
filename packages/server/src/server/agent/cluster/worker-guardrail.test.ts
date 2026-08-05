import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CLUSTER_MODE_LABEL, CLUSTER_MODE_ON_VALUE } from "@getpaseo/protocol/agent-labels";
import {
  ClusterWorkerProviderNotAllowedError,
  assertClusterWorkerProviderAllowed,
  readAllowedWorkerProviderIds,
} from "./worker-guardrail.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Write a cluster-worker.toml with the given body and return its path. */
function writeToml(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-guardrail-"));
  tempDirs.push(dir);
  const tomlPath = path.join(dir, "cluster-worker.toml");
  writeFileSync(tomlPath, body, "utf8");
  return tomlPath;
}

const SAMPLE_TOML = `
[worker]
provider = "opencode/opencode-go/deepseek-v4-flash"
mode = "full-access"

[roles.research]
provider = "grok/grok-4.5"

[candidates.grok-server]
provider = "grok-server/api/grok-4.5"
`;

const CLUSTER_ON_LABELS = { [CLUSTER_MODE_LABEL]: CLUSTER_MODE_ON_VALUE };

describe("readAllowedWorkerProviderIds", () => {
  it("collects provider ids (before the first slash) across all sections", async () => {
    const allowed = await readAllowedWorkerProviderIds(writeToml(SAMPLE_TOML));
    expect(allowed).not.toBeNull();
    expect([...allowed!].sort()).toEqual(["grok", "grok-server", "opencode"]);
  });

  it("returns null when the file is missing (no policy = allow anything)", async () => {
    const missing = path.join(tmpdir(), "paseo-guardrail-does-not-exist", "cluster-worker.toml");
    expect(await readAllowedWorkerProviderIds(missing)).toBeNull();
  });

  it("returns null when the file has no provider lines", async () => {
    expect(await readAllowedWorkerProviderIds(writeToml("# just a comment\n"))).toBeNull();
  });
});

describe("assertClusterWorkerProviderAllowed", () => {
  it("rejects a same-tier (claude) worker when a cluster CEO delegates", async () => {
    const tomlPath = writeToml(SAMPLE_TOML);
    await expect(
      assertClusterWorkerProviderAllowed({
        requestedProvider: "claude/claude-opus-4-8",
        parentLabels: CLUSTER_ON_LABELS,
        tomlPath,
      }),
    ).rejects.toBeInstanceOf(ClusterWorkerProviderNotAllowedError);
  });

  it("allows a configured worker provider (opencode multi-segment)", async () => {
    const tomlPath = writeToml(SAMPLE_TOML);
    await expect(
      assertClusterWorkerProviderAllowed({
        requestedProvider: "opencode/opencode-go/deepseek-v4-flash",
        parentLabels: CLUSTER_ON_LABELS,
        tomlPath,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows grok workers for research", async () => {
    const tomlPath = writeToml(SAMPLE_TOML);
    await expect(
      assertClusterWorkerProviderAllowed({
        requestedProvider: "grok/grok-4.5",
        parentLabels: CLUSTER_ON_LABELS,
        tomlPath,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not gate when the parent is not in cluster mode", async () => {
    const tomlPath = writeToml(SAMPLE_TOML);
    await expect(
      assertClusterWorkerProviderAllowed({
        requestedProvider: "claude/claude-opus-4-8",
        parentLabels: {},
        tomlPath,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not gate when there is no parent (human-created agent)", async () => {
    const tomlPath = writeToml(SAMPLE_TOML);
    await expect(
      assertClusterWorkerProviderAllowed({
        requestedProvider: "claude/claude-opus-4-8",
        parentLabels: null,
        tomlPath,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows anything when no worker policy is configured (stock host)", async () => {
    const missing = path.join(tmpdir(), "paseo-guardrail-none", "cluster-worker.toml");
    await expect(
      assertClusterWorkerProviderAllowed({
        requestedProvider: "claude/claude-opus-4-8",
        parentLabels: CLUSTER_ON_LABELS,
        tomlPath: missing,
      }),
    ).resolves.toBeUndefined();
  });
});
