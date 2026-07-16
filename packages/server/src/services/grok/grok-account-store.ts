import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  backupFileToDir,
  ensurePrivateDirectory,
  prunePrivateBackups,
  writePrivateFileAtomicSync,
} from "../../server/private-files.js";
import {
  extractGrokIdentity,
  type GrokIdentity,
  parseGrokAuthFile,
  type ParsedGrokAuthFile,
} from "./grok-auth-file.js";

// Persistence layer for saved grok OAuth accounts under
// `$PASEO_HOME/grok-accounts/` (task design §2). No network, no process
// spawning — those live in the login orchestrator (Step 4) and service facade
// (Step 5). Every path is injected so the whole store is testable against real
// temp directories.
//
// Layout:
//   <rootDir>/index.json                     non-secret account metadata
//   <rootDir>/credentials/<id>.auth.json     verbatim auth.json snapshot, SECRET
//   <rootDir>/backups/host-auth.<ts>.json    pre-swap copies of the live file
//   <rootDir>/staging/<loginId>/             throwaway GROK_HOME for a login
//
// Two invariants govern everything here:
//   1. "Active" is DERIVED from the live auth file, never stored (design §1).
//      `resolveActiveAccount()` re-reads the file and matches identity every
//      time — there is no pointer that can dangle after a crash.
//   2. index.json is AUTHORITATIVE for existence (design §2). Add writes the
//      credential file first, then the index entry; delete removes the index
//      entry first, then the credential file; startup GC deletes any credential
//      without an index entry. Every crash leaves a complete account or
//      ignorable garbage, never an index entry pointing at a missing file.

// Non-secret account metadata persisted in `index.json`. IDENTITY FIELDS ONLY —
// never token bytes (design §2). Like the credential codec, this schema and its
// inferred type are SERVER-ONLY: they must NEVER be imported into
// `packages/protocol`, so no wire schema can carry credential material.
const IndexAccountSchema = z.object({
  id: z.string(),
  oidcIssuer: z.string(),
  oidcClientId: z.string(),
  userId: z.string(),
  email: z.string().nullable(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
  authMode: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  addedAt: z.string(),
  lastActivatedAt: z.string().nullable().optional(),
});

export const IndexFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(IndexAccountSchema),
});

// Identity-only metadata for one saved account (no tokens).
export type StoredAccountMeta = z.infer<typeof IndexAccountSchema>;
type IndexFile = z.infer<typeof IndexFileSchema>;

const CREDENTIAL_SUFFIX = ".auth.json";
const BACKUP_FILENAME_PREFIX = "host-auth.";
const BACKUP_FILENAME_SUFFIX = ".json";
const BACKUP_KEEP_COUNT = 5;
const ISSUER_KEY_SEPARATOR = "::";

export interface GrokAccountStoreOptions {
  // `$PASEO_HOME/grok-accounts` in production; a temp dir in tests.
  rootDir: string;
  // OS-default live auth file (`resolveGrokHome()` + `/auth.json`); injected so
  // tests point it at a temp file and never touch the real `~/.grok/auth.json`.
  liveAuthFilePath: string;
  // Injected clock for deterministic timestamps in tests.
  now?: () => Date;
  // Synchronous sleep for `swapLiveAuthFile`'s EPERM backoff. Tests inject a
  // no-op so the retry sequence runs without real delays; the default blocks the
  // thread via `Atomics.wait` (no busy-loop).
  sleepSync?: (ms: number) => void;
  // Seam for the live-file atomic write in `swapLiveAuthFile`, so tests can
  // simulate a Windows EPERM (grok momentarily holding auth.json) deterministically.
  // Defaults to `writePrivateFileAtomicSync`.
  writeLiveFile?: (filePath: string, data: string) => void;
}

export class GrokAccountStore {
  private readonly rootDirPath: string;
  private readonly liveAuthPath: string;
  private readonly now: () => Date;
  private readonly sleepSync: (ms: number) => void;
  private readonly writeLiveFile: (filePath: string, data: string) => void;
  private readonly credentialsDirPath: string;
  private readonly backupsDirPath: string;
  private readonly stagingDirPath: string;
  private readonly indexFilePath: string;

