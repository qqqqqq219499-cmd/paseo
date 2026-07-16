import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GrokAccountStore } from "./grok-account-store.js";
import { parseGrokAuthFile } from "./grok-auth-file.js";
// Fixture builders are exported from the codec's own test file (design §12) so
// every grok test speaks the same auth.json shape.
import { makeModernAuthFile } from "./grok-auth-file.test.js";

const isPosix = process.platform !== "win32";
const itPosix = isPosix ? it : it.skip;

// A single-entry modern auth.json (same fixed issuer key for every account, so
// accounts differ only by user_id — matching keys on both issuer + user id).
function authJson(userId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    makeModernAuthFile({
      user_id: userId,
      principal_id: userId,
      email: `${userId}@example.com`,
      ...overrides,
    }),
  );
}

// Write backup snapshots directly into a store's backups/ dir. Module-level so
// the seeding loop is not a callback nested inside a test body.
function seedBackups(
  backupsDir: string,
  entries: { timestamp: string; content: string }[],
): string[] {
  const names: string[] = [];
  for (const { timestamp, content } of entries) {
    const name = `host-auth.${timestamp}.json`;
    writeFileSync(join(backupsDir, name), content);
    names.push(name);
  }
  return names;
}

describe("GrokAccountStore", () => {
  let base: string;
  let rootDir: string;
  let liveAuthFilePath: string;

  function createStore(now?: () => Date): GrokAccountStore {
    return new GrokAccountStore({ rootDir, liveAuthFilePath, now });
  }

  function addAccount(
    store: GrokAccountStore,
    userId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const raw = authJson(userId, overrides);
    return { raw, result: store.upsertFromParsedAuth(parseGrokAuthFile(raw), raw) };
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "grok-store-"));
    rootDir = join(base, "grok-accounts");
    const liveDir = join(base, "grok-home");
    mkdirSync(liveDir, { recursive: true });
    liveAuthFilePath = join(liveDir, "auth.json");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // --- initialize -------------------------------------------------------------

  it("initialize creates the root, credentials, and backups directories", () => {
    const store = createStore();
    store.initialize();
    expect(existsSync(store.rootDir)).toBe(true);
    expect(existsSync(store.credentialsDir)).toBe(true);
    expect(existsSync(store.backupsDir)).toBe(true);
  });

  it("initialize treats a corrupt index as empty and never throws", () => {
    const store = createStore();
    store.initialize();
    writeFileSync(join(rootDir, "index.json"), "{ not json");
    expect(() => store.initialize()).not.toThrow();
    expect(store.listAccounts()).toEqual([]);
  });

  it("initialize GCs an orphan credential (crash after credential write, before index)", () => {
    const store = createStore();
    store.initialize();
    // The intermediate state after step 1 of an upsert that crashed before the
    // index write: a credential file with no matching index entry.
    writeFileSync(join(store.credentialsDir, "ghost.auth.json"), authJson("ghost"));
    store.initialize();
    expect(existsSync(join(store.credentialsDir, "ghost.auth.json"))).toBe(false);
  });

  it("initialize sweeps the staging directory unconditionally", () => {
    const store = createStore();
    store.initialize();
    const stagingLogin = join(store.stagingDir, "login-1");
    mkdirSync(stagingLogin, { recursive: true });
    writeFileSync(join(stagingLogin, "auth.json"), authJson("mid-login"));
    store.initialize();
    expect(existsSync(store.stagingDir)).toBe(false);
  });

  // --- upsert -----------------------------------------------------------------

  it("upsert writes the credential file and index entry, keyed by user id", () => {
    const store = createStore();
    store.initialize();
    const { raw, result } = addAccount(store, "user-a");
    expect(result).toEqual({ accountId: "user-a" });
    expect(existsSync(join(store.credentialsDir, "user-a.auth.json"))).toBe(true);
    expect(store.readCredentialRaw("user-a")).toBe(raw);
    const accounts = store.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe("user-a");
    expect(accounts[0]?.oidcIssuer).toBe("https://auth.x.ai");
    expect(accounts[0]?.oidcClientId).toBe("b1a00492-073a-47ea-816f-4c329264a828");
  });

  it("upsert returns null and persists nothing for an identity-less auth file", () => {
    const store = createStore();
    store.initialize();
    const raw = JSON.stringify({ access_token: "legacy-token" });
    expect(store.upsertFromParsedAuth(parseGrokAuthFile(raw), raw)).toBeNull();
    expect(store.listAccounts()).toEqual([]);
    expect(readdirSync(store.credentialsDir)).toEqual([]);
  });

  it("upsert dedupes by user id on re-add, refreshing metadata but preserving addedAt", () => {
    const store = createStore(() => new Date("2026-07-11T00:00:00.000Z"));
    store.initialize();
    addAccount(store, "user-a", { expires_at: "2026-07-11T01:00:00.000Z", auth_mode: "oauth" });
    expect(store.listAccounts()[0]?.addedAt).toBe("2026-07-11T00:00:00.000Z");

    const later = new GrokAccountStore({
      rootDir,
      liveAuthFilePath,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const second = authJson("user-a", {
      expires_at: "2026-09-01T02:00:00.000Z",
      auth_mode: "device",
    });
    later.upsertFromParsedAuth(parseGrokAuthFile(second), second);

    const accounts = later.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.addedAt).toBe("2026-07-11T00:00:00.000Z");
    expect(accounts[0]?.expiresAt).toBe("2026-09-01T02:00:00.000Z");
    expect(accounts[0]?.authMode).toBe("device");
    expect(later.readCredentialRaw("user-a")).toBe(second);
  });

  // --- remove -----------------------------------------------------------------

  it("remove deletes the index entry then the credential file, reporting existence", () => {
    const store = createStore();
    store.initialize();
    addAccount(store, "user-a");
    expect(store.removeAccount("user-a")).toBe(true);
    expect(store.listAccounts()).toEqual([]);
    expect(existsSync(join(store.credentialsDir, "user-a.auth.json"))).toBe(false);
    expect(store.removeAccount("user-a")).toBe(false);
  });

  it("remove leftover credential is GC'd (crash after index rewrite, before rm)", () => {
    const store = createStore();
    store.initialize();
    addAccount(store, "user-a");
    // The intermediate state after step 1 of a remove that crashed before the
    // credential rm: index entry gone, credential file still present.
    writeFileSync(join(rootDir, "index.json"), JSON.stringify({ version: 1, accounts: [] }));
    expect(existsSync(join(store.credentialsDir, "user-a.auth.json"))).toBe(true);
    store.initialize();
    expect(existsSync(join(store.credentialsDir, "user-a.auth.json"))).toBe(false);
  });

  // --- resolveActiveAccount ---------------------------------------------------

  it("resolveActiveAccount matches the live identity to a saved account", () => {
    const store = createStore();
    store.initialize();
    const { raw } = addAccount(store, "user-a");
    writeFileSync(liveAuthFilePath, raw);
    expect(store.resolveActiveAccount()).toEqual({
      activeAccountId: "user-a",
      unsavedActive: null,
    });
  });

  it("resolveActiveAccount reports a parseable but unsaved modern sign-in by email", () => {
    const store = createStore();
    store.initialize();
    writeFileSync(liveAuthFilePath, authJson("user-x"));
    expect(store.resolveActiveAccount()).toEqual({
      activeAccountId: null,
      unsavedActive: { email: "user-x@example.com" },
    });
  });

  it("resolveActiveAccount reports a legacy (identity-less) live file as unknown", () => {
    const store = createStore();
    store.initialize();
    writeFileSync(liveAuthFilePath, JSON.stringify({ access_token: "legacy-token" }));
    expect(store.resolveActiveAccount()).toEqual({
      activeAccountId: null,
      unsavedActive: { email: null },
    });
  });

  it("resolveActiveAccount reports a corrupt live file as unknown", () => {
    const store = createStore();
    store.initialize();
    writeFileSync(liveAuthFilePath, "{ not json");
    expect(store.resolveActiveAccount()).toEqual({
      activeAccountId: null,
      unsavedActive: { email: null },
    });
  });

  it("resolveActiveAccount returns nulls when no live file exists", () => {
    const store = createStore();
    store.initialize();
    expect(store.resolveActiveAccount()).toEqual({
      activeAccountId: null,
      unsavedActive: null,
    });
  });

  it("resolveActiveAccount self-heals a stale stored expiry from the live file", () => {
    const store = createStore();
    store.initialize();
    addAccount(store, "user-a", { expires_at: "2026-07-11T01:00:00.000Z" });
    writeFileSync(liveAuthFilePath, authJson("user-a", { expires_at: "2026-12-31T23:00:00.000Z" }));
    store.resolveActiveAccount();
    expect(store.listAccounts()[0]?.expiresAt).toBe("2026-12-31T23:00:00.000Z");
  });

  // --- markActivated ----------------------------------------------------------

  it("markActivated stamps lastActivatedAt with the current time", () => {
    const store = createStore(() => new Date("2026-07-11T08:00:00.000Z"));
    store.initialize();
    addAccount(store, "user-a");
    expect(store.listAccounts()[0]?.lastActivatedAt).toBeNull();
    store.markActivated("user-a");
    expect(store.listAccounts()[0]?.lastActivatedAt).toBe("2026-07-11T08:00:00.000Z");
  });

  // --- backupLiveFile ---------------------------------------------------------

  it("backupLiveFile returns null when there is no live file", () => {
    const store = createStore();
    store.initialize();
    expect(store.backupLiveFile()).toBeNull();
  });

  it("backupLiveFile keeps only the newest five backups when all identities are saved", () => {
    const store = createStore(() => new Date("2026-07-11T20:00:00.000Z"));
    store.initialize();
    const { raw } = addAccount(store, "user-a");
    // Five pre-existing backups of the saved account (none protected).
    const preexisting = seedBackups(
      store.backupsDir,
      ["09", "10", "11", "12", "13"].map((hh) => ({
        timestamp: `2026-07-11T${hh}-00-00.000Z`,
        content: raw,
      })),
    );
    writeFileSync(liveAuthFilePath, raw);

    const created = store.backupLiveFile();
    expect(created).toBe(join(store.backupsDir, "host-auth.2026-07-11T20-00-00.000Z.json"));
    const remaining = readdirSync(store.backupsDir);
    expect(remaining).toHaveLength(5);
    // Oldest pre-existing pruned; the just-written one kept.
    expect(remaining).not.toContain(preexisting[0]);
    expect(remaining).toContain("host-auth.2026-07-11T20-00-00.000Z.json");
  });

  it("backupLiveFile protects the newest unmatched backup from pruning", () => {
    const store = createStore(() => new Date("2026-07-11T20:00:00.000Z"));
    store.initialize();
    const { raw: savedRaw } = addAccount(store, "user-a");

    // Oldest backup (08:00) holds an identity that is NOT saved → must survive.
    // Five newer backups (09..13) belong to the saved account.
    const [unmatchedName, matchedOldest] = seedBackups(store.backupsDir, [
      { timestamp: "2026-07-11T08-00-00.000Z", content: authJson("user-external") },
      { timestamp: "2026-07-11T09-00-00.000Z", content: savedRaw },
      { timestamp: "2026-07-11T10-00-00.000Z", content: savedRaw },
      { timestamp: "2026-07-11T11-00-00.000Z", content: savedRaw },
      { timestamp: "2026-07-11T12-00-00.000Z", content: savedRaw },
      { timestamp: "2026-07-11T13-00-00.000Z", content: savedRaw },
    ]);
    writeFileSync(liveAuthFilePath, savedRaw);

    // Writes host-auth.2026-07-11T20-...json (matched), then prunes keep-5.
    // Sorted newest-first: 20, 13, 12, 11, 10 (kept), then 09, 08 (beyond keep).
    // 09 is matched → deleted; 08 is the newest unmatched → protected.
    store.backupLiveFile();

    const remaining = new Set(readdirSync(store.backupsDir));
    expect(remaining.has("host-auth.2026-07-11T20-00-00.000Z.json")).toBe(true);
    expect(remaining.has(matchedOldest)).toBe(false); // 09:00, matched, pruned
    expect(remaining.has(unmatchedName)).toBe(true); // 08:00, unmatched, protected
  });

  // --- live-file primitives (Step 5 switch) -----------------------------------

  it("liveAuthFilePath exposes the configured live auth file path", () => {
    const store = createStore();
    expect(store.liveAuthFilePath).toBe(liveAuthFilePath);
  });

  it("readLiveAuthRaw returns the live bytes, or null when absent", () => {
    const store = createStore();
    store.initialize();
    expect(store.readLiveAuthRaw()).toBeNull();
    const raw = authJson("user-a");
    writeFileSync(liveAuthFilePath, raw);
    expect(store.readLiveAuthRaw()).toBe(raw);
  });

  it("swapLiveAuthFile atomically writes the given bytes to the live file", () => {
    const store = createStore();
    store.initialize();
    const raw = authJson("user-a");
    store.swapLiveAuthFile(raw);
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(raw);
  });

  it("swapLiveAuthFile retries on EPERM then succeeds, sleeping between attempts", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const store = new GrokAccountStore({
      rootDir,
      liveAuthFilePath,
      sleepSync: (ms) => sleeps.push(ms),
      writeLiveFile: (targetPath, data) => {
        attempts += 1;
        if (attempts <= 2) {
          throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        }
        writeFileSync(targetPath, data);
      },
    });
    store.initialize();
    store.swapLiveAuthFile("swapped-bytes");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 300]);
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe("swapped-bytes");
  });

  it("swapLiveAuthFile rethrows after exhausting EPERM retries, leaving the live file intact", () => {
    const previous = authJson("previous");
    writeFileSync(liveAuthFilePath, previous);
    const sleeps: number[] = [];
    const store = new GrokAccountStore({
      rootDir,
      liveAuthFilePath,
      sleepSync: (ms) => sleeps.push(ms),
      writeLiveFile: () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      },
    });
    store.initialize();
    expect(() => store.swapLiveAuthFile("never-written")).toThrow(/EPERM/);
    expect(sleeps).toEqual([100, 300, 900]);
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(previous);
  });

  it("swapLiveAuthFile does not retry a non-busy error", () => {
    const sleeps: number[] = [];
    const store = new GrokAccountStore({
      rootDir,
      liveAuthFilePath,
      sleepSync: (ms) => sleeps.push(ms),
      writeLiveFile: () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      },
    });
    store.initialize();
    expect(() => store.swapLiveAuthFile("never-written")).toThrow(/ENOSPC/);
    expect(sleeps).toEqual([]);
  });

  // --- permissions (POSIX only) -----------------------------------------------

  itPosix("writes credential files 0600 and directories 0700", () => {
    const store = createStore();
    store.initialize();
    addAccount(store, "user-a");
    expect(statSync(join(store.credentialsDir, "user-a.auth.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(rootDir, "index.json")).mode & 0o777).toBe(0o600);
    expect(statSync(store.credentialsDir).mode & 0o777).toBe(0o700);
    expect(statSync(store.backupsDir).mode & 0o777).toBe(0o700);
  });
});
