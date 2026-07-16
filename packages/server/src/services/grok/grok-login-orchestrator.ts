import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../server/private-files.js";
import {
  type ProcessTerminator,
  terminateWithTreeKill,
  type TreeKillTarget,
} from "../../utils/tree-kill.js";
import {
  extractBearerToken,
  extractGrokIdentity,
  type GrokIdentity,
  type ParsedGrokAuthFile,
  parseGrokAuthFile,
} from "./grok-auth-file.js";
import {
  type GrokDeviceAuthChallenge,
  type GrokDeviceAuthResult,
  runGrokDeviceAuth,
} from "./grok-device-auth.js";

// Owns one isolated Grok login. OAuth runs the official CLI against a staging
// GROK_HOME; device auth runs the browser-free RFC 8628 exchange and writes the
// same staging auth.json shape. Both paths emit the same lifecycle events and
// never touch the live credential file directly.
//
// Isolation-by-construction (design §1 rule 2): because the login runs against a
// staging `GROK_HOME`, an in-flight or failed login structurally cannot touch the
// live `~/.grok/auth.json`.
//
// Output hygiene (design §3.3): stdout/stderr are kept only in a small bounded
// in-memory tail. Nothing here is ever handed to a logger — this module takes no
// logger at all — and any error string surfaced in a `failed` event is a single
// scrubbed line (URLs, keyword-prefixed secrets, and long opaque runs removed),
// never verbatim CLI output. The scraped `authUrl` reaches callers only through
// the `start()` result and the `awaiting_browser` event, never through a `failed`
// event's `error` (design §7 G1).

// Structural subset of node's `ChildProcess` the orchestrator depends on.
// Declaring it (instead of the concrete `ChildProcess`) is what makes `spawnFn`
// injectable: tests pass a hand-rolled fake with exactly this shape. It extends
// `TreeKillTarget` so an instance can be handed straight to the terminator.
export interface ChildProcessLike extends TreeKillTarget {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

// The spawn options the orchestrator always uses. A structural subset of node's
// `SpawnOptions` so the default `spawnFn` can forward it to `child_process.spawn`
// unchanged while a fake `spawnFn` receives a fully-typed value.
export interface SpawnOptionsLike {
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: boolean;
}

export type GrokLoginSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptionsLike,
) => ChildProcessLike;

export type GrokLoginMode = "oauth" | "device-auth";

export type GrokDeviceAuthFn = (options: {
  signal: AbortSignal;
  onChallenge: (challenge: GrokDeviceAuthChallenge) => void;
}) => Promise<GrokDeviceAuthResult>;

export type GrokLoginFailureReason = "error" | "cancelled" | "timed_out";

// Lifecycle events emitted to the sink (Step 5 maps these onto the
// `provider.grok.changed` broadcast). `authUrl`/`userCode` also travel back in
// `start()`'s deferred result; the Step 5 service must keep them out of any
// broadcast (design §7 G1). The `completed` event carries the verbatim staging
// bytes and identity so the store can persist them without re-reading anything.
export type GrokLoginEvent =
  | {
      phase: "awaiting_browser";
      loginId: string;
      authUrl: string | null;
      userCode: string | null;
    }
  | {
      phase: "completed";
      loginId: string;
      parsed: ParsedGrokAuthFile;
      rawBytes: string;
      identity: GrokIdentity;
    }
  | {
      phase: "failed";
      loginId: string;
      reason: GrokLoginFailureReason;
      error: string | null;
    };

export type GrokLoginStartResult =
  | { outcome: "started"; loginId: string; authUrl: string | null; userCode: string | null }
  | { outcome: "already_in_progress"; loginId: string };