  constructor(options: GrokAccountStoreOptions) {
    this.rootDirPath = options.rootDir;
    this.liveAuthPath = options.liveAuthFilePath;
    this.now = options.now ?? (() => new Date());
    this.sleepSync = options.sleepSync ?? sleepSyncViaAtomics;
    this.writeLiveFile =
      options.writeLiveFile ?? ((filePath, data) => writePrivateFileAtomicSync(filePath, data));
    this.credentialsDirPath = join(this.rootDirPath, "credentials");
    this.backupsDirPath = join(this.rootDirPath, "backups");
    this.stagingDirPath = join(this.rootDirPath, "staging");
    this.indexFilePath = join(this.rootDirPath, "index.json");
  }

  // Path getters for the login orchestrator (Step 4) and service (Step 5).
  get rootDir(): string {
    return this.rootDirPath;
  }
  get credentialsDir(): string {
    return this.credentialsDirPath;
  }
  get backupsDir(): string {
    return this.backupsDirPath;
  }
  get stagingDir(): string {
    return this.stagingDirPath;
  }
  // The OS-default live auth file the switcher swaps and the quota reader reads.
  get liveAuthFilePath(): string {
    return this.liveAuthPath;
  }

  // Ensure the directory tree, GC orphan credentials, and sweep staging. Safe to
  // call on every daemon startup; never throws on a bad index.
  initialize(): void {
    ensurePrivateDirectory(this.rootDirPath);
    ensurePrivateDirectory(this.credentialsDirPath);
    ensurePrivateDirectory(this.backupsDirPath);
    this.collectOrphanCredentials();
    // Staging sweep (design §7 G2): an in-flight login's throwaway GROK_HOME
    // never survives a restart — even a fully-written one is discarded, because
    // silently materializing an account the user believed was cancelled is worse
    // than redoing a cheap login. Drop the whole tree unconditionally.
    rmSync(this.stagingDirPath, { recursive: true, force: true });
  }

  // All saved accounts as identity-only metadata (no tokens). Re-read from disk
  // each call so callers always see ground truth (no cached authority).
  listAccounts(): StoredAccountMeta[] {
    return this.loadIndex().accounts;
  }

  // The verbatim saved auth.json bytes for one account (used by switch/quota in
  // Step 5), or null if the account has no credential file.
  readCredentialRaw(accountId: string): string | null {
    try {
      return readFileSync(this.credentialFilePath(accountId), "utf8");
    } catch {
      return null;
    }
  }

  // Verbatim bytes of the live auth file, or null when it is absent/unreadable.
  // The switch harvest (Step 5) snapshots whatever grok currently has before it
  // backs up and swaps.
  readLiveAuthRaw(): string | null {
    try {
      return readFileSync(this.liveAuthPath, "utf8");
    } catch {
      return null;
    }
  }

  // Atomically replace the live auth file with `rawBytes` (design §4 step 4).
  // On Windows the rename can fail EPERM/EACCES while grok momentarily holds the
  // file (spike S4); retry with a short synchronous backoff (100/300/900 ms).
  // After the final attempt the error propagates so the caller reports
  // grok_switch_failed — the previous file stays intact because
  // writePrivateFileAtomicSync writes to a temp file and only renames on success.
  swapLiveAuthFile(rawBytes: string): void {
    let lastError: unknown;
    for (let attempt = 0; attempt <= SWAP_RETRY_BACKOFFS_MS.length; attempt += 1) {
      try {
        this.writeLiveFile(this.liveAuthPath, rawBytes);
        return;
      } catch (error) {
        if (!isFileBusyError(error)) {
          throw error;
        }
        lastError = error;
        const backoff = SWAP_RETRY_BACKOFFS_MS[attempt];
        if (backoff === undefined) {
          break;
        }
        this.sleepSync(backoff);
      }
    }
    throw lastError;
  }

