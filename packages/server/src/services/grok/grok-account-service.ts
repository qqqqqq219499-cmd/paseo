import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GrokAccount, GrokAccountQuota, GrokAccountsState } from "../../server/messages.js";
import type { ProviderApiFetch } from "../quota-fetcher/provider.js";
import type { GrokAccountStore, StoredAccountMeta } from "./grok-account-store.js";
import {
  extractBearerToken,
  extractGrokIdentity,
  type GrokAuthEntry,
  normalizeExpiresAt,
  parseGrokAuthFile,
  type ParsedGrokAuthFile,
} from "./grok-auth-file.js";
import {
  type GrokLoginEvent,
  type GrokLoginMode,
  GrokLoginOrchestrator,
  type GrokLoginStartResult,
} from "./grok-login-orchestrator.js";
import { GrokRefreshError, refreshGrokToken } from "./grok-oauth-refresh.js";
import { fetchGrokWeeklyQuota } from "./grok-weekly-quota.js";

// The deep module & facade over the grok multi-account machinery (task design
// §4/§5/§9). It owns:
//   - ONE async mutex serializing every mutation. User intents (switch, remove)
//     FAIL FAST while it is held; login-finalize (internal persistence of a
//     completed login) QUEUES and always runs (design §4).
//   - The switch state machine: harvest the live file, back it up, atomically
//     swap in the target credential, re-derive the active account (design §4).
//   - Remove guards, including the force-remove-active extra backup (design §5).
//   - Per-account quota with on-demand token refresh + atomic re-store, all
//     best-effort and structurally unable to block the account list (design §9).
//   - `onChange` fan-out (ReClaude pattern) so the daemon can broadcast state.
//
// STRUCTURAL SECRECY (task design §1 rule 3): credential bytes flow through the
// store and the billing/refresh readers but never appear in any object this
// service returns. `getState()` is shaped by the protocol `GrokAccountsState`
// type, which has no field capable of holding token material.

// One Paseo-launched grok agent still running (injected by the daemon from the
// agent manager). A non-empty list blocks an unforced switch (design §4 step 1).
export interface GrokActiveAgent {
  agentId: string;
  title: string | null;
}

// The subset of `GrokLoginOrchestrator` the service depends on, so tests can
// inject a fake that captures the `onEvent` sink and drives lifecycle events.
export interface GrokLoginOrchestratorLike {
  start(options?: { mode?: GrokLoginMode }): Promise<GrokLoginStartResult>;
  cancel(loginId: string): Promise<boolean>;
  isInProgress(): boolean;
}

export interface GrokAccountServiceOptions {
  store: GrokAccountStore;
  // Live Paseo-launched grok agents; a non-empty list blocks an unforced switch.
  listActiveGrokAgents: () => GrokActiveAgent[];
  // Shared fetch seam handed to the billing/refresh readers.
  fetchApi: ProviderApiFetch;
  // Injected clock (quota timestamps, TTL cache, refresh-lead check).
  now?: () => Date;
  // Login orchestrator factory. Defaults to a real orchestrator over the store's
  // staging dir; tests inject a fake to drive `onEvent` deterministically.
  createLoginOrchestrator?: (onEvent: (event: GrokLoginEvent) => void) => GrokLoginOrchestratorLike;
  // xAI token refresh + weekly-quota readers, injected in tests.
  refreshToken?: typeof refreshGrokToken;
  fetchWeekly?: typeof fetchGrokWeeklyQuota;
  // Per-account quota cache TTL (default 5 min).
  quotaTtlMs?: number;
  // Managed-config detector (design §7 G10). Default is a best-effort filesystem
  // probe; the real deployment-key signal is not yet confirmed.
  detectManagedConfig?: () => boolean;
}

export type GrokServiceErrorCode =
  | "grok_mutation_in_progress"
  | "grok_account_not_found"
  | "grok_switch_failed"
  | "grok_remove_failed";

// Typed domain error mapped 1:1 onto the `rpc_error` codes (design §6). Each
// code has exactly one trigger so the client can react precisely.
export class GrokServiceError extends Error {
  constructor(
    readonly code: GrokServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GrokServiceError";
  }
}

export type GrokSwitchResult =
  | { outcome: "switched"; activeAccountId: string | null }
  | { outcome: "blocked"; blockingAgents: GrokActiveAgent[] };

