import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  createKimiContextUsageResolver,
  findKimiSessionDir,
  readKimiModelContextWindow,
  readKimiWireUsage,
  resolveKimiContextUsageFromDisk,
} from "./session-context.js";

function usageRecordLine(model: string, total: { other: number; output: number; cacheRead: number; cacheCreate: number }): string {
  return (
    JSON.stringify({
      type: "usage.record",
      model,
      usage: {
        inputOther: total.other,
        output: total.output,
        inputCacheRead: total.cacheRead,
        inputCacheCreation: total.cacheCreate,
      },
      usageScope: "turn",
      time: 1784562967337,
    }) + "\n"
  );
}

function makeSessionDir(root: string, sessionId: string, cwdKey = "wd_workspace_abcdef123456"): string {
  const sessionDir = join(root, "sessions", cwdKey, sessionId);
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  return sessionDir;
}

describe("findKimiSessionDir", () => {
  test("finds a session under any cwd bucket", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-session-ctx-"));
    const sessionDir = makeSessionDir(root, "session_abc-123");
    writeFileSync(join(sessionDir, "agents", "main", "wire.jsonl"), "", "utf8");

    expect(findKimiSessionDir(root, "session_abc-123")).toBe(sessionDir);
    expect(findKimiSessionDir(root, "session_missing")).toBeNull();
  });

  test("rejects path-like session ids", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-session-ctx-safe-"));
    expect(findKimiSessionDir(root, "..")).toBeNull();
    expect(findKimiSessionDir(root, "../escape")).toBeNull();
  });
});

describe("readKimiWireUsage", () => {
  test("sums the components of the LAST usage.record", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-wire-"));
    const sessionDir = makeSessionDir(root, "session_a");
    writeFileSync(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      JSON.stringify({ type: "metadata" }) +
        "\n" +
        usageRecordLine("kimi-code/k3", { other: 100, output: 50, cacheRead: 1000, cacheCreate: 10 }) +
        JSON.stringify({ type: "llm.request", model: "k3", modelAlias: "kimi-code/k3" }) +
        "\n" +
        usageRecordLine("kimi-code/k3", { other: 200, output: 80, cacheRead: 2000, cacheCreate: 0 }),
      "utf8",
    );

    expect(readKimiWireUsage(sessionDir)).toEqual({
      contextTokensUsed: 2280,
      modelAlias: "kimi-code/k3",
    });
  });

  test("skips zero-total records (provider reported no usage)", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-wire-zero-"));
    const sessionDir = makeSessionDir(root, "session_b");
    writeFileSync(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      usageRecordLine("kimi-code/k3", { other: 661, output: 1109, cacheRead: 236288, cacheCreate: 0 }) +
        usageRecordLine("kimi-code/k3", { other: 0, output: 0, cacheRead: 0, cacheCreate: 0 }),
      "utf8",
    );

    expect(readKimiWireUsage(sessionDir)).toEqual({
      contextTokensUsed: 238058,
      modelAlias: "kimi-code/k3",
    });
  });

  test("returns null without any usage.record", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-wire-empty-"));
    const sessionDir = makeSessionDir(root, "session_c");
    writeFileSync(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      JSON.stringify({ type: "metadata" }) + "\n",
      "utf8",
    );
    expect(readKimiWireUsage(sessionDir)).toBeNull();
  });
});

describe("readKimiModelContextWindow", () => {
  test("reads max_context_size from the model's config.toml section", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-config-"));
    writeFileSync(
      join(root, "config.toml"),
      [
        '[models."kimi-code/kimi-for-coding"]',
        'provider = "managed:kimi-code"',
        "max_context_size = 262144",
        "",
        '[models."kimi-code/k3"]',
        'provider = "managed:kimi-code"',
        "max_context_size = 1048576",
        'support_efforts = [ "low", "high", "max" ]',
        "",
      ].join("\n"),
      "utf8",
    );

    expect(readKimiModelContextWindow(root, "kimi-code/k3")).toBe(1048576);
    expect(readKimiModelContextWindow(root, "kimi-code/kimi-for-coding")).toBe(262144);
    expect(readKimiModelContextWindow(root, "kimi-code/missing")).toBeNull();
  });
});