  // Persist an account from a parsed auth file plus its verbatim bytes. Null
  // identity (legacy / identity-less / ambiguous) → returns null and writes
  // nothing; the caller decides what to do. accountId is the grok `user_id`
  // (fallback: a sha256 of issuer+email). Re-adding the same account upserts:
  // metadata is refreshed but `addedAt` / `lastActivatedAt` are preserved.
  upsertFromParsedAuth(parsed: ParsedGrokAuthFile, rawBytes: string): { accountId: string } | null {
    const identity = extractGrokIdentity(parsed);
    if (identity === null) {
      return null;
    }
    const accountId = computeAccountId(identity);
    // Existence invariant (design §2): credential file FIRST, index entry
    // SECOND. A crash between them leaves an orphan the next initialize() GCs —
    // never an index entry pointing at a missing credential file.
    writePrivateFileAtomicSync(this.credentialFilePath(accountId), rawBytes);
    const index = this.loadIndex();
    const existing = index.accounts.find((account) => account.id === accountId);
    const { oidcIssuer, oidcClientId } = splitIssuerKey(identity.issuerKey);
    const entry: StoredAccountMeta = {
      id: accountId,
      oidcIssuer,
      oidcClientId,
      userId: identity.userId,
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
      teamId: identity.teamId,
      authMode: identity.authMode,
      expiresAt: identity.expiresAt,
      addedAt: existing?.addedAt ?? this.nowIso(),
      lastActivatedAt: existing?.lastActivatedAt ?? null,
    };
    const accounts = existing
      ? index.accounts.map((account) => (account.id === accountId ? entry : account))
      : [...index.accounts, entry];
    this.writeIndex({ version: 1, accounts });
    return { accountId };
  }

  // Forget a saved account. Returns whether it existed.
  removeAccount(accountId: string): boolean {
    const index = this.loadIndex();
    if (!index.accounts.some((account) => account.id === accountId)) {
      return false;
    }
    // Existence invariant (design §2/§5): index entry removed FIRST, credential
    // file SECOND. A crash in between leaves an orphan credential the next
    // initialize() GCs — the account is already gone from the authoritative index.
    this.writeIndex({
      version: 1,
      accounts: index.accounts.filter((account) => account.id !== accountId),
    });
    rmSync(this.credentialFilePath(accountId), { force: true });
    return true;
  }

  // Derive the active account from the live auth file (design §2). Never trusts a
  // stored pointer:
  //   - identity matches a saved account by (issuerKey, userId) → that id active
  //   - a parseable identity Paseo hasn't saved → unsavedActive: { email }
  //   - legacy / unparseable / identity-less but present → unsavedActive: { email: null }
  //   - missing file → both null
  resolveActiveAccount(): {
    activeAccountId: string | null;
    unsavedActive: { email: string | null } | null;
  } {
    let raw: string;
    try {
      raw = readFileSync(this.liveAuthPath, "utf8");
    } catch {
      // No live file → nobody is signed in on the host.
      return { activeAccountId: null, unsavedActive: null };
    }
    const identity = extractGrokIdentity(parseGrokAuthFile(raw));
    if (identity === null) {
      // File present but legacy / unparseable / identity-less: "someone is
      // signed in, we can't tell who" (design §2, §7 G5).
      return { activeAccountId: null, unsavedActive: { email: null } };
    }
    const index = this.loadIndex();
    const match = index.accounts.find((account) => accountMatchesIdentity(account, identity));
    if (!match) {
      // A parseable identity Paseo hasn't saved (external sign-in).
      return { activeAccountId: null, unsavedActive: { email: identity.email } };
    }
    this.repairStaleExpiry(index, match, identity);
    return { activeAccountId: match.id, unsavedActive: null };
  }

  // Copy the live auth file into backups/ and rotate. Returns the new backup
  // path, or null when there is no live file.
  backupLiveFile(): string | null {
    if (!existsSync(this.liveAuthPath)) {
      return null;
    }
    const backupPath = backupFileToDir(
      this.liveAuthPath,
      this.backupsDirPath,
      this.timestampForFilename(),
    );
    // Prune protection (design §2): keep the newest BACKUP_KEEP_COUNT, plus the
    // single newest backup whose identity is NOT covered by a saved account —
    // that snapshot may be the only recoverable copy of an external sign-in that
    // harvest couldn't auto-save. Unparseable / identity-less content counts as
    // an unmatched identity.
    const protectedBackup = this.newestUnmatchedBackup(this.savedMatchKeys());
    prunePrivateBackups(
      this.backupsDirPath,
      BACKUP_KEEP_COUNT,
      (filename) => filename === protectedBackup,
    );
    return backupPath;
  }