export type GrokRemoveResult = { outcome: "removed" } | { outcome: "blocked_active_account" };

export type GrokQuotaFailoverResult =
  | {
      outcome: "switched" | "already_switched";
      previousAccountId: string | null;
      activeAccountId: string;
    }
  | {
      outcome: "unavailable";
      reason: "no_alternate_account" | "other_agents_running";
      blockingAgents?: GrokActiveAgent[];
    };

export interface GrokQuotaFailoverInput {
  agentId: string | null;
  failedAccountId: string | null;
  excludedAccountIds: readonly string[];
}

export interface GrokQuotaFailoverController {
  getActiveAccountId(): string | null;
  rotateAfterQuotaExhaustion(input: GrokQuotaFailoverInput): Promise<GrokQuotaFailoverResult>;
}

// The wire-facing login lifecycle, kept in the shape the protocol expects.
type GrokLoginWireState = GrokAccountsState["login"];

interface QuotaOutcome {
  quota: GrokAccountQuota;
  needsReauth: boolean;
}

const DEFAULT_QUOTA_TTL_MS = 5 * 60 * 1000;
// Per-account quota is best-effort: cap each account's whole refresh+bill dance
// so one slow account cannot delay the returned list (design §9).
const QUOTA_PER_ACCOUNT_TIMEOUT_MS = 5_000;
// Refresh a stored token this long before it expires (the universal xAI lead;
// research/xai-oauth-refresh-protocol.md).
const REFRESH_LEAD_MS = 5 * 60 * 1000;
const MANAGED_CONFIG_FILE = "config.toml";

export class GrokAccountService {
  private readonly store: GrokAccountStore;
  private readonly listActiveGrokAgents: () => GrokActiveAgent[];
  private readonly fetchApi: ProviderApiFetch;
  private readonly now: () => Date;
  private readonly createLoginOrchestrator: (
    onEvent: (event: GrokLoginEvent) => void,
  ) => GrokLoginOrchestratorLike;
  private readonly refreshToken: typeof refreshGrokToken;
  private readonly fetchWeekly: typeof fetchGrokWeeklyQuota;
  private readonly quotaTtlMs: number;
  private readonly detectManagedConfig: () => boolean;

  private orchestrator: GrokLoginOrchestratorLike | null = null;
  private loginState: GrokLoginWireState = {
    state: "idle",
    loginId: null,
    accountId: null,
    error: null,
  };
  private readonly changeListeners = new Set<(state: GrokAccountsState) => void>();
  private readonly quotaCache = new Map<string, { at: number; outcome: QuotaOutcome }>();

