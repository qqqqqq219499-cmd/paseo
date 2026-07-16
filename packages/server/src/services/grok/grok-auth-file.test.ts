import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultGrokAuthFilePath,
  extractBearerToken,
  extractGrokIdentity,
  normalizeExpiresAt,
  type ParsedGrokAuthFile,
  parseGrokAuthFile,
  resolveGrokHome,
} from "./grok-auth-file.js";

// Ground-truth issuer key shape: "<oidc_issuer>::<oidc_client_id>". The client
// id is grok's public built-in PKCE client id (non-secret, confirmed in task
// research/xai-oauth-refresh-protocol.md).
export const FAKE_AUTH_X_AI_ISSUER_KEY = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

// First in-repo modern grok auth fixture, built from the 2026-07-11
// ground-truth field list (task prd.md "Existing system facts"). Secret-shaped
// values are obviously fake; `unknown_upstream_field` proves `.passthrough()`
// keeps fields this codec has never heard of. Later steps' tests import these
// builders.
export function makeModernAuthEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: "fake-key-0123456789abcdef",
    refresh_token: "fake-refresh-fedcba9876543210",
    expires_at: "2026-07-11T12:00:00.000Z",
    auth_mode: "oauth",
    create_time: "2026-07-01T00:00:00.000Z",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    user_id: "fake-user-id-1",
    email: "fake-user@example.com",
    first_name: "Fake",
    last_name: "User",
    principal_type: "user",
    principal_id: "fake-user-id-1",
    team_id: "fake-team-id-1",
    coding_data_retention_opt_out: false,
    unknown_upstream_field: "survives-round-trips",
    ...overrides,
  };
}

// Single-entry modern auth.json object; `overrides` apply to the entry.
export function makeModernAuthFile(
  overrides: Record<string, unknown> = {},
): Record<string, Record<string, unknown>> {
  return { [FAKE_AUTH_X_AI_ISSUER_KEY]: makeModernAuthEntry(overrides) };
}

function expectModern(parsed: ParsedGrokAuthFile): Extract<ParsedGrokAuthFile, { kind: "modern" }> {
  if (parsed.kind !== "modern") {
    throw new Error(`expected a modern auth file, got kind "${parsed.kind}"`);
  }
  return parsed;
}

describe("parseGrokAuthFile", () => {
  it("parses a modern single-entry file", () => {
    const parsed = expectModern(parseGrokAuthFile(JSON.stringify(makeModernAuthFile())));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.issuerKey).toBe(FAKE_AUTH_X_AI_ISSUER_KEY);
    expect(parsed.entries[0]?.entry.user_id).toBe("fake-user-id-1");
    expect(parsed.entries[0]?.entry.key).toBe("fake-key-0123456789abcdef");
  });

  it("classifies a flat access_token object as legacy", () => {
    const parsed = parseGrokAuthFile(JSON.stringify({ access_token: "fake-legacy-token" }));
    expect(parsed).toEqual({ kind: "legacy", accessToken: "fake-legacy-token" });
  });

  it("returns invalid (never throws) for unparseable JSON", () => {
    const parsed = parseGrokAuthFile("{ not json");
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.reason.length).toBeGreaterThan(0);
      // The reason must never echo file contents (they may be token bytes).
      expect(parsed.reason).not.toContain("not json");
    }
  });

  it("returns invalid for JSON that is not a plain object", () => {
    expect(parseGrokAuthFile("[1, 2]").kind).toBe("invalid");
    expect(parseGrokAuthFile("42").kind).toBe("invalid");
    expect(parseGrokAuthFile("null").kind).toBe("invalid");
  });

  it("treats an empty object as modern with zero entries", () => {
    const parsed = parseGrokAuthFile("{}");
    expect(parsed).toEqual({ kind: "modern", entries: [] });
    expect(extractGrokIdentity(parsed)).toBeNull();
    expect(extractBearerToken(parsed)).toBeNull();
  });

  it("round-trips unknown upstream fields with equal values", () => {
    const raw = JSON.stringify(makeModernAuthFile());
    const parsed = expectModern(parseGrokAuthFile(raw));
    expect(parsed.entries[0]?.entry["unknown_upstream_field"]).toBe("survives-round-trips");
    const reconstructed = Object.fromEntries(
      parsed.entries.map(({ issuerKey, entry }) => [issuerKey, entry]),
    );
    expect(reconstructed).toEqual(JSON.parse(raw));
  });
});