export interface GrokLoginOrchestratorOptions {
  // The store's staging root; the orchestrator creates `stagingDir/<loginId>/`.
  stagingDir: string;
  // Lifecycle sink. Called with awaiting/completed/failed events.
  onEvent: (event: GrokLoginEvent) => void;
  // Process spawn seam. Defaults to `child_process.spawn`; tests inject a fake.
  spawnFn?: GrokLoginSpawnFn;
  // Browser-free RFC 8628 flow used by the copy-link mode. Keeping this
  // injectable makes the network exchange deterministic in orchestrator tests.
  deviceAuthFn?: GrokDeviceAuthFn;
  // Process-tree terminator for cancel/timeout. Defaults to
  // `terminateWithTreeKill` (Windows-safe); tests inject a recording fake.
  terminate?: ProcessTerminator;
  // Clock-injection seam kept for parity with the sibling store/service. This
  // module emits no timestamps, so it is intentionally not read today; the field
  // exists so callers need not change when timestamped behavior is added.
  now?: () => Date;
  // Hard cap on the whole login before it is killed and reported timed_out.
  loginTimeoutMs?: number;
  // How long the OAuth path waits to scrape the CLI authorize URL before
  // answering with null. Device auth waits for its API challenge instead.
  urlScrapeTimeoutMs?: number;
  // `oauth` lets the official CLI open the host browser; `device-auth` returns
  // a link and code without opening anything.
  mode?: GrokLoginMode;
}

const GROK_COMMAND = "grok";
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_URL_SCRAPE_TIMEOUT_MS = 10 * 1000;
const OUTPUT_TAIL_MAX_LINES = 20;
const MAX_ERROR_LENGTH = 200;
// Graceful SIGTERM then force SIGKILL (values only matter for the real
// terminator; tests inject a fake that resolves immediately).
const TERMINATE_GRACEFUL_MS = 5_000;
const TERMINATE_FORCE_MS = 5_000;
const GENERIC_FAILURE_MESSAGE = "Grok login failed";

