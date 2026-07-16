import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Pure codec for grok's `auth.json` (`$GROK_HOME/auth.json`): parse, classify,
// extract identity and bearer token, resolve the grok home. No fs, no network,
// no logging — callers own all I/O.
//
// STRUCTURAL SECRECY (task design §1 rule 3): the schemas and inferred types in
// this file describe OAuth credential material (`key`, `refresh_token`). They
// must NEVER be imported into `packages/protocol` — no protocol schema may
// declare a field capable of holding token bytes. That structural absence is
// the only real guarantee that secrets never cross the relay or reach app
// clients; keep every credential-shaped type confined to `packages/server`.

// One issuer-keyed entry of a modern auth.json. Ground-truth field list
// captured 2026-07-11 from a real `~/.grok/auth.json` (task prd.md "Existing
// system facts"). Defensive-parsing rules (task
// research/xai-oauth-refresh-protocol.md "Gotchas"):
// - `expires_at` is polymorphic upstream — epoch seconds, epoch milliseconds,
//   or an ISO string. Always normalize through `normalizeExpiresAt` before
//   exposing an expiry.
// - The bearer field is canonically `key` (grok's own file always writes it),
//   but other ecosystems rename it to `access_token` or `token`. `key` is
//   therefore optional here so such files still parse as modern; the alternates
//   ride through `.passthrough()` and `extractBearerToken` reads them
//   defensively.
// - `.passthrough()` keeps unknown upstream fields intact so a stored snapshot
//   round-trips byte-faithfully (design §2: verbatim credential copies).
export const GrokAuthEntrySchema = z
  .object({
    key: z.string().optional(),
    refresh_token: z.string().optional(),
    expires_at: z.union([z.string(), z.number()]).optional(),
    auth_mode: z.string().optional(),
    create_time: z.string().optional(),
    oidc_issuer: z.string().optional(),
    oidc_client_id: z.string().optional(),
    user_id: z.string().optional(),
    email: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    principal_type: z.string().optional(),
    principal_id: z.string().optional(),
    team_id: z.string().optional(),
    coding_data_retention_opt_out: z.boolean().optional(),
  })
  .passthrough();

export type GrokAuthEntry = z.infer<typeof GrokAuthEntrySchema>;

// Modern file shape: `{ "<oidc_issuer>::<oidc_client_id>": entry, ... }`.
// Multiple entries legitimately coexist (an old `https://accounts.x.ai/sign-in`
// entry can sit beside the current `https://auth.x.ai::<client_id>` one).
export const ModernGrokAuthFileSchema = z.record(z.string(), GrokAuthEntrySchema);

// Obsolete flat shape some old installs still carry: `{ "access_token": "…" }`.
export const LegacyGrokAuthFileSchema = z.object({
  access_token: z.string(),
});

export interface GrokAuthFileEntryRef {
  issuerKey: string;
  entry: GrokAuthEntry;
}

export type ParsedGrokAuthFile =
  | { kind: "modern"; entries: GrokAuthFileEntryRef[] }
  | { kind: "legacy"; accessToken: string }
  | { kind: "invalid"; reason: string };

// Identity fields separable from the secret fields — safe to persist in
// index.json and to derive wire-facing metadata from. `expiresAt` is metadata
// about the token, not the token.
export interface GrokIdentity {
  issuerKey: string;
  userId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  teamId: string | null;
  authMode: string | null;
  // Normalized ISO 8601 (see `normalizeExpiresAt`), whatever form upstream wrote.
  expiresAt: string | null;
  createTime: string | null;
}

// Classify raw auth.json contents. Never throws. Precedence: a plain object
// with an `access_token` string key is legacy; an object whose values are
// objects is modern; an empty object is modern with zero entries.
//
// `reason` never carries file contents: JSON.parse's SyntaxError message can
// embed raw text (potential token bytes) so it is deliberately dropped, and
// Zod issue messages only name types/paths, never received values.
export function parseGrokAuthFile(raw: string): ParsedGrokAuthFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", reason: "top-level value is not an object" };
  }
  const legacy = LegacyGrokAuthFileSchema.safeParse(value);
  if (legacy.success) {
    return { kind: "legacy", accessToken: legacy.data.access_token };
  }
  const modern = ModernGrokAuthFileSchema.safeParse(value);
  if (!modern.success) {
    return { kind: "invalid", reason: describeFirstIssue(modern.error) };
  }
  const entries = Object.entries(modern.data).map(
    ([issuerKey, entry]): GrokAuthFileEntryRef => ({ issuerKey, entry }),
  );
  return { kind: "modern", entries };
}

function describeFirstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "failed schema validation";
  }
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
  return `invalid entry at ${path}: ${issue.message}`;
}

const MODERN_ISSUER_PREFIX = "https://auth.x.ai";

// Entry selection rule (task design §7 G5): a single entry is used as-is;
// among multiple entries exactly one whose issuer key starts with the modern
// `https://auth.x.ai` issuer wins (an old `https://accounts.x.ai/sign-in`
// entry legitimately coexists with it — mining finding); zero or several
// candidates → ambiguous, no selection.
function selectModernEntry(entries: GrokAuthFileEntryRef[]): GrokAuthFileEntryRef | null {
  if (entries.length === 1) {
    return entries[0];
  }
  const preferred = entries.filter((candidate) =>
    candidate.issuerKey.startsWith(MODERN_ISSUER_PREFIX),
  );
  return preferred.length === 1 ? preferred[0] : null;
}

// Identity of the signed-in account, or null when the file is legacy, invalid,
// empty, ambiguous (several auth.x.ai entries), or the selected entry has no
// `user_id`. Identity-less files are treated as "someone is signed in, we
// can't tell who" by callers — never harvested or auto-saved (design §7 G5).
export function extractGrokIdentity(parsed: ParsedGrokAuthFile): GrokIdentity | null {
  if (parsed.kind !== "modern") {
    return null;
  }
  const selected = selectModernEntry(parsed.entries);
  if (!selected) {
    return null;
  }
  const userId = nonEmptyString(selected.entry.user_id);
  if (userId === null) {
    return null;
  }
  return {
    issuerKey: selected.issuerKey,
    userId,
    email: selected.entry.email ?? null,
    firstName: selected.entry.first_name ?? null,
    lastName: selected.entry.last_name ?? null,
    teamId: selected.entry.team_id ?? null,
    authMode: selected.entry.auth_mode ?? null,
    expiresAt: normalizeExpiresAt(selected.entry.expires_at),
    createTime: selected.entry.create_time ?? null,
  };
}

// Bearer token for API calls (billing/quota). Modern files: the selected (or
// sole) entry's `key`, falling back to `access_token` or `token` — some
// ecosystems rename the field (mining finding); the alternates arrive through
// `.passthrough()`, so they are read defensively. Legacy files: the top-level
// `access_token`. Anything else: null.
export function extractBearerToken(parsed: ParsedGrokAuthFile): string | null {
  if (parsed.kind === "legacy") {
    return parsed.accessToken;
  }
  if (parsed.kind !== "modern") {
    return null;
  }
  const selected = selectModernEntry(parsed.entries);
  if (!selected) {
    return null;
  }
  return (
    nonEmptyString(selected.entry.key) ??
    nonEmptyString(selected.entry["access_token"]) ??
    nonEmptyString(selected.entry["token"])
  );
}

// Milliseconds-vs-seconds disambiguation by magnitude: 10^12 epoch seconds is
// the year ~33658 while 10^12 epoch milliseconds is 2001, so any plausible
// timestamp above the threshold must already be milliseconds.
const EPOCH_MILLISECONDS_THRESHOLD = 1e12;

// Normalize a polymorphic `expires_at` (epoch seconds, epoch milliseconds, or
// an ISO-ish string — mining finding) to canonical ISO 8601 UTC, or null when
// the value is absent or unparseable. Never throws.
export function normalizeExpiresAt(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    const epochMs = Math.abs(value) > EPOCH_MILLISECONDS_THRESHOLD ? value : value * 1000;
    return toIsoOrNull(new Date(epochMs));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    return toIsoOrNull(new Date(trimmed));
  }
  return null;
}

function toIsoOrNull(date: Date): string | null {
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The one grok-home rule, shared by the account switcher and the quota reader
// (task design §2/§7 G7): a non-empty `GROK_HOME` (trimmed) wins, otherwise
// `~/.grok`. Pure and injectable; production callers use
// `defaultGrokAuthFilePath()` below. Known limitation: evaluated against the
// daemon's environment — a user shell exporting a different GROK_HOME sees a
// different file.
export function resolveGrokHome(env: NodeJS.ProcessEnv, homedirFn: () => string): string {
  const override = env.GROK_HOME?.trim();
  if (override) {
    return override;
  }
  return join(homedirFn(), ".grok");
}

// The live auth file path in the daemon's real environment.
export function defaultGrokAuthFilePath(): string {
  return join(resolveGrokHome(process.env, homedir), "auth.json");
}