describe("extractGrokIdentity", () => {
  it("extracts the full identity from a modern single-entry file", () => {
    const parsed = parseGrokAuthFile(JSON.stringify(makeModernAuthFile()));
    expect(extractGrokIdentity(parsed)).toEqual({
      issuerKey: FAKE_AUTH_X_AI_ISSUER_KEY,
      userId: "fake-user-id-1",
      email: "fake-user@example.com",
      firstName: "Fake",
      lastName: "User",
      teamId: "fake-team-id-1",
      authMode: "oauth",
      expiresAt: "2026-07-11T12:00:00.000Z",
      createTime: "2026-07-01T00:00:00.000Z",
    });
  });

  it("returns null for legacy and invalid files", () => {
    expect(
      extractGrokIdentity(parseGrokAuthFile(JSON.stringify({ access_token: "fake-legacy-token" }))),
    ).toBeNull();
    expect(extractGrokIdentity(parseGrokAuthFile("{ not json"))).toBeNull();
  });

  it("prefers the auth.x.ai issuer when an old accounts.x.ai entry coexists", () => {
    const file = {
      "https://accounts.x.ai/sign-in": makeModernAuthEntry({
        key: "fake-old-key",
        user_id: "fake-old-user-id",
        email: "fake-old-user@example.com",
      }),
      [FAKE_AUTH_X_AI_ISSUER_KEY]: makeModernAuthEntry(),
    };
    const parsed = parseGrokAuthFile(JSON.stringify(file));
    const identity = extractGrokIdentity(parsed);
    expect(identity?.issuerKey).toBe(FAKE_AUTH_X_AI_ISSUER_KEY);
    expect(identity?.userId).toBe("fake-user-id-1");
    // The bearer comes from the same selected entry, not the old one.
    expect(extractBearerToken(parsed)).toBe("fake-key-0123456789abcdef");
  });

  it("returns null when several auth.x.ai entries make selection ambiguous", () => {
    const file = {
      "https://auth.x.ai::fake-client-a": makeModernAuthEntry({ user_id: "fake-user-a" }),
      "https://auth.x.ai::fake-client-b": makeModernAuthEntry({ user_id: "fake-user-b" }),
    };
    const parsed = parseGrokAuthFile(JSON.stringify(file));
    expect(extractGrokIdentity(parsed)).toBeNull();
    expect(extractBearerToken(parsed)).toBeNull();
  });

  it("returns null when the selected entry has no user_id", () => {
    const parsed = parseGrokAuthFile(JSON.stringify(makeModernAuthFile({ user_id: undefined })));
    expect(extractGrokIdentity(parsed)).toBeNull();
    // The sole entry still yields a bearer token (identity-less ≠ token-less).
    expect(extractBearerToken(parsed)).toBe("fake-key-0123456789abcdef");
  });

  it("exposes a normalized ISO expiry for every upstream expires_at form", () => {
    const instantIso = "2026-07-11T12:00:00.000Z";
    const instantMs = Date.parse(instantIso);
    for (const form of [instantMs / 1000, instantMs, "2026-07-11T12:00:00Z"]) {
      const parsed = parseGrokAuthFile(JSON.stringify(makeModernAuthFile({ expires_at: form })));
      expect(extractGrokIdentity(parsed)?.expiresAt).toBe(instantIso);
    }
  });
});

describe("extractBearerToken", () => {
  it("extracts the legacy top-level access_token", () => {
    const parsed = parseGrokAuthFile(JSON.stringify({ access_token: "fake-legacy-token" }));
    expect(extractBearerToken(parsed)).toBe("fake-legacy-token");
  });

  it("falls back to access_token when an ecosystem renamed the bearer field", () => {
    const parsed = parseGrokAuthFile(
      JSON.stringify(makeModernAuthFile({ key: undefined, access_token: "fake-renamed-bearer" })),
    );
    expect(parsed.kind).toBe("modern");
    expect(extractBearerToken(parsed)).toBe("fake-renamed-bearer");
  });

  it("falls back to token as the last alternate bearer field", () => {
    const parsed = parseGrokAuthFile(
      JSON.stringify(makeModernAuthFile({ key: undefined, token: "fake-token-bearer" })),
    );
    expect(extractBearerToken(parsed)).toBe("fake-token-bearer");
  });

  it("returns null for invalid files", () => {
    expect(extractBearerToken(parseGrokAuthFile("{ not json"))).toBeNull();
  });
});

describe("normalizeExpiresAt", () => {
  const instantIso = "2026-07-11T12:00:00.000Z";
  const instantMs = Date.parse(instantIso);

  it("normalizes epoch seconds, epoch milliseconds, and ISO strings to one instant", () => {
    expect(normalizeExpiresAt(instantMs / 1000)).toBe(instantIso);
    expect(normalizeExpiresAt(instantMs)).toBe(instantIso);
    expect(normalizeExpiresAt("2026-07-11T12:00:00Z")).toBe(instantIso);
    expect(normalizeExpiresAt(instantIso)).toBe(instantIso);
  });

  it("returns null for absent or unparseable values", () => {
    expect(normalizeExpiresAt(undefined)).toBeNull();
    expect(normalizeExpiresAt(null)).toBeNull();
    expect(normalizeExpiresAt("")).toBeNull();
    expect(normalizeExpiresAt("not a date")).toBeNull();
    expect(normalizeExpiresAt(Number.NaN)).toBeNull();
    expect(normalizeExpiresAt(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("resolveGrokHome", () => {
  function fakeHomedir(): string {
    return "/fake/home";
  }

  it("uses a non-empty GROK_HOME override, trimmed", () => {
    expect(resolveGrokHome({ GROK_HOME: "/custom/grok-home" }, fakeHomedir)).toBe(
      "/custom/grok-home",
    );
    expect(resolveGrokHome({ GROK_HOME: "  /custom/grok-home  " }, fakeHomedir)).toBe(
      "/custom/grok-home",
    );
  });

  it("falls back to ~/.grok when GROK_HOME is unset, empty, or whitespace", () => {
    const fallback = join("/fake/home", ".grok");
    expect(resolveGrokHome({}, fakeHomedir)).toBe(fallback);
    expect(resolveGrokHome({ GROK_HOME: "" }, fakeHomedir)).toBe(fallback);
    expect(resolveGrokHome({ GROK_HOME: "   " }, fakeHomedir)).toBe(fallback);
  });
});

describe("defaultGrokAuthFilePath", () => {
  it("appends auth.json to the grok home resolved from the real environment", () => {
    expect(defaultGrokAuthFilePath()).toBe(
      join(resolveGrokHome(process.env, homedir), "auth.json"),
    );
  });
});