  // Mutex as a promise-chain with an in-flight counter (design §4). `mutations`
  // is incremented SYNCHRONOUSLY the instant an op is enqueued and decremented
  // when it settles, so `tryRunExclusive`'s check-then-set is race-free.
  private mutations = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: GrokAccountServiceOptions) {
    this.store = options.store;
    this.listActiveGrokAgents = options.listActiveGrokAgents;
    this.fetchApi = options.fetchApi;
    this.now = options.now ?? (() => new Date());
    this.createLoginOrchestrator =
      options.createLoginOrchestrator ??
      ((onEvent) => new GrokLoginOrchestrator({ stagingDir: options.store.stagingDir, onEvent }));
    this.refreshToken = options.refreshToken ?? refreshGrokToken;
    this.fetchWeekly = options.fetchWeekly ?? fetchGrokWeeklyQuota;
    this.quotaTtlMs = options.quotaTtlMs ?? DEFAULT_QUOTA_TTL_MS;
    this.detectManagedConfig =
      options.detectManagedConfig ??
      (() => defaultDetectManagedConfig(this.store.liveAuthFilePath));
  }

  // Ready the store (dir tree, orphan GC, staging sweep) and build the login
  // orchestrator around this service's event handler.
  initialize(): void {
    this.store.initialize();
    this.orchestrator = this.createLoginOrchestrator((event) => this.handleLoginEvent(event));
  }

  // Subscribe to state changes (ReClaude pattern). Returns an unsubscribe fn.
  onChange(listener: (state: GrokAccountsState) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  // Start a login. authUrl/userCode ride ONLY the returned value (design §7 G1);
  // the orchestrator's `awaiting_browser` event flips the shared state to
  // in_progress but never carries the URL. `params.mode` picks the sign-in
  // method for this login (client's per-add-account choice); omitting it lets
  // the orchestrator use its configured default.
  startLogin(params?: { mode?: "oauth" | "device-auth" }): Promise<GrokLoginStartResult> {
    return this.requireOrchestrator().start({ mode: params?.mode });
  }

  cancelLogin(loginId: string): Promise<boolean> {
    return this.requireOrchestrator().cancel(loginId);
  }

  // Switch the active account (design §4). Fails fast with
  // grok_mutation_in_progress if another mutation holds the mutex. `async` so the
  // synchronous fail-fast throw surfaces uniformly as a rejected promise; the
  // check-then-set still runs synchronously (no await precedes tryRunExclusive).
  async switchAccount(params: { accountId: string; force?: boolean }): Promise<GrokSwitchResult> {
    return this.tryRunExclusive(() => this.performSwitch(params));
  }

  getActiveAccountId(): string | null {
    return this.store.resolveActiveAccount().activeAccountId;
  }

  // Automatic recovery is serialized with every other account mutation. The
  // failed process reports the account it was bound to, which may differ from
  // the current live auth file when another recovery already switched first.
  rotateAfterQuotaExhaustion(input: GrokQuotaFailoverInput): Promise<GrokQuotaFailoverResult> {
    return this.runExclusive(() => this.performQuotaFailover(input));
  }

  // Forget a saved account (design §5). Fails fast like switch.
  async removeAccount(params: { accountId: string; force?: boolean }): Promise<GrokRemoveResult> {
    return this.tryRunExclusive(() => this.performRemove(params));
  }

  // Assemble the current state. Cheap (no network) unless `refreshQuota` is set,
  // in which case per-account quota is fetched concurrently and best-effort —
  // quota NEVER throws out of here and NEVER blocks the returned account list.
  async getState({ refreshQuota }: { refreshQuota?: boolean } = {}): Promise<GrokAccountsState> {
    const base = this.buildBaseState();
    if (!refreshQuota) {
      return base;
    }
    const accounts = await Promise.all(
      base.accounts.map((account) => this.accountWithQuota(account, base.activeAccountId)),
    );
    return { ...base, accounts };
  }

  // --- mutex ------------------------------------------------------------------

  // Enqueue `fn` on the mutex chain, always running it (used by login-finalize).
  // Increments the in-flight counter synchronously so a concurrent
  // `tryRunExclusive` sees the mutex as held.
  private runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    this.mutations += 1;
    const result = this.chain.then(() => fn());
    // Advance the chain past this op regardless of its outcome so the next op
    // waits for it but never inherits its rejection.
    this.chain = settleQuietly(result);
    return result.finally(() => {
      this.mutations -= 1;
    });
  }

  // Enqueue `fn` ONLY if the mutex is free; otherwise throw
  // grok_mutation_in_progress. The check-then-set runs synchronously (no await
  // before `runExclusive` increments the counter), so two user intents arriving
  // in the same tick can never both acquire it (design §4).
  private tryRunExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.mutations > 0) {
      throw new GrokServiceError(
        "grok_mutation_in_progress",
        "another grok account operation is in progress",
      );
    }
    return this.runExclusive(fn);
  }

  // --- switch (design §4) -----------------------------------------------------

  // Synchronous by construction: every step is a local filesystem op, so the
  // whole switch runs to completion inside one mutex turn with no await points.
  private performSwitch({
    accountId,
    force,
  }: {
    accountId: string;
    force?: boolean;
  }): GrokSwitchResult {
    // Step 0: unknown target → grok_account_not_found.
    if (!this.store.listAccounts().some((account) => account.id === accountId)) {
      throw new GrokServiceError("grok_account_not_found", `no saved grok account "${accountId}"`);
    }

    // Step 1: fresh derived active from the live file.
    const { activeAccountId } = this.store.resolveActiveAccount();

    // Step 2: running-agent guard (nothing is touched when blocked).
    const agents = this.listActiveGrokAgents();
    if (agents.length > 0 && force !== true) {
      return { outcome: "blocked", blockingAgents: agents };
    }

    // Step 3: harvest whatever grok currently has so no sign-in is lost.
    const skipSwap = this.harvestLiveFile(accountId, activeAccountId);

    if (!skipSwap) {
      // Step 4: timestamped backup of the live file (bounds loss on any crash).
      this.store.backupLiveFile();

      // Step 5: atomically swap in the target credential. A missing credential
      // or a rename that never succeeds leaves the previous live file intact.
      const targetRaw = this.store.readCredentialRaw(accountId);
      if (targetRaw === null) {
        throw new GrokServiceError(
          "grok_switch_failed",
          `credential file for "${accountId}" is missing`,
        );
      }
      try {
        this.store.swapLiveAuthFile(targetRaw);
      } catch (error) {
        throw new GrokServiceError("grok_switch_failed", describeError(error));
      }
    }

    // Step 6: stamp activation, re-derive active from the live file (never the
    // assumed target — bounds the TOCTOU window, design §7 G6), broadcast.
    this.store.markActivated(accountId);
    const active = this.store.resolveActiveAccount();
    this.emitChange();
    return { outcome: "switched", activeAccountId: active.activeAccountId };
  }

  private performQuotaFailover(input: GrokQuotaFailoverInput): GrokQuotaFailoverResult {
    const blockingAgents = this.listActiveGrokAgents().filter(
      (agent) => input.agentId === null || agent.agentId !== input.agentId,
    );
    if (blockingAgents.length > 0) {
      return { outcome: "unavailable", reason: "other_agents_running", blockingAgents };
    }

    const accounts = this.store.listAccounts();
    const currentAccountId = this.store.resolveActiveAccount().activeAccountId;
    const excluded = new Set(input.excludedAccountIds);
    if (input.failedAccountId !== null) {
      excluded.add(input.failedAccountId);
    }

    if (
      currentAccountId !== null &&
      currentAccountId !== input.failedAccountId &&
      !excluded.has(currentAccountId) &&
      !this.isKnownUnavailableForFailover(currentAccountId)
    ) {
      return {
        outcome: "already_switched",
        previousAccountId: input.failedAccountId,
        activeAccountId: currentAccountId,
      };
    }

    const currentIndex = accounts.findIndex((account) => account.id === currentAccountId);
    for (let offset = 0; offset < accounts.length; offset += 1) {
      const index = currentIndex < 0 ? offset : (currentIndex + offset + 1) % accounts.length;
      const candidate = accounts[index];
      if (
        candidate.id === currentAccountId ||
        excluded.has(candidate.id) ||
        this.isKnownUnavailableForFailover(candidate.id)
      ) {
        continue;
      }

      const result = this.performSwitch({ accountId: candidate.id, force: true });
      if (result.outcome !== "switched" || result.activeAccountId === null) {
        throw new GrokServiceError("grok_switch_failed", "automatic grok account switch failed");
      }
      return {
        outcome: "switched",
        previousAccountId: currentAccountId,
        activeAccountId: result.activeAccountId,
      };
    }

    return { outcome: "unavailable", reason: "no_alternate_account" };
  }

  private isKnownUnavailableForFailover(accountId: string): boolean {
    const cached = [
      this.quotaCache.get(quotaCacheKey(accountId, true)),
      this.quotaCache.get(quotaCacheKey(accountId, false)),
    ]
      .filter((entry): entry is { at: number; outcome: QuotaOutcome } => entry !== undefined)
      .filter((entry) => this.now().getTime() - entry.at < this.quotaTtlMs)
      .sort((left, right) => right.at - left.at)[0];
    if (!cached) {
      return false;
    }
    return (
      cached.outcome.needsReauth ||
      (cached.outcome.quota.status === "ok" && (cached.outcome.quota.weeklyPercentUsed ?? 0) >= 100)
    );
  }

  // Harvest step (design §4 step 2). Returns whether the caller should SKIP the
  // backup+swap because the live file is already the correct, newest copy of the
  // target (the switch-to-active "live newer" case).
  private harvestLiveFile(accountId: string, activeAccountId: string | null): boolean {
    const liveRaw = this.store.readLiveAuthRaw();
    if (liveRaw === null) {
      return false;
    }
    const parsed = parseGrokAuthFile(liveRaw);
    const identity = extractGrokIdentity(parsed);
    if (identity === null) {
      // Legacy / unparseable / identity-less: never harvested or auto-saved
      // (design §7 G5). It is still backed up in step 4 before the swap.
      return false;
    }

    if (activeAccountId === accountId) {
      // Switch-to-active: the live file already belongs to the target. Reconcile
      // the stored copy against the live file by "newer wins" — never a blind
      // overwrite in either direction (design §4 step 2 / verifier finding 1).
      if (this.liveIsNewer(accountId, parsed)) {
        // Fresh re-login sits in the live file → harvest it and skip the swap.
        this.store.upsertFromParsedAuth(parsed, liveRaw);
        return true;
      }
      // Stored copy is newer (e.g. a quota-path refresh re-stored it) → keep the
      // harvest a no-op and let the swap restore the newer stored bytes.
      return false;
    }

    // Live identity belongs to a DIFFERENT saved account (refresh-retention: grok
    // rewrote a refreshed token in place) or to no saved account (auto-save so no
    // external sign-in is silently lost). Both persist the live bytes verbatim.
    this.store.upsertFromParsedAuth(parsed, liveRaw);
    return false;
  }

  // Whether the LIVE file's selected entry is newer than the target's STORED
  // credential (design §4 step 2): compare `create_time`, tiebreak `expires_at`;
  // when neither is decisive (missing / unparseable / equal) prefer live so a
  // fresh re-login is never clobbered by stale stored bytes.
  private liveIsNewer(accountId: string, liveParsed: ParsedGrokAuthFile): boolean {
    const storedRaw = this.store.readCredentialRaw(accountId);
    if (storedRaw === null) {
      return true;
    }
    const liveEntry = selectedEntry(liveParsed);
    const storedEntry = selectedEntry(parseGrokAuthFile(storedRaw));
    const byCreate = compareEntryTimes(liveEntry?.create_time, storedEntry?.create_time);
    if (byCreate !== 0) {
      return byCreate > 0;
    }
    const byExpiry = compareEntryTimes(liveEntry?.expires_at, storedEntry?.expires_at);
    if (byExpiry !== 0) {
      return byExpiry > 0;
    }
    return true;
  }

  // --- remove (design §5) -----------------------------------------------------

  private performRemove({
    accountId,
    force,
  }: {
    accountId: string;
    force?: boolean;
  }): GrokRemoveResult {
    if (!this.store.listAccounts().some((account) => account.id === accountId)) {
      throw new GrokServiceError("grok_account_not_found", `no saved grok account "${accountId}"`);
    }
    const { activeAccountId } = this.store.resolveActiveAccount();
    const isActive = accountId === activeAccountId;
    if (isActive && force !== true) {
      return { outcome: "blocked_active_account" };
    }
    try {
      if (isActive && force === true) {
        // Force-removing the active account: write ONE more backup of the live
        // file first, then forget the saved copy — the live auth.json is never
        // touched, so deletion can't remove the only recoverable copy (design §5).
        this.store.backupLiveFile();
      }
      this.store.removeAccount(accountId);
    } catch (error) {
      throw new GrokServiceError("grok_remove_failed", describeError(error));
    }
    this.emitChange();
    return { outcome: "removed" };
  }

  // --- login lifecycle --------------------------------------------------------

  private handleLoginEvent(event: GrokLoginEvent): void {
    switch (event.phase) {
      case "awaiting_browser":
        this.loginState = {
          state: "in_progress",
          loginId: event.loginId,
          accountId: null,
          error: null,
        };
        this.emitChange();
        return;
      case "completed":
        this.finalizeCompletedLogin(event);
        return;
      case "failed":
        this.loginState = {
          state: "failed",
          loginId: event.loginId,
          accountId: null,
          failureReason: event.reason,
          error: event.error,
        };
        this.emitChange();
        return;
    }
  }

  // Persist a completed login through the mutex (QUEUES behind an in-flight
  // switch/remove, never fails fast — design §4). The login already succeeded;
  // only persistence remains, so it must always run. Fire-and-forget: it catches
  // its own errors so there is never an unhandled rejection.
  private finalizeCompletedLogin(event: Extract<GrokLoginEvent, { phase: "completed" }>): void {
    void this.persistCompletedLogin(event);
  }

  private async persistCompletedLogin(
    event: Extract<GrokLoginEvent, { phase: "completed" }>,
  ): Promise<void> {
    try {
      const result = await this.runExclusive(() =>
        this.store.upsertFromParsedAuth(event.parsed, event.rawBytes),
      );
      this.loginState = {
        state: "completed",
        loginId: event.loginId,
        accountId: result?.accountId ?? null,
        error: null,
      };
    } catch {
      this.loginState = {
        state: "failed",
        loginId: event.loginId,
        accountId: null,
        failureReason: "error",
        error: "Failed to save the completed login",
      };
    }
    this.emitChange();
  }

  // --- state assembly ---------------------------------------------------------

  // The cheap, synchronous state: saved accounts (quota placeholder), derived
  // active, managed-config flag, and the current login lifecycle. Used by every
  // broadcast and by `getState` before optional quota enrichment.
  private buildBaseState(): GrokAccountsState {
    const accounts = this.store.listAccounts().map((meta) => toBaseAccount(meta));
    const { activeAccountId, unsavedActive } = this.store.resolveActiveAccount();
    return {
      accounts,
      activeAccountId,
      unsavedActive,
      managedConfigActive: this.detectManagedConfig(),
      login: this.loginState,
    };
  }

  private emitChange(): void {
    if (this.changeListeners.size === 0) {
      return;
    }
    const state = this.buildBaseState();
    for (const listener of this.changeListeners) {
      try {
        listener(state);
      } catch {
        // A misbehaving listener must not break the fan-out or a mutation.
      }
    }
  }

  // --- per-account quota (design §9) ------------------------------------------

  private async accountWithQuota(
    account: GrokAccount,
    activeAccountId: string | null,
  ): Promise<GrokAccount> {
    const isActive = account.id === activeAccountId;
    // Key the cache on active-ness too: switching accounts flips which source
    // (live file vs stored snapshot) feeds the quota, so a stale parked result
    // must never shadow a freshly-active read (or vice versa).
    const cacheKey = quotaCacheKey(account.id, isActive);
    const cached = this.quotaCache.get(cacheKey);
    if (cached && this.now().getTime() - cached.at < this.quotaTtlMs) {
      return { ...account, quota: cached.outcome.quota, needsReauth: cached.outcome.needsReauth };
    }
    const outcome = await this.computeQuota(account.id, isActive);
    this.quotaCache.set(cacheKey, { at: this.now().getTime(), outcome });
    return { ...account, quota: outcome.quota, needsReauth: outcome.needsReauth };
  }

  // Best-effort quota for one account, capped so it can never stall the list.
  private computeQuota(accountId: string, isActive: boolean): Promise<QuotaOutcome> {
    const unknownQuota: QuotaOutcome = { quota: { status: "unknown" }, needsReauth: false };
    return this.raceTimeout(
      this.computeQuotaInner(accountId, isActive),
      QUOTA_PER_ACCOUNT_TIMEOUT_MS,
      unknownQuota,
    ).catch(() => unknownQuota);
  }

  // Read the stored credential, refresh it on demand when expired-or-within-lead
  // (re-storing atomically), then read the weekly SuperGrok quota. Never throws:
  // every failure funnels to a quota status of "unknown" (with needsReauth only
  // for a dead refresh token).
  private async computeQuotaInner(accountId: string, isActive: boolean): Promise<QuotaOutcome> {
    const unknownQuota: QuotaOutcome = { quota: { status: "unknown" }, needsReauth: false };
    // The derived-active account's freshest credential lives in the LIVE auth
    // file: grok refreshes only the active file, so this account's stored
    // snapshot slowly ages out and its refresh_token eventually dies (xAI
    // rotation + ~7-day window). Reading the snapshot would then misreport
    // `needsReauth` for the very account currently in use. Prefer the live
    // file's fresh credential (syncing it back into the snapshot); fall back to
    // the snapshot when the live file was swapped out mid-read or is identity-less.
    const liveRaw = isActive ? this.readActiveLiveCredential(accountId) : null;
    const storedRaw = liveRaw ?? this.store.readCredentialRaw(accountId);
    if (storedRaw === null) {
      return unknownQuota;
    }
    const parsed = parseGrokAuthFile(storedRaw);
    const entry = selectedEntry(parsed);
    let token = extractBearerToken(parsed);
    const refreshTokenValue = entry?.refresh_token ?? null;
    const expiresAt = entry ? normalizeExpiresAt(entry.expires_at) : null;

    if (refreshTokenValue !== null && this.tokenNeedsRefresh(expiresAt)) {
      try {
        const refreshed = await this.refreshToken(this.fetchApi, refreshTokenValue, {
          now: this.now,
        });
        this.reStoreRefreshed({ storedRaw, parsed, refreshed });
        token = refreshed.accessToken;
      } catch (error) {
        if (error instanceof GrokRefreshError && error.kind === "invalid_grant") {
          // Dead refresh token (revoked / 7-day window lapsed): prompt re-login
          // and stop hitting the endpoint (research §gotcha 7).
          return { quota: { status: "unknown" }, needsReauth: true };
        }
        return unknownQuota;
      }
    }

    if (token === null) {
      return unknownQuota;
    }
    try {
      const weekly = await this.fetchWeekly(this.fetchApi, token);
      return {
        quota: {
          status: "ok",
          weeklyPercentUsed: weekly.percentUsed,
          resetsAt: weekly.resetsAt,
          breakdown: weekly.breakdown,
          fetchedAt: this.now().toISOString(),
        },
        needsReauth: false,
      };
    } catch {
      return unknownQuota;
    }
  }

  // The live auth file is the freshest copy of the active account's credential
  // (grok refreshes only the active file). Return its verbatim bytes when they
  // still belong to `accountId` — guarding a switch that landed between deriving
  // the active id and this read — and sync them into the account's stored
  // snapshot so a later parked read starts current. Writes the SNAPSHOT only,
  // never the live file (quota-path invariant). Returns null to fall back to the
  // stored snapshot.
  private readActiveLiveCredential(accountId: string): string | null {
    const liveRaw = this.store.readLiveAuthRaw();
    if (liveRaw === null) {
      return null;
    }
    const parsed = parseGrokAuthFile(liveRaw);
    const identity = extractGrokIdentity(parsed);
    if (identity === null || identity.userId !== accountId) {
      // Live file swapped out mid-read, or identity-less: use the snapshot.
      return null;
    }
    try {
      this.store.upsertFromParsedAuth(parsed, liveRaw);
    } catch {
      // Snapshot sync is best-effort; the fresh live bytes still bill this read.
    }
    return liveRaw;
  }

  private tokenNeedsRefresh(expiresAt: string | null): boolean {
    if (expiresAt === null) {
      return false;
    }
    const expiryMs = Date.parse(expiresAt);
    if (Number.isNaN(expiryMs)) {
      return false;
    }
    return expiryMs <= this.now().getTime() + REFRESH_LEAD_MS;
  }

  // Atomically re-store a refreshed credential into the account's OWN saved file
  // (design §9 re-store safety): patch the selected entry's key/refresh_token/
  // expires_at in place and upsert. NEVER touches the live auth.json, and the
  // atomic rename means a concurrent switch reads either the old or new complete
  // file — the race is benign. Best-effort: a persist failure must not break the
  // quota display, which continues with the already-fresh token.
  private reStoreRefreshed({
    storedRaw,
    parsed,
    refreshed,
  }: {
    storedRaw: string;
    parsed: ParsedGrokAuthFile;
    refreshed: { accessToken: string; refreshToken: string | null; expiresAt: string | null };
  }): void {
    const identity = extractGrokIdentity(parsed);
    if (parsed.kind !== "modern" || identity === null) {
      return;
    }
    try {
      const record: unknown = JSON.parse(storedRaw);
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        return;
      }
      const map = record as Record<string, unknown>;
      const target = map[identity.issuerKey];
      if (typeof target !== "object" || target === null || Array.isArray(target)) {
        return;
      }
      const patched: Record<string, unknown> = { ...(target as Record<string, unknown>) };
      patched["key"] = refreshed.accessToken;
      if (refreshed.refreshToken !== null) {
        patched["refresh_token"] = refreshed.refreshToken;
      }
      if (refreshed.expiresAt !== null) {
        patched["expires_at"] = refreshed.expiresAt;
      }
      map[identity.issuerKey] = patched;
      const patchedBytes = `${JSON.stringify(map, null, 2)}\n`;
      // upsert re-derives the id from the (unchanged) identity, so this rewrites
      // the SAME account's credential file — an atomic, same-id re-store.
      this.store.upsertFromParsedAuth(parseGrokAuthFile(patchedBytes), patchedBytes);
    } catch {
      // Re-store is opportunistic; the fresh token still bills this cycle and
      // grok itself re-refreshes on first use of the account.
    }
  }

  // Race `work` against a best-effort timeout, cleaning the timer either way so
  // no dangling handle survives (and the timer is unref'd so it never keeps the
  // process alive).
  private raceTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    });
    return Promise.race([work, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }

  private requireOrchestrator(): GrokLoginOrchestratorLike {
    if (this.orchestrator === null) {
      throw new Error("GrokAccountService.initialize() must be called before use");
    }
    return this.orchestrator;
  }
}