  // Stamp lastActivatedAt (called by Step 5 after a successful switch). The
  // loaded index is a fresh parse this call owns, so mutate it directly.
  markActivated(accountId: string): void {
    const index = this.loadIndex();
    const account = index.accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      return;
    }
    account.lastActivatedAt = this.nowIso();
    this.writeIndex(index);
  }

  // --- internals ---

  // Delete credential files with no matching index entry (design §2 startup GC).
  private collectOrphanCredentials(): void {
    const knownIds = new Set(this.loadIndex().accounts.map((account) => account.id));
    for (const filename of this.listCredentialFilenames()) {
      const accountId = credentialFilenameToId(filename);
      if (accountId === null || !knownIds.has(accountId)) {
        rmSync(join(this.credentialsDirPath, filename), { force: true });
      }
    }
  }

  // Self-healing metadata (design §2): the live file is ground truth for the
  // active account's expiry, so refresh the stored copy when it drifts. Safe and
  // optional — skipped when the live identity has no expiry or it already agrees.
  private repairStaleExpiry(
    index: IndexFile,
    match: StoredAccountMeta,
    identity: GrokIdentity,
  ): void {
    if (identity.expiresAt === null || identity.expiresAt === match.expiresAt) {
      return;
    }
    // `match` is an element of the freshly-parsed `index` this call owns.
    match.expiresAt = identity.expiresAt;
    this.writeIndex(index);
  }

  // Composite (issuerKey, userId) keys of every saved account, for testing
  // whether a live/backup identity is "covered".
  private savedMatchKeys(): Set<string> {
    return new Set(
      this.loadIndex().accounts.map((account) =>
        identityMatchKey(accountIssuerKey(account), account.userId),
      ),
    );
  }

  // The newest backup filename whose parsed identity is not covered by a saved
  // account, or null when every backup is covered. Unreadable, unparseable, or
  // identity-less content counts as unmatched (and thus protectable).
  private newestUnmatchedBackup(savedKeys: Set<string>): string | null {
    for (const filename of this.listBackupFilenamesNewestFirst()) {
      if (!this.backupIdentityIsCovered(filename, savedKeys)) {
        return filename;
      }
    }
    return null;
  }

  private backupIdentityIsCovered(filename: string, savedKeys: Set<string>): boolean {
    let raw: string;
    try {
      raw = readFileSync(join(this.backupsDirPath, filename), "utf8");
    } catch {
      return false;
    }
    const identity = extractGrokIdentity(parseGrokAuthFile(raw));
    if (identity === null) {
      return false;
    }
    return savedKeys.has(identityMatchKey(identity.issuerKey, identity.userId));
  }

  private listBackupFilenamesNewestFirst(): string[] {
    let filenames: string[];
    try {
      filenames = readdirSync(this.backupsDirPath);
    } catch {
      return [];
    }
    return (
      filenames
        .filter(
          (name) =>
            name.startsWith(BACKUP_FILENAME_PREFIX) && name.endsWith(BACKUP_FILENAME_SUFFIX),
        )
        // Descending sort (newest-timestamp filename first) via localeCompare —
        // avoids `.reverse()` (lint no-array-reverse) and `.toReversed()` (not
        // in the build's ES2022 lib).
        .sort((a, b) => b.localeCompare(a))
    );
  }

  private listCredentialFilenames(): string[] {
    try {
      return readdirSync(this.credentialsDirPath).filter((name) =>
        name.endsWith(CREDENTIAL_SUFFIX),
      );
    } catch {
      return [];
    }
  }

  private credentialFilePath(accountId: string): string {
    return join(this.credentialsDirPath, `${accountId}${CREDENTIAL_SUFFIX}`);
  }

  // Load and validate index.json. Missing or corrupt → an empty index (design
  // §2): a bad index must never crash the daemon, and atomic writes make real
  // corruption near-impossible. Log-free by design.
  private loadIndex(): IndexFile {
    let raw: string;
    try {
      raw = readFileSync(this.indexFilePath, "utf8");
    } catch {
      return emptyIndex();
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return emptyIndex();
    }
    const result = IndexFileSchema.safeParse(value);
    return result.success ? result.data : emptyIndex();
  }

  private writeIndex(index: IndexFile): void {
    writePrivateFileAtomicSync(this.indexFilePath, `${JSON.stringify(index, null, 2)}\n`);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private timestampForFilename(): string {
    // Filesystem-safe: ISO 8601 with `:` (illegal in Windows filenames) replaced
    // by `-`. Fixed-width, so lexicographic filename order stays chronological.
    return this.now().toISOString().replace(/:/g, "-");
  }
}

