import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type GrokAccountServiceOptions,
  GrokAccountService,
  type GrokActiveAgent,
  type GrokServiceErrorCode,
} from "./grok-account-service.js";
import { GrokAccountStore } from "./grok-account-store.js";
import { extractGrokIdentity, parseGrokAuthFile } from "./grok-auth-file.js";
import type { GrokLoginEvent, GrokLoginStartResult } from "./grok-login-orchestrator.js";
import { GrokRefreshError } from "./grok-oauth-refresh.js";
import { GrokWeeklyQuotaError } from "./grok-weekly-quota.js";
// Reuse the codec's fixture builder so every grok test speaks one auth.json shape.
import { makeModernAuthFile } from "./grok-auth-file.test.js";

// A single-entry modern auth.json for `userId`; overrides tweak the entry (e.g.
// `create_time`, `key`, `expires_at`). Same fixed issuer key for every account,
// so accounts differ only by user id — exactly like the store test.
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

function completedEvent(loginId: string, raw: string): GrokLoginEvent {
  const parsed = parseGrokAuthFile(raw);
  const identity = extractGrokIdentity(parsed);
  if (identity === null) {
    throw new Error("fixture must carry a resolvable identity");
  }
  return { phase: "completed", loginId, parsed, rawBytes: raw, identity };
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: GrokServiceErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "GrokServiceError", code });
}

// fetchApi is never invoked directly — the injected weekly/refresh fakes ignore
// it — so a stub that throws if reached documents that expectation.
const throwingFetch = (async () => {
  throw new Error("fetchApi must not be called directly; inject fetchWeekly/refreshToken");
}) as unknown as GrokAccountServiceOptions["fetchApi"];

interface SetupOptions {
  listActiveGrokAgents?: () => GrokActiveAgent[];
  now?: () => Date;
  refreshToken?: GrokAccountServiceOptions["refreshToken"];
  fetchWeekly?: GrokAccountServiceOptions["fetchWeekly"];
  quotaTtlMs?: number;
  detectManagedConfig?: () => boolean;
  storeWriteLiveFile?: (filePath: string, data: string) => void;
  storeSleepSync?: (ms: number) => void;
}