// The per-account quota cache key. Includes active-ness because the active and
// parked reads draw from different credential sources and must not share a slot.
function quotaCacheKey(accountId: string, isActive: boolean): string {
  return `${accountId}:${isActive ? "active" : "parked"}`;
}

// Project one stored account onto the wire shape with a placeholder quota. Never
// carries token bytes — the store's metadata is identity-only by construction.
function toBaseAccount(meta: StoredAccountMeta): GrokAccount {
  return {
    id: meta.id,
    email: meta.email,
    name: fullName(meta.firstName, meta.lastName),
    teamId: meta.teamId ?? null,
    authMode: meta.authMode ?? null,
    expiresAt: meta.expiresAt ?? null,
    addedAt: meta.addedAt,
    lastActivatedAt: meta.lastActivatedAt ?? null,
    quota: null,
    needsReauth: false,
  };
}

function fullName(
  first: string | null | undefined,
  last: string | null | undefined,
): string | null {
  const name = [first, last]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
  return name.length > 0 ? name : null;
}

// The entry the codec would select (single entry, else the `auth.x.ai` issuer),
// reusing `extractGrokIdentity`'s selection via the resolved issuer key so the
// selection rule lives in one place (grok-auth-file.ts).
function selectedEntry(parsed: ParsedGrokAuthFile): GrokAuthEntry | null {
  if (parsed.kind !== "modern") {
    return null;
  }
  const identity = extractGrokIdentity(parsed);
  if (identity === null) {
    return null;
  }
  return parsed.entries.find((ref) => ref.issuerKey === identity.issuerKey)?.entry ?? null;
}

