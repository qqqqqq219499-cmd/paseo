import { afterEach, describe, expect, it } from "vitest";

import { CEO_INSTRUCTIONS_FALLBACK, isClusterLegacyHardPathEnabled } from "./ceo-instructions.js";

const ORIGINAL_LEGACY_FLAG = process.env.PASEO_CLUSTER_LEGACY_HARDPATH;

afterEach(() => {
  if (ORIGINAL_LEGACY_FLAG === undefined) {
    delete process.env.PASEO_CLUSTER_LEGACY_HARDPATH;
  } else {
    process.env.PASEO_CLUSTER_LEGACY_HARDPATH = ORIGINAL_LEGACY_FLAG;
  }
});

describe("CEO_INSTRUCTIONS_FALLBACK", () => {
  it("frames the lead agent as a chat-first CEO that delegates visibly", () => {
    const text = CEO_INSTRUCTIONS_FALLBACK.toLowerCase();
    // Single voice / CEO framing.
    expect(text).toContain("ceo");
    // Chat-first: answer small asks directly.
    expect(text).toContain("chat-first");
    // Delegates via the real Paseo tool so workers show in the sidebar.
    expect(CEO_INSTRUCTIONS_FALLBACK).toContain("create_agent");
    // Verify against real evidence, not self-reports.
    expect(text).toContain("verify");
    // Speak the user's language rather than defaulting to English.
    expect(text).toContain("language");
  });

  it("tells the lead not to delegate to its own model tier", () => {
    // The machine-specific allow-list is enforced by the guardrail, but the
    // fallback still states the cheap-worker principle in prose.
    expect(CEO_INSTRUCTIONS_FALLBACK.toLowerCase()).toContain("tier");
  });
});

describe("isClusterLegacyHardPathEnabled", () => {
  it("defaults to false (new CEO mode) when the env flag is unset", () => {
    delete process.env.PASEO_CLUSTER_LEGACY_HARDPATH;
    expect(isClusterLegacyHardPathEnabled()).toBe(false);
  });

  it("is true only for the explicit opt-in value", () => {
    process.env.PASEO_CLUSTER_LEGACY_HARDPATH = "1";
    expect(isClusterLegacyHardPathEnabled()).toBe(true);
  });

  it("stays false for other truthy-looking values", () => {
    process.env.PASEO_CLUSTER_LEGACY_HARDPATH = "true";
    expect(isClusterLegacyHardPathEnabled()).toBe(false);
  });
});