// The x.ai authorize URL grok prints to stderr. Stops at
// whitespace or a quote so the full query string (state/PKCE) is captured.
const X_AI_AUTH_URL_PATTERN = /https:\/\/(?:auth|accounts)\.x\.ai\/[^\s'"]+/;
// Scrubber patterns, applied in order: any URL (an authorize URL carries
// state/PKCE), keyword-prefixed secrets, then any long opaque run.
const ANY_URL_PATTERN = /https?:\/\/\S+/gi;
const SECRET_ASSIGNMENT_PATTERN = /(?:token|secret|key|code|refresh|password)[=:]\S+/gi;
const LONG_OPAQUE_RUN_PATTERN = /[A-Za-z0-9+/=_-]{20,}/g;

interface ActiveLogin {
  loginId: string;
  stagingLoginDir: string;
  child: ChildProcessLike | null;
  deviceAbortController: AbortController | null;
  authUrl: string | null;
  userCode: string | null;
  startResolved: boolean;
  terminalClaimed: boolean;
  resolveStart: (result: GrokLoginStartResult) => void;
  loginTimer: NodeJS.Timeout | null;
  scrapeTimer: NodeJS.Timeout | null;
  outputTail: string[];
}

export class GrokLoginOrchestrator {
  private readonly stagingDir: string;
  private readonly onEvent: (event: GrokLoginEvent) => void;
  private readonly spawnFn: GrokLoginSpawnFn;
  private readonly deviceAuthFn: GrokDeviceAuthFn;
  private readonly terminate: ProcessTerminator;
  private readonly loginTimeoutMs: number;
  private readonly urlScrapeTimeoutMs: number;
  private readonly mode: GrokLoginMode;
  private active: ActiveLogin | null = null;

  constructor(options: GrokLoginOrchestratorOptions) {
    this.stagingDir = options.stagingDir;
    this.onEvent = options.onEvent;
    this.spawnFn = options.spawnFn ?? defaultSpawnFn;
    this.deviceAuthFn = options.deviceAuthFn ?? runGrokDeviceAuth;
    this.terminate = options.terminate ?? terminateWithTreeKill;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.urlScrapeTimeoutMs = options.urlScrapeTimeoutMs ?? DEFAULT_URL_SCRAPE_TIMEOUT_MS;
    this.mode = options.mode ?? "oauth";
  }

  isInProgress(): boolean {
    return this.active !== null;
  }

  // Start a login. Single-flight: while one is in flight, return
  // `already_in_progress` with the current id and spawn nothing. Otherwise spawn
  // the selected flow against a fresh staging directory and resolve as soon as
  // its authorize URL is available, it exits early, or the scrape window
  // elapses. The login then runs in the background until completion/cancellation.
  //
  // `options.mode` overrides the constructor default for THIS login only, so the
  // client can pick the sign-in method per add-account (oauth vs device-auth).
  start(options?: { mode?: GrokLoginMode }): Promise<GrokLoginStartResult> {
    if (this.active) {
      return Promise.resolve({ outcome: "already_in_progress", loginId: this.active.loginId });
    }

    const mode = options?.mode ?? this.mode;
    const loginId = randomUUID();
    const stagingLoginDir = join(this.stagingDir, loginId);
    ensurePrivateDirectory(stagingLoginDir);

    // Capture the resolver so the executor stays a one-liner; the deferred result
    // is fulfilled later by `resolveAwaiting`/`settle`, each guarded so it lands
    // exactly once.
    let resolveStart!: (result: GrokLoginStartResult) => void;
    const startPromise = new Promise<GrokLoginStartResult>((resolve) => {
      resolveStart = resolve;
    });

    const login: ActiveLogin = {
      loginId,
      stagingLoginDir,
      child: null,
      deviceAbortController: null,
      authUrl: null,
      userCode: null,
      startResolved: false,
      terminalClaimed: false,
      resolveStart,
      loginTimer: null,
      scrapeTimer: null,
      outputTail: [],
    };
    this.active = login;

    if (mode === "oauth") {
      login.scrapeTimer = setTimeout(
        () => this.handleScrapeTimeout(login),
        this.urlScrapeTimeoutMs,
      );
    }
    login.loginTimer = setTimeout(() => this.handleLoginTimeout(login), this.loginTimeoutMs);

    if (mode === "device-auth") {
      this.startDeviceAuth(login);
    } else {
      try {
        const child = this.spawnFn(GROK_COMMAND, ["login", "--oauth"], {
          env: { ...process.env, GROK_HOME: stagingLoginDir },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        login.child = child;
        this.attachStream(login, child.stdout);
        this.attachStream(login, child.stderr);
        child.on("exit", (code) => this.handleExit(login, code));
        child.on("error", (error) => this.handleSpawnError(login, error));
      } catch (error) {
        this.handleSpawnError(login, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return startPromise;
  }

  // Cancel the in-flight login if `loginId` matches: stop the CLI process or
  // abort the device exchange, emit failed{cancelled}, and clean staging.
  async cancel(loginId: string): Promise<boolean> {
    const login = this.active;
    if (!login || login.loginId !== loginId) {
      return false;
    }
    if (!this.claimTerminal(login)) {
      return false;
    }
    try {
      await this.terminateThenSettle(login, {
        phase: "failed",
        loginId: login.loginId,
        reason: "cancelled",
        error: null,
      });
    } catch {
      // `settle` already ran in the terminator's `finally`; swallow kill errors.
    }
    return true;
  }

  // --- output scraping ---

  private startDeviceAuth(login: ActiveLogin): void {
    const controller = new AbortController();
    login.deviceAbortController = controller;
    void this.deviceAuthFn({
      signal: controller.signal,
      onChallenge: (challenge) => {
        if (login.terminalClaimed) return;
        login.authUrl = challenge.authUrl;
        login.userCode = challenge.userCode;
        this.resolveAwaiting(login);
      },
    })
      .then((result) => {
        if (login.terminalClaimed) return undefined;
        writePrivateFileAtomicSync(join(login.stagingLoginDir, "auth.json"), result.rawAuthJson);
        this.handleExit(login, 0);
        return undefined;
      })
      .catch((error: unknown) => {
        this.handleSpawnError(login, error instanceof Error ? error : new Error(String(error)));
      });
  }

  private attachStream(login: ActiveLogin, stream: NodeJS.ReadableStream | null): void {
    if (!stream) {
      return;
    }
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        this.consumeLine(login, line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
  }

  private consumeLine(login: ActiveLogin, line: string): void {
    this.pushTail(login, line);
    if (login.authUrl === null) {
      const urlMatch = line.match(X_AI_AUTH_URL_PATTERN);
      if (urlMatch) {
        login.authUrl = urlMatch[0];
      }
    }
    if (login.authUrl !== null) {
      this.resolveAwaiting(login);
    }
  }

  private pushTail(login: ActiveLogin, line: string): void {
    if (line.length === 0) {
      return;
    }
    login.outputTail.push(line);
    if (login.outputTail.length > OUTPUT_TAIL_MAX_LINES) {
      login.outputTail.shift();
    }
  }

  // --- start-resolution ---

  // Resolve the deferred `start()` result and emit `awaiting_browser` (once). Used
  // both when the URL is scraped and when the scrape window elapses (null URL);
  // in both cases the process is still alive, awaiting the browser callback.
  private resolveAwaiting(login: ActiveLogin): void {
    if (login.startResolved || login.terminalClaimed) {
      return;
    }
    this.clearScrapeTimer(login);
    login.startResolved = true;
    this.onEvent({
      phase: "awaiting_browser",
      loginId: login.loginId,
      authUrl: login.authUrl,
      userCode: login.userCode,
    });
    login.resolveStart({
      outcome: "started",
      loginId: login.loginId,
      authUrl: login.authUrl,
      userCode: login.userCode,
    });
  }

  private handleScrapeTimeout(login: ActiveLogin): void {
    login.scrapeTimer = null;
    this.resolveAwaiting(login);
  }

  // --- terminal handling ---

  private handleExit(login: ActiveLogin, code: number | null): void {
    if (!this.claimTerminal(login)) {
      return;
    }
    if (code === 0) {
      this.settleFromStaging(login);
      return;
    }
    this.settle(login, {
      phase: "failed",
      loginId: login.loginId,
      reason: "error",
      error: scrubToOneLine(this.lastTailLine(login)),
    });
  }

  private handleSpawnError(login: ActiveLogin, error: Error): void {
    if (!this.claimTerminal(login)) {
      return;
    }
    this.settle(login, {
      phase: "failed",
      loginId: login.loginId,
      reason: "error",
      error: scrubToOneLine(error.message),
    });
  }

  private handleLoginTimeout(login: ActiveLogin): void {
    if (!this.claimTerminal(login)) {
      return;
    }
    void this.terminateThenSettle(login, {
      phase: "failed",
      loginId: login.loginId,
      reason: "timed_out",
      error: "Grok login timed out",
    }).catch(() => undefined);
  }

  // Exit-0 harvest: the staging `auth.json` must parse as modern with ≥1 entry,
  // a resolvable identity, and a bearer token. Anything else is a failed login,
  // reported with a generic (never file-derived) message.
  private settleFromStaging(login: ActiveLogin): void {
    const authFilePath = join(login.stagingLoginDir, "auth.json");
    let rawBytes: string;
    try {
      rawBytes = readFileSync(authFilePath, "utf8");
    } catch {
      this.settle(login, {
        phase: "failed",
        loginId: login.loginId,
        reason: "error",
        error: "Grok login completed without writing a credential file",
      });
      return;
    }
    const parsed = parseGrokAuthFile(rawBytes);
    const identity = extractGrokIdentity(parsed);
    const bearer = extractBearerToken(parsed);
    if (
      parsed.kind !== "modern" ||
      parsed.entries.length === 0 ||
      identity === null ||
      bearer === null
    ) {
      this.settle(login, {
        phase: "failed",
        loginId: login.loginId,
        reason: "error",
        error: "Grok login produced an unrecognized credential file",
      });
      return;
    }
    this.settle(login, {
      phase: "completed",
      loginId: login.loginId,
      parsed,
      rawBytes,
      identity,
    });
  }

  // Claim the single terminal transition for this login. Whoever claims first
  // (exit, error, timeout, or cancel) owns the outcome; every other path bows
  // out. Timers are cleared on claim so nothing fires after a decision is made.
  private claimTerminal(login: ActiveLogin): boolean {
    if (login.terminalClaimed) {
      return false;
    }
    login.terminalClaimed = true;
    this.clearTimers(login);
    return true;
  }

  private async terminateThenSettle(login: ActiveLogin, event: GrokLoginEvent): Promise<void> {
    try {
      if (login.deviceAbortController) {
        login.deviceAbortController.abort();
      } else if (login.child) {
        await this.terminate(login.child, {
          gracefulTimeoutMs: TERMINATE_GRACEFUL_MS,
          forceTimeoutMs: TERMINATE_FORCE_MS,
        });
      }
    } finally {
      this.settle(login, event);
    }
  }

  // Finalize a login: resolve a still-pending `start()` (as `started`, since the
  // login did begin — failures ride the event), delete the staging dir, drop the
  // active slot, and emit the terminal event.
  private settle(login: ActiveLogin, event: GrokLoginEvent): void {
    this.clearTimers(login);
    if (!login.startResolved) {
      login.startResolved = true;
      login.resolveStart({
        outcome: "started",
        loginId: login.loginId,
        authUrl: login.authUrl,
        userCode: login.userCode,
      });
    }
    // Windows: the just-killed grok may still hold the staging tree briefly, so
    // let rmSync retry. A leftover dir is swept unconditionally at next startup.
    rmSync(login.stagingLoginDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (this.active === login) {
      this.active = null;
    }
    this.onEvent(event);
  }

  private clearTimers(login: ActiveLogin): void {
    this.clearScrapeTimer(login);
    if (login.loginTimer) {
      clearTimeout(login.loginTimer);
      login.loginTimer = null;
    }
  }

  private clearScrapeTimer(login: ActiveLogin): void {
    if (login.scrapeTimer) {
      clearTimeout(login.scrapeTimer);
      login.scrapeTimer = null;
    }
  }

  private lastTailLine(login: ActiveLogin): string | null {
    for (let index = login.outputTail.length - 1; index >= 0; index -= 1) {
      const line = login.outputTail[index];
      if (line && line.trim().length > 0) {
        return line;
      }
    }
    return null;
  }
}

// Default spawn: a thin wrapper over `child_process.spawn`. `SpawnOptionsLike` is
// a structural subset of node's `SpawnOptions`, so it forwards unchanged.
function defaultSpawnFn(
  command: string,
  args: string[],
  options: SpawnOptionsLike,
): ChildProcessLike {
  return spawn(command, args, options);
}

// Reduce a candidate error string to a single scrubbed line safe to surface to
// clients (design §3.3). Strips URLs (the authorize URL carries state/PKCE — it
// must never leak into an error), keyword-prefixed secrets, and any long opaque
// run; if nothing meaningful remains, returns a generic message. Never throws.
function scrubToOneLine(input: string | null): string {
  if (input === null) {
    return GENERIC_FAILURE_MESSAGE;
  }
  const firstLine = input.split(/\r?\n/)[0] ?? "";
  const scrubbed = firstLine
    .replace(ANY_URL_PATTERN, " ")
    .replace(SECRET_ASSIGNMENT_PATTERN, " ")
    .replace(LONG_OPAQUE_RUN_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed.length < 3) {
    return GENERIC_FAILURE_MESSAGE;
  }
  return scrubbed.slice(0, MAX_ERROR_LENGTH);
}