// Compare two polymorphic auth-file timestamps. Returns 1 (live newer), -1
// (stored newer), or 0 when either side is missing/unparseable or they are
// equal — 0 means "defer to the next tiebreak, then prefer live".
function compareEntryTimes(
  liveValue: string | number | null | undefined,
  storedValue: string | number | null | undefined,
): number {
  const live = timestampMs(liveValue);
  const stored = timestampMs(storedValue);
  if (live === null || stored === null || live === stored) {
    return 0;
  }
  return live > stored ? 1 : -1;
}

function timestampMs(value: string | number | null | undefined): number | null {
  const iso = normalizeExpiresAt(value);
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// Resolve after `promise` settles, swallowing any rejection — used to advance
// the mutex chain so the next op waits for the previous without inheriting its
// failure.
async function settleQuietly(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Intentionally ignored; the op's own caller already saw the outcome.
  }
}

// Best-effort managed-config probe (design §7 G10). A static `api_key` (or a
// `deployment` key) in config.toml wins over auth.json in grok's credential
// resolution, so a swapped auth.json would have no effect — exactly the case the
// UI must surface by disabling switching. Anything short of that returns false.
//
// NOTE: we deliberately do NOT treat `managed_config.lock` as a signal — spike
// S3 confirmed that 0-byte lock file is present in EVERY normal grok home
// (including this host's active pool home), so keying on it would wrongly flag
// every machine and disable switching for everyone.
// TODO(managedConfig): confirm grok's authoritative deployment/managed marker.
function defaultDetectManagedConfig(liveAuthFilePath: string): boolean {
  const home = dirname(liveAuthFilePath);
  try {
    const configPath = join(home, MANAGED_CONFIG_FILE);
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      if (/^\s*(?:deployment|api_key)\s*=/m.test(raw)) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}
