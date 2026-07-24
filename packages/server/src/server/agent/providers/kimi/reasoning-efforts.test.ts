import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import {
  enrichKimiConfigOptions,
  readKimiModelEffortSupport,
  readKimiThinkingConfig,
  writeKimiThinkingEffort,
} from "./reasoning-efforts.js";

function writeConfig(root: string, body: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.toml"), body, "utf8");
}

const SAMPLE_CONFIG = `
default_model = "kimi-code/k3"

[thinking]
enabled = true
effort = "high"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "tool_use" ]
display_name = "K2.7 Coding"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "tool_use" ]
display_name = "K3"
support_efforts = [ "low", "high", "max" ]
default_effort = "high"
`;

describe("readKimiThinkingConfig", () => {
  test("reads effort from [thinking]", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-effort-cfg-"));
    writeConfig(root, SAMPLE_CONFIG);
    expect(readKimiThinkingConfig(root)).toEqual({ enabled: true, effort: "high" });
  });
});

describe("readKimiModelEffortSupport", () => {
  test("parses support_efforts for k3", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-effort-model-"));
    writeConfig(root, SAMPLE_CONFIG);
    expect(readKimiModelEffortSupport(root, "kimi-code/k3")).toEqual({
      modelAlias: "kimi-code/k3",
      supportEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      hasThinkingCapability: true,
    });
  });

  test("models without support_efforts still mark thinking capability", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-effort-fixed-"));
    writeConfig(root, SAMPLE_CONFIG);
    const support = readKimiModelEffortSupport(root, "kimi-code/kimi-for-coding");
    expect(support?.supportEfforts).toEqual([]);
    expect(support?.hasThinkingCapability).toBe(true);
  });
});

describe("writeKimiThinkingEffort", () => {
  test("rewrites effort in place", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-effort-write-"));
    writeConfig(root, SAMPLE_CONFIG);
    writeKimiThinkingEffort(root, "max");
    const text = readFileSync(join(root, "config.toml"), "utf8");
    expect(text).toMatch(/\[thinking\][\s\S]*effort = "max"/);
    expect(readKimiThinkingConfig(root).effort).toBe("max");
  });
});

describe("enrichKimiConfigOptions", () => {
  const baseThinking: SessionConfigOption = {
    type: "select",
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    currentValue: "on",
    options: [{ value: "on", name: "Thinking On" }],
  };

  test("expands multi-level efforts for k3 and uses config effort", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-effort-enrich-"));
    writeConfig(root, SAMPLE_CONFIG);
    const options: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "kimi-code/k3",
        options: [{ value: "kimi-code/k3", name: "K3" }],
      },
      baseThinking,
    ];
    const enriched = enrichKimiConfigOptions(options, { kimiHome: root });
    const thinking = enriched.find((entry) => entry.id === "thinking") as Extract<
      SessionConfigOption,
      { type: "select" }
    >;
    expect(thinking.currentValue).toBe("high");
    expect(thinking.options.map((o) => ("value" in o ? o.value : null))).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  test("keeps on for fixed-depth models", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-effort-on-"));
    writeConfig(root, SAMPLE_CONFIG);
    const options: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "kimi-code/kimi-for-coding",
        options: [{ value: "kimi-code/kimi-for-coding", name: "K2.7" }],
      },
      baseThinking,
    ];
    const enriched = enrichKimiConfigOptions(options, { kimiHome: root });
    const thinking = enriched.find((entry) => entry.id === "thinking") as Extract<
      SessionConfigOption,
      { type: "select" }
    >;
    expect(thinking.currentValue).toBe("on");
    expect(thinking.options).toEqual([{ value: "on", name: "Thinking On" }]);
  });
});