describe("resolveKimiContextUsageFromDisk", () => {
  test("combines wire.jsonl usage with config.toml context window", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-usage-disk-"));
    writeFileSync(
      join(root, "config.toml"),
      '[models."kimi-code/k3"]\nmax_context_size = 1048576\n',
      "utf8",
    );
    const sessionDir = makeSessionDir(root, "session_x");
    writeFileSync(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      usageRecordLine("kimi-code/k3", { other: 661, output: 1109, cacheRead: 236288, cacheCreate: 0 }),
      "utf8",
    );

    expect(resolveKimiContextUsageFromDisk({ sessionId: "session_x", kimiHome: root })).toEqual({
      contextWindowUsedTokens: 238058,
      contextWindowMaxTokens: 1048576,
    });
  });

  test("returns undefined when the model's context window is unknown", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-usage-nosize-"));
    writeFileSync(join(root, "config.toml"), "", "utf8");
    const sessionDir = makeSessionDir(root, "session_y");
    writeFileSync(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      usageRecordLine("kimi-code/k3", { other: 1, output: 1, cacheRead: 1, cacheCreate: 1 }),
      "utf8",
    );

    expect(
      resolveKimiContextUsageFromDisk({ sessionId: "session_y", kimiHome: root }),
    ).toBeUndefined();
  });
});

describe("createKimiContextUsageResolver", () => {
  test("initial usage reads from disk (resumed sessions)", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-resolver-init-"));
    writeFileSync(
      join(root, "config.toml"),
      '[models."kimi-code/k3"]\nmax_context_size = 1048576\n',
      "utf8",
    );
    const sessionDir = makeSessionDir(root, "session_z");
    writeFileSync(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      usageRecordLine("kimi-code/k3", { other: 10, output: 10, cacheRead: 1000, cacheCreate: 0 }),
      "utf8",
    );

    const resolver = createKimiContextUsageResolver({ kimiHome: root });
    expect(resolver.resolveInitialUsage?.("session_z")).toEqual({
      contextWindowUsedTokens: 1020,
      contextWindowMaxTokens: 1048576,
    });
  });

  test("notification usage re-reads after the wire file grows (throttled)", () => {
    const root = mkdtempSync(join(tmpdir(), "kimi-resolver-notify-"));
    writeFileSync(
      join(root, "config.toml"),
      '[models."kimi-code/k3"]\nmax_context_size = 1048576\n',
      "utf8",
    );
    const sessionDir = makeSessionDir(root, "session_n");
    const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
    writeFileSync(
      wirePath,
      usageRecordLine("kimi-code/k3", { other: 10, output: 10, cacheRead: 1000, cacheCreate: 0 }),
      "utf8",
    );

    let now = 1_000;
    const resolver = createKimiContextUsageResolver({ kimiHome: root, nowFn: () => now });
    const notification = {
      sessionId: "session_n",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      },
    } as Parameters<NonNullable<typeof resolver.resolveNotificationUsage>>[0];

    expect(resolver.resolveNotificationUsage?.(notification, undefined)).toEqual({
      contextWindowUsedTokens: 1020,
      contextWindowMaxTokens: 1048576,
    });

    // Same file state → no re-read, no update.
    expect(
      resolver.resolveNotificationUsage?.(notification, {
        contextWindowUsedTokens: 1020,
        contextWindowMaxTokens: 1048576,
      }),
    ).toBeUndefined();

    // File grew within the throttle window → still no re-read.
    appendFileSync(
      wirePath,
      usageRecordLine("kimi-code/k3", { other: 20, output: 20, cacheRead: 2000, cacheCreate: 0 }),
      "utf8",
    );
    expect(resolver.resolveNotificationUsage?.(notification, undefined)).toBeUndefined();

    // Throttle elapsed + file grew → fresh usage.
    now += 1_000;
    expect(resolver.resolveNotificationUsage?.(notification, undefined)).toEqual({
      contextWindowUsedTokens: 2040,
      contextWindowMaxTokens: 1048576,
    });
  });
});
