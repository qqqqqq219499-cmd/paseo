import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  createGrokContextUsageResolver,
  findGrokSessionDir,
  readGrokSignalsContext,
  resolveGrokContextUsageFromNotification,
  resolveGrokContextUsageFromDisk,
} from "./session-context.js";

describe("resolveGrokContextUsageFromNotification", () => {
  test("reads notification-level totalTokens used by Grok CLI", () => {
    expect(
      resolveGrokContextUsageFromNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
        _meta: { totalTokens: 28_000 },
      }),
    ).toEqual({
      contextWindowUsedTokens: 28_000,
      contextWindowMaxTokens: 500_000,
    });
  });

  test("accepts nested update metadata from older fixtures", () => {
    expect(
      resolveGrokContextUsageFromNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
          _meta: { totalTokens: 61_695 },
        },
      }),
    ).toEqual({
      contextWindowUsedTokens: 61_695,
      contextWindowMaxTokens: 500_000,
    });
  });
});

describe("findGrokSessionDir", () => {
  test("finds a session under any cwd key", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-session-ctx-"));
    const cwdKey = "E%3A%5Cpaseo";
    const sessionId = "019f5d18-e221-7fc2-b27f-8a0f68a71346";
    const sessionDir = join(root, "sessions", cwdKey, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "summary.json"), "{}\n", "utf8");

    expect(findGrokSessionDir(root, sessionId)).toBe(sessionDir);
    expect(findGrokSessionDir(root, "missing")).toBeNull();
  });
});

describe("readGrokSignalsContext", () => {
  test("reads used/max tokens from signals.json", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-signals-"));
    writeFileSync(
      join(root, "signals.json"),
      JSON.stringify({
        contextTokensUsed: 28_000,
        contextWindowTokens: 500_000,
      }),
      "utf8",
    );

    expect(readGrokSignalsContext(root)).toEqual({
      contextTokensUsed: 28_000,
      contextWindowTokens: 500_000,
    });
  });

  test("rejects invalid pairs", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-signals-bad-"));
    writeFileSync(
      join(root, "signals.json"),
      JSON.stringify({ contextTokensUsed: -1, contextWindowTokens: 500_000 }),
      "utf8",
    );
    expect(readGrokSignalsContext(root)).toBeNull();
  });
});

describe("resolveGrokContextUsageFromDisk", () => {
  test("maps signals into AgentUsage context fields", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-usage-disk-"));
    const sessionId = "sess-1";
    const sessionDir = join(root, "sessions", "cwd-key", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "summary.json"), "{}\n", "utf8");
    writeFileSync(
      join(sessionDir, "signals.json"),
      JSON.stringify({ contextTokensUsed: 61_695, contextWindowTokens: 500_000 }),
      "utf8",
    );

    expect(
      resolveGrokContextUsageFromDisk({
        sessionId,
        grokHome: root,
      }),
    ).toEqual({
      contextWindowUsedTokens: 61_695,
      contextWindowMaxTokens: 500_000,
    });
  });

  test("is exposed through the Grok resolver for resumed sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-resolver-disk-"));
    const sessionId = "sess-2";
    const sessionDir = join(root, "sessions", "cwd-key", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "summary.json"), "{}\n", "utf8");
    writeFileSync(
      join(sessionDir, "signals.json"),
      JSON.stringify({ contextTokensUsed: 75_000, contextWindowTokens: 500_000 }),
      "utf8",
    );

    const resolver = createGrokContextUsageResolver({ grokHome: root });
    expect(resolver.resolveInitialUsage?.(sessionId)).toEqual({
      contextWindowUsedTokens: 75_000,
      contextWindowMaxTokens: 500_000,
    });
  });
});