function emptyIndex(): IndexFile {
  return { version: 1, accounts: [] };
}

// Backoff schedule for the live-file swap: one retry per entry after the first
// attempt (design §4 step 4 / spike S4). Windows raises EPERM on the rename
// while grok still holds auth.json for a few hundred ms.
const SWAP_RETRY_BACKOFFS_MS = [100, 300, 900];

// A rename racing grok's file handle surfaces as EPERM on Windows (EACCES on
// some filesystems). Any other error (ENOSPC, EROFS, …) is not transient and is
// rethrown immediately without retrying.
function isFileBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

// Block the current thread for `ms` without a busy-loop: wait on a throwaway
// SharedArrayBuffer view that is never notified, so the wait always runs the
// full timeout. Used only for the swap's brief EPERM backoff.
function sleepSyncViaAtomics(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The modern issuer key is `<oidc_issuer>::<oidc_client_id>`. Split on the FIRST
// separator (issuer URLs never contain `::`); a key without one — only reachable
// for a lone legacy entry — keeps an empty client id so `accountIssuerKey`
// reconstructs the original exactly.
function splitIssuerKey(issuerKey: string): { oidcIssuer: string; oidcClientId: string } {
  const separatorIndex = issuerKey.indexOf(ISSUER_KEY_SEPARATOR);
  if (separatorIndex === -1) {
    return { oidcIssuer: issuerKey, oidcClientId: "" };
  }
  return {
    oidcIssuer: issuerKey.slice(0, separatorIndex),
    oidcClientId: issuerKey.slice(separatorIndex + ISSUER_KEY_SEPARATOR.length),
  };
}

// Inverse of `splitIssuerKey` — reconstruct the live-file issuer key for matching.
function accountIssuerKey(account: StoredAccountMeta): string {
  return account.oidcClientId === ""
    ? account.oidcIssuer
    : `${account.oidcIssuer}${ISSUER_KEY_SEPARATOR}${account.oidcClientId}`;
}

// Active resolution matches on both the issuer key and the user id (design §2).
function accountMatchesIdentity(account: StoredAccountMeta, identity: GrokIdentity): boolean {
  return account.userId === identity.userId && accountIssuerKey(account) === identity.issuerKey;
}

// A JSON-encoded [issuerKey, userId] tuple: an unambiguous, collision-proof Set
// key (JSON escaping keeps the two halves cleanly separated whatever they hold).
function identityMatchKey(issuerKey: string, userId: string): string {
  return JSON.stringify([issuerKey, userId]);
}

// accountId = the grok user_id (design §2), which `extractGrokIdentity`
// guarantees is non-empty. The sha256 fallback is a defensive backstop for the
// theoretical case of an empty user id.
function computeAccountId(identity: GrokIdentity): string {
  if (identity.userId.length > 0) {
    return identity.userId;
  }
  return createHash("sha256")
    .update(`${identity.issuerKey}${ISSUER_KEY_SEPARATOR}${identity.email ?? ""}`)
    .digest("hex");
}

function credentialFilenameToId(filename: string): string | null {
  if (!filename.endsWith(CREDENTIAL_SUFFIX)) {
    return null;
  }
  const id = filename.slice(0, filename.length - CREDENTIAL_SUFFIX.length);
  return id.length > 0 ? id : null;
}