describe("GrokAccountService", () => {
  let base: string;
  let rootDir: string;
  let liveAuthFilePath: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "grok-service-"));
    rootDir = join(base, "grok-accounts");
    const liveDir = join(base, "grok-home");
    mkdirSync(liveDir, { recursive: true });
    liveAuthFilePath = join(liveDir, "auth.json");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function setup(options: SetupOptions = {}) {
    const store = new GrokAccountStore({
      rootDir,
      liveAuthFilePath,
      now: options.now,
      writeLiveFile: options.storeWriteLiveFile,
      sleepSync: options.storeSleepSync,
    });
    let capturedOnEvent: ((event: GrokLoginEvent) => void) | null = null;
    const orchestrator = {
      start: vi.fn(
        async (): Promise<GrokLoginStartResult> => ({
          outcome: "started",
          loginId: "login-1",
          authUrl: null,
          userCode: null,
        }),
      ),
      cancel: vi.fn(async () => true),
      isInProgress: vi.fn(() => false),
    };
    const service = new GrokAccountService({
      store,
      listActiveGrokAgents: options.listActiveGrokAgents ?? (() => []),
      fetchApi: throwingFetch,
      now: options.now,
      quotaTtlMs: options.quotaTtlMs,
      detectManagedConfig: options.detectManagedConfig,
      createLoginOrchestrator: (onEvent) => {
        capturedOnEvent = onEvent;
        return orchestrator;
      },
      // Default to safe fakes so an accidental quota refresh never hits the real
      // xAI endpoints; quota tests override these.
      refreshToken:
        options.refreshToken ??
        (async () => {
          throw new GrokRefreshError("http_error", "no refresh configured in test");
        }),
      fetchWeekly:
        options.fetchWeekly ??
        (async () => {
          throw new GrokWeeklyQuotaError("http_error", "no weekly quota configured in test");
        }),
    });
    service.initialize();
    return {
      store,
      service,
      orchestrator,
      emit(event: GrokLoginEvent): void {
        if (capturedOnEvent === null) {
          throw new Error("orchestrator onEvent was never captured");
        }
        capturedOnEvent(event);
      },
    };
  }

  function saveAccount(
    store: GrokAccountStore,
    userId: string,
    overrides: Record<string, unknown> = {},
  ): string {
    const raw = authJson(userId, overrides);
    store.upsertFromParsedAuth(parseGrokAuthFile(raw), raw);
    return raw;
  }

  function setLive(raw: string): void {
    writeFileSync(liveAuthFilePath, raw);
  }

  // --- login ------------------------------------------------------------------

  it("startLogin and cancelLogin delegate to the orchestrator", async () => {
    const { service, orchestrator } = setup();
    await service.startLogin();
    expect(orchestrator.start).toHaveBeenCalledTimes(1);
    await service.cancelLogin("login-1");
    expect(orchestrator.cancel).toHaveBeenCalledWith("login-1");
  });

  it("tracks the login lifecycle, persists a completed login, and never broadcasts the authUrl", async () => {
    const { store, service, emit } = setup();
    const broadcasts: unknown[] = [];
    service.onChange((state) => broadcasts.push(state));
    const finalized = new Promise<void>((resolve) => {
      service.onChange((state) => {
        if (state.login.state === "completed") {
          resolve();
        }
      });
    });

    emit({
      phase: "awaiting_browser",
      loginId: "L1",
      authUrl: "https://auth.x.ai/authorize?state=SUPER-SECRET-STATE",
      userCode: null,
    });
    const inProgress = await service.getState();
    expect(inProgress.login).toMatchObject({ state: "in_progress", loginId: "L1" });
    // Design §7 G1: the authorize URL rides only the direct start_login response,
    // never the changed broadcast / state.
    expect(JSON.stringify(broadcasts)).not.toContain("SUPER-SECRET-STATE");
    expect(JSON.stringify(inProgress)).not.toContain("auth.x.ai");

    const raw = authJson("user-c");
    emit(completedEvent("L1", raw));
    await finalized;

    const done = await service.getState();
    expect(done.login).toMatchObject({ state: "completed", loginId: "L1", accountId: "user-c" });
    expect(store.readCredentialRaw("user-c")).toBe(raw);
  });

  it("marks a failed login without touching saved accounts", async () => {
    const { service, emit } = setup();
    emit({ phase: "failed", loginId: "L2", reason: "timed_out", error: "Grok login timed out" });
    const state = await service.getState();
    expect(state.login).toMatchObject({
      state: "failed",
      loginId: "L2",
      failureReason: "timed_out",
      error: "Grok login timed out",
    });
    expect(state.accounts).toEqual([]);
  });

  // --- switch -----------------------------------------------------------------

  it("switch writes the target credential to the live file and re-derives active", async () => {
    const { store, service } = setup();
    saveAccount(store, "user-a");
    const bRaw = saveAccount(store, "user-b");
    setLive(authJson("user-a"));

    const result = await service.switchAccount({ accountId: "user-b" });
    expect(result).toEqual({ outcome: "switched", activeAccountId: "user-b" });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(bRaw);
  });

  it("refresh-retention: a token refreshed in the live file survives switching away and back", async () => {
    const { store, service } = setup();
    saveAccount(store, "user-a", { create_time: "2026-07-01T00:00:00.000Z" });
    const bRaw = saveAccount(store, "user-b");
    // grok rewrote a refreshed token for A in place while A was active.
    const aRefreshed = authJson("user-a", {
      key: "refreshed-key-A",
      refresh_token: "refreshed-rt-A",
      create_time: "2026-07-10T00:00:00.000Z",
    });
    setLive(aRefreshed);

    await service.switchAccount({ accountId: "user-b" });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(bRaw);
    // Harvest captured A's refreshed bytes into the saved copy.
    expect(store.readCredentialRaw("user-a")).toBe(aRefreshed);

    await service.switchAccount({ accountId: "user-a" });
    // Switching back restores the refreshed bytes, not the stale original snapshot.
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(aRefreshed);
  });

  it("switch-to-active keeps a fresher live re-login and skips the swap", async () => {
    const { store, service } = setup();
    saveAccount(store, "user-a", { create_time: "2026-07-01T00:00:00.000Z", key: "stored-key" });
    const aFreshLive = authJson("user-a", {
      create_time: "2026-07-10T00:00:00.000Z",
      key: "fresh-live-key",
    });
    setLive(aFreshLive);

    const result = await service.switchAccount({ accountId: "user-a" });
    expect(result.outcome).toBe("switched");
    // Live is already correct → harvested, never overwritten by the stale stored copy.
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(aFreshLive);
    expect(store.readCredentialRaw("user-a")).toBe(aFreshLive);
  });

  it("switch-to-active restores a fresher stored copy over a stale live file", async () => {
    const { store, service } = setup();
    const aStored = saveAccount(store, "user-a", {
      create_time: "2026-07-10T00:00:00.000Z",
      key: "fresh-stored-key",
    });
    const aStaleLive = authJson("user-a", {
      create_time: "2026-07-01T00:00:00.000Z",
      key: "stale-live-key",
    });
    setLive(aStaleLive);

    await service.switchAccount({ accountId: "user-a" });
    // Stored copy is newer → the swap restores it, never clobbered by stale live.
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(aStored);
  });

  it("switch auto-saves an unknown live sign-in before swapping", async () => {
    const { store, service } = setup();
    const bRaw = saveAccount(store, "user-b");
    const externalRaw = authJson("user-external");
    setLive(externalRaw);

    await service.switchAccount({ accountId: "user-b" });
    expect(
      store
        .listAccounts()
        .map((account) => account.id)
        .sort(),
    ).toEqual(["user-b", "user-external"]);
    expect(store.readCredentialRaw("user-external")).toBe(externalRaw);
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(bRaw);
  });

  it("blocks a switch on running agents without force, then switches with force", async () => {
    const agents: GrokActiveAgent[] = [{ agentId: "agent-1", title: "Fix the bug" }];
    const { store, service } = setup({ listActiveGrokAgents: () => agents });
    const aRaw = saveAccount(store, "user-a");
    const bRaw = saveAccount(store, "user-b");
    setLive(aRaw);

    const blocked = await service.switchAccount({ accountId: "user-b" });
    expect(blocked).toEqual({ outcome: "blocked", blockingAgents: agents });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(aRaw);

    const forced = await service.switchAccount({ accountId: "user-b", force: true });
    expect(forced).toEqual({ outcome: "switched", activeAccountId: "user-b" });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(bRaw);
  });

  it("rotates an exhausted account once and lets a concurrent recovery reuse the new account", async () => {
    const { store, service } = setup();
    const aRaw = saveAccount(store, "user-a");
    const bRaw = saveAccount(store, "user-b");
    saveAccount(store, "user-c");
    setLive(aRaw);

    const input = {
      agentId: "agent-1",
      failedAccountId: "user-a",
      excludedAccountIds: ["user-a"],
    } as const;
    const [first, second] = await Promise.all([
      service.rotateAfterQuotaExhaustion(input),
      service.rotateAfterQuotaExhaustion(input),
    ]);

    expect(first).toEqual({
      outcome: "switched",
      previousAccountId: "user-a",
      activeAccountId: "user-b",
    });
    expect(second).toEqual({
      outcome: "already_switched",
      previousAccountId: "user-a",
      activeAccountId: "user-b",
    });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(bRaw);
  });

  it("skips accounts whose cached quota is exhausted", async () => {
    const future = "2999-01-01T00:00:00.000Z";
    const { store, service } = setup({
      fetchWeekly: async (_api, token) => ({
        percentUsed: token === "full-token" ? 100 : 25,
        resetsAt: null,
        breakdown: [],
      }),
    });
    const aRaw = saveAccount(store, "user-a", { key: "active-token", expires_at: future });
    saveAccount(store, "user-b", { key: "full-token", expires_at: future });
    const cRaw = saveAccount(store, "user-c", { key: "available-token", expires_at: future });
    setLive(aRaw);
    await service.getState({ refreshQuota: true });

    const result = await service.rotateAfterQuotaExhaustion({
      agentId: "agent-1",
      failedAccountId: "user-a",
      excludedAccountIds: ["user-a"],
    });

    expect(result).toMatchObject({ outcome: "switched", activeAccountId: "user-c" });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(cRaw);
  });

  it("allows an account back into rotation after its exhausted quota cache expires", async () => {
    const future = "2999-01-01T00:00:00.000Z";
    let nowMs = Date.parse("2026-07-11T00:00:00.000Z");
    const { store, service } = setup({
      now: () => new Date(nowMs),
      quotaTtlMs: 1_000,
      fetchWeekly: async (_api, token) => ({
        percentUsed: token === "full-token" ? 100 : 25,
        resetsAt: null,
        breakdown: [],
      }),
    });
    const aRaw = saveAccount(store, "user-a", { key: "active-token", expires_at: future });
    const bRaw = saveAccount(store, "user-b", { key: "full-token", expires_at: future });
    setLive(aRaw);
    await service.getState({ refreshQuota: true });
    nowMs += 1_001;

    const result = await service.rotateAfterQuotaExhaustion({
      agentId: "agent-1",
      failedAccountId: "user-a",
      excludedAccountIds: ["user-a"],
    });

    expect(result).toMatchObject({ outcome: "switched", activeAccountId: "user-b" });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(bRaw);
  });

  it("does not auto-rotate while another Grok agent is running", async () => {
    const agents: GrokActiveAgent[] = [
      { agentId: "agent-1", title: "Current" },
      { agentId: "agent-2", title: "Other task" },
    ];
    const { store, service } = setup({ listActiveGrokAgents: () => agents });
    const aRaw = saveAccount(store, "user-a");
    saveAccount(store, "user-b");
    setLive(aRaw);

    const result = await service.rotateAfterQuotaExhaustion({
      agentId: "agent-1",
      failedAccountId: "user-a",
      excludedAccountIds: ["user-a"],
    });

    expect(result).toEqual({
      outcome: "unavailable",
      reason: "other_agents_running",
      blockingAgents: [{ agentId: "agent-2", title: "Other task" }],
    });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(aRaw);
  });

  it("leaves the live credential untouched when no alternate account remains", async () => {
    const { store, service } = setup();
    const aRaw = saveAccount(store, "user-a");
    setLive(aRaw);

    const result = await service.rotateAfterQuotaExhaustion({
      agentId: "agent-1",
      failedAccountId: "user-a",
      excludedAccountIds: ["user-a"],
    });

    expect(result).toEqual({ outcome: "unavailable", reason: "no_alternate_account" });
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(aRaw);
  });

  it("fails a second concurrent switch fast while the first holds the mutex", async () => {
    const { store, service } = setup();
    saveAccount(store, "user-a");
    saveAccount(store, "user-b");
    setLive(authJson("user-a"));

    const first = service.switchAccount({ accountId: "user-b" });
    const second = service.switchAccount({ accountId: "user-a" });
    await expectServiceError(second, "grok_mutation_in_progress");
    await expect(first).resolves.toMatchObject({ outcome: "switched" });
  });

  it("rejects a switch to an unknown account with grok_account_not_found", async () => {
    const { store, service } = setup();
    saveAccount(store, "user-a");
    setLive(authJson("user-a"));
    await expectServiceError(
      service.switchAccount({ accountId: "ghost" }),
      "grok_account_not_found",
    );
  });

  it("surfaces grok_switch_failed and leaves the live file intact when the swap keeps failing EPERM", async () => {
    const aRaw = authJson("user-a");
    const { store, service } = setup({
      storeSleepSync: () => {},
      storeWriteLiveFile: () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      },
    });
    saveAccount(store, "user-a");
    saveAccount(store, "user-b");
    setLive(aRaw);

    await expectServiceError(service.switchAccount({ accountId: "user-b" }), "grok_switch_failed");
    // Previous live file untouched — the swap never renamed over it.
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(aRaw);
  });

  // --- remove -----------------------------------------------------------------

  it("removes a non-active account", async () => {
    const { store, service } = setup();
    saveAccount(store, "user-a");
    saveAccount(store, "user-b");
    setLive(authJson("user-a"));

    const result = await service.removeAccount({ accountId: "user-b" });
    expect(result).toEqual({ outcome: "removed" });
    expect(store.listAccounts().map((account) => account.id)).toEqual(["user-a"]);
  });

  it("blocks removing the active account without force", async () => {
    const { store, service } = setup();
    saveAccount(store, "user-a");
    setLive(authJson("user-a"));

    const result = await service.removeAccount({ accountId: "user-a" });
    expect(result).toEqual({ outcome: "blocked_active_account" });
    expect(store.listAccounts().map((account) => account.id)).toEqual(["user-a"]);
  });

  it("force-removes the active account, backing up the live file first and never touching it", async () => {
    const { store, service } = setup();
    const aRaw = saveAccount(store, "user-a");
    setLive(aRaw);

    const result = await service.removeAccount({ accountId: "user-a", force: true });
    expect(result).toEqual({ outcome: "removed" });
    expect(store.listAccounts()).toEqual([]);
    expect(readdirSync(store.backupsDir).length).toBeGreaterThan(0);
    // The live auth.json is never deleted — it stays the only recoverable copy.
    expect(readFileSync(liveAuthFilePath, "utf8")).toBe(aRaw);
  });

  it("rejects removing an unknown account with grok_account_not_found", async () => {
    const { service } = setup();
    await expectServiceError(
      service.removeAccount({ accountId: "ghost" }),
      "grok_account_not_found",
    );
  });

  it("login-finalize queues behind an in-flight switch instead of failing fast", async () => {
    const { store, service, emit } = setup();
    const aRaw = saveAccount(store, "user-a");
    saveAccount(store, "user-b");
    setLive(aRaw);

    const finalized = new Promise<void>((resolve) => {
      service.onChange((state) => {
        if (state.login.state === "completed") {
          resolve();
        }
      });
    });

    // Enqueue a switch (holds the mutex), then complete a login in the same tick.
    const switchP = service.switchAccount({ accountId: "user-b" });
    emit(completedEvent("login-1", authJson("user-c")));
    await switchP;
    await finalized;

    // Both mutations ran: the switch AND the queued login-finalize.
    expect(
      store
        .listAccounts()
        .map((account) => account.id)
        .sort(),
    ).toEqual(["user-a", "user-b", "user-c"]);
  });

  // --- quota (design §9) ------------------------------------------------------

  it("refreshes quota per account best-effort without letting any failure block the list", async () => {
    const future = "2999-01-01T00:00:00.000Z";
    const past = "2000-01-01T00:00:00.000Z";
    const { store, service } = setup({
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      refreshToken: async () => {
        throw new GrokRefreshError("invalid_grant", "refresh token revoked");
      },
      fetchWeekly: async (_api, token) => {
        if (token === "weekly-500-token") {
          throw new GrokWeeklyQuotaError("http_error", "weekly quota HTTP 500");
        }
        return {
          percentUsed: 40,
          resetsAt: "2026-07-16T18:40:09.000Z",
          breakdown: [
            { category: "build", percentUsed: 35 },
            { category: "api", percentUsed: 3 },
            { category: "chat", percentUsed: 2 },
          ],
        };
      },
    });
    saveAccount(store, "acc-ok", { key: "ok-token", expires_at: future });
    saveAccount(store, "acc-dead", { key: "stale", refresh_token: "rt-dead", expires_at: past });
    saveAccount(store, "acc-500", { key: "weekly-500-token", expires_at: future });

    const state = await service.getState({ refreshQuota: true });
    const byId = new Map(state.accounts.map((account) => [account.id, account]));

    expect(byId.get("acc-ok")?.quota).toMatchObject({
      status: "ok",
      weeklyPercentUsed: 40,
      resetsAt: "2026-07-16T18:40:09.000Z",
      breakdown: [
        { category: "build", percentUsed: 35 },
        { category: "api", percentUsed: 3 },
        { category: "chat", percentUsed: 2 },
      ],
    });
    expect(byId.get("acc-ok")?.needsReauth).toBe(false);
    expect(byId.get("acc-dead")?.quota).toEqual({ status: "unknown" });
    expect(byId.get("acc-dead")?.needsReauth).toBe(true);
    expect(byId.get("acc-500")?.quota).toEqual({ status: "unknown" });
    expect(state.accounts).toHaveLength(3);
  });

  it("reads the ACTIVE account's quota from the fresh live auth file, not its aged snapshot, and syncs the snapshot", async () => {
    const future = "2999-01-01T00:00:00.000Z";
    const past = "2000-01-01T00:00:00.000Z";
    let billedToken: string | null = null;
    const { store, service } = setup({
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      // The stored snapshot's refresh_token is dead: the pre-fix path read the
      // snapshot and reported needsReauth for the account actually in use.
      refreshToken: async () => {
        throw new GrokRefreshError("invalid_grant", "snapshot refresh token revoked");
      },
      fetchWeekly: async (_api, token) => {
        billedToken = token;
        if (token !== "fresh-live-token") {
          throw new GrokWeeklyQuotaError("http_error", "billed with a stale token");
        }
        return {
          percentUsed: 7,
          resetsAt: "2026-07-16T18:40:09.000Z",
          breakdown: [{ category: "build", percentUsed: 7 }],
        };
      },
    });
    // Snapshot is stale: an expired key plus a now-dead refresh token.
    saveAccount(store, "active-user", {
      key: "stale-snapshot-token",
      refresh_token: "rt-dead",
      expires_at: past,
    });
    // grok keeps the LIVE file fresh for whichever account is active.
    setLive(authJson("active-user", { key: "fresh-live-token", expires_at: future }));

    const state = await service.getState({ refreshQuota: true });
    expect(state.activeAccountId).toBe("active-user");
    const account = state.accounts.find((candidate) => candidate.id === "active-user");

    // Quota came back healthy off the live token — no false re-login prompt for
    // the very account currently in use.
    expect(account?.quota).toMatchObject({ status: "ok", weeklyPercentUsed: 7 });
    expect(account?.needsReauth).toBe(false);
    expect(billedToken).toBe("fresh-live-token");

    // The fresh live credential was synced back into the account's own snapshot,
    // so a later parked read of it starts from current bytes. The live file is
    // never written by the quota path.
    expect(store.readCredentialRaw("active-user")).toContain("fresh-live-token");
  });

  it("refreshes a stale parked token, re-stores it atomically, and reads the weekly quota with the fresh token", async () => {
    let billedToken: string | null = null;
    const { store, service } = setup({
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      refreshToken: async () => ({
        accessToken: "fresh-access",
        refreshToken: "fresh-rt",
        idToken: null,
        expiresAt: "2026-07-11T06:00:00.000Z",
      }),
      fetchWeekly: async (_api, token) => {
        billedToken = token;
        return {
          percentUsed: 12,
          resetsAt: "2026-07-16T18:40:09.000Z",
          breakdown: [{ category: "build", percentUsed: 12 }],
        };
      },
    });
    saveAccount(store, "parked", {
      key: "stale-key",
      refresh_token: "rt-old",
      expires_at: "2000-01-01T00:00:00.000Z",
    });

    const state = await service.getState({ refreshQuota: true });
    const account = state.accounts.find((candidate) => candidate.id === "parked");
    expect(account?.quota).toMatchObject({ status: "ok", weeklyPercentUsed: 12 });
    expect(billedToken).toBe("fresh-access");

    // Re-stored atomically into the account's OWN file; live file never created.
    const stored = store.readCredentialRaw("parked");
    expect(stored).toContain("fresh-access");
    expect(stored).toContain("fresh-rt");
    expect(existsSync(liveAuthFilePath)).toBe(false);
  });

  it("serves quota from the TTL cache on a second getState without re-fetching", async () => {
    const weekly = vi.fn(async () => ({
      percentUsed: 10,
      resetsAt: null,
      breakdown: [],
    }));
    const { store, service } = setup({
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      fetchWeekly: weekly,
    });
    saveAccount(store, "acc", { key: "token", expires_at: "2999-01-01T00:00:00.000Z" });

    await service.getState({ refreshQuota: true });
    await service.getState({ refreshQuota: true });
    expect(weekly).toHaveBeenCalledTimes(1);
  });

  it("does not fetch quota when refreshQuota is not requested", async () => {
    const weekly = vi.fn(async () => ({
      percentUsed: 10,
      resetsAt: null,
      breakdown: [],
    }));
    const { store, service } = setup({ fetchWeekly: weekly });
    saveAccount(store, "acc", { key: "token", expires_at: "2999-01-01T00:00:00.000Z" });

    const state = await service.getState();
    expect(weekly).not.toHaveBeenCalled();
    expect(state.accounts[0]?.quota).toBeNull();
  });

  // --- managed config (design §7 G10) -----------------------------------------

  it("flags managedConfigActive when config.toml pins a static api_key (which overrides auth.json)", async () => {
    writeFileSync(
      join(dirname(liveAuthFilePath), "config.toml"),
      'model = "grok-4.5"\napi_key = "xai-static-key"\n',
    );
    const { service } = setup();
    const state = await service.getState();
    expect(state.managedConfigActive).toBe(true);
  });

  it("does not flag managedConfigActive for an ordinary grok home (a bare managed_config.lock is NOT a signal)", async () => {
    // spike S3: managed_config.lock exists in every normal grok home, so it must
    // not trip detection — only a config.toml credential override should.
    writeFileSync(join(dirname(liveAuthFilePath), "managed_config.lock"), "");
    writeFileSync(join(dirname(liveAuthFilePath), "config.toml"), 'model = "grok-4.5"\n');
    const { store, service } = setup();
    saveAccount(store, "user-a");
    setLive(authJson("user-a"));
    const state = await service.getState();
    expect(state.managedConfigActive).toBe(false);
  });
});
