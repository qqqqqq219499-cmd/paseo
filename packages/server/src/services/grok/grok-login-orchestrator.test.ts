import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessTerminator, TreeKillTarget } from "../../utils/tree-kill.js";
import { makeModernAuthFile } from "./grok-auth-file.test.js";
import {
  type GrokLoginEvent,
  GrokLoginOrchestrator,
  type GrokLoginOrchestratorOptions,
  type GrokLoginSpawnFn,
  type SpawnOptionsLike,
} from "./grok-login-orchestrator.js";

// Deterministic fake of the one `grok login` child the orchestrator drives. It
// is an EventEmitter (so `on("exit"|"error")` and `once` come for free) with
// PassThrough stdout/stderr the test pushes lines into, plus a recording
// `kill()`. Structurally it satisfies the orchestrator's `ChildProcessLike`.
interface RecordedSpawn {
  command: string;
  args: string[];
  options: SpawnOptionsLike;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  spawn!: RecordedSpawn;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }

  // Push a single already-newline-terminated stderr line.
  emitStderrLine(line: string): void {
    this.stderr.write(`${line}\n`);
  }

  emitExit(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  emitSpawnError(error: Error): void {
    this.emit("error", error);
  }
}

interface Harness {
  orch: GrokLoginOrchestrator;
  stagingDir: string;
  children: FakeChild[];
  events: GrokLoginEvent[];
  terminatedChildren: TreeKillTarget[];
}

const tempDirs: string[] = [];

function makeTempStagingDir(): string {
  const dir = join(tmpdir(), `grok-login-orch-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

type TunableOptions = Pick<
  GrokLoginOrchestratorOptions,
  "loginTimeoutMs" | "urlScrapeTimeoutMs" | "mode" | "deviceAuthFn" | "spawnFn"
>;

type DeviceAuthFn = NonNullable<TunableOptions["deviceAuthFn"]>;

function rejectDeviceAuthOnAbort(signal: AbortSignal): Promise<{ rawAuthJson: string }> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

function pendingDeviceAuth(
  challenge: { authUrl: string; userCode: string },
  onSignal?: (signal: AbortSignal) => void,
): DeviceAuthFn {
  return ({ signal, onChallenge }) => {
    onSignal?.(signal);
    onChallenge(challenge);
    return rejectDeviceAuthOnAbort(signal);
  };
}

function delayedDeviceAuth(
  challenge: { authUrl: string; userCode: string },
  delayMs: number,
): DeviceAuthFn {
  return ({ signal, onChallenge }) =>
    waitForDelayedChallenge(signal, onChallenge, challenge, delayMs);
}

function waitForDelayedChallenge(
  signal: AbortSignal,
  onChallenge: (challenge: { authUrl: string; userCode: string }) => void,
  challenge: { authUrl: string; userCode: string },
  delayMs: number,
): Promise<{ rawAuthJson: string }> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => onChallenge(challenge), delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function setup(overrides: TunableOptions = {}): Harness {
  const stagingDir = makeTempStagingDir();
  const children: FakeChild[] = [];
  const events: GrokLoginEvent[] = [];
  const terminatedChildren: TreeKillTarget[] = [];

  const recordingSpawnFn: GrokLoginSpawnFn = (command, args, options) => {
    const child = new FakeChild();
    child.spawn = { command, args, options };
    children.push(child);
    return child;
  };

  const terminate: ProcessTerminator = async (child) => {
    terminatedChildren.push(child);
    return "terminated";
  };

  const orch = new GrokLoginOrchestrator({
    stagingDir,
    onEvent: (event) => events.push(event),
    spawnFn: overrides.spawnFn ?? recordingSpawnFn,
    terminate,
    // Generous defaults so timers never fire unless a test opts in.
    loginTimeoutMs: overrides.loginTimeoutMs ?? 60_000,
    urlScrapeTimeoutMs: overrides.urlScrapeTimeoutMs ?? 60_000,
    mode: overrides.mode,
    deviceAuthFn: overrides.deviceAuthFn,
  });

  return { orch, stagingDir, children, events, terminatedChildren };
}

const OAUTH_URL =
  "https://auth.x.ai/oauth2/authorize?client_id=fake&state=fake-state&code_challenge=fake";

function lastEvent(events: GrokLoginEvent[]): GrokLoginEvent {
  const event = events.at(-1);
  if (!event) {
    throw new Error("expected at least one login event");
  }
  return event;
}

function loginIdOf(result: Awaited<ReturnType<GrokLoginOrchestrator["start"]>>): string {
  if (result.outcome !== "started") {
    throw new Error(`expected outcome "started", got "${result.outcome}"`);
  }
  return result.loginId;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("GrokLoginOrchestrator.start", () => {
  it("scrapes the authorize URL from stderr and resolves start() (spike S1)", async () => {
    const { orch, stagingDir, children, events } = setup();

    const startPromise = orch.start();
    const child = children[0];
    // The exact S1 sequence: a label line, then the authorize URL on its own line.
    child.emitStderrLine("Open this URL to sign in:");
    child.emitStderrLine(OAUTH_URL);

    const result = await startPromise;
    const loginId = loginIdOf(result);
    expect(result).toEqual({
      outcome: "started",
      loginId,
      authUrl: OAUTH_URL,
      userCode: null,
    });

    // The same data also surfaced as an awaiting_browser event.
    expect(events).toContainEqual({
      phase: "awaiting_browser",
      loginId,
      authUrl: OAUTH_URL,
      userCode: null,
    });

    // Spawn shape: `grok login --oauth`, staging GROK_HOME, piped stdio, hidden.
    expect(child.spawn.command).toBe("grok");
    expect(child.spawn.args).toEqual(["login", "--oauth"]);
    expect(child.spawn.options.env.GROK_HOME).toBe(join(stagingDir, loginId));
    expect(child.spawn.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(child.spawn.options.windowsHide).toBe(true);
    // The per-login staging dir exists while the login is in flight.
    expect(existsSync(join(stagingDir, loginId))).toBe(true);

    expect(await orch.cancel(loginId)).toBe(true);
  });

  it("cancels the browser-free device-auth flow with an abort signal", async () => {
    let deviceSignal: AbortSignal | null = null;
    const deviceAuthFn = vi.fn(
      pendingDeviceAuth(
        {
          authUrl: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
          userCode: "WXYZ-1234",
        },
        (signal) => {
          deviceSignal = signal;
        },
      ),
    );
    const { orch, children } = setup({ mode: "device-auth", deviceAuthFn });

    const result = await orch.start();
    const loginId = loginIdOf(result);
    expect(result).toMatchObject({
      authUrl: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
      userCode: "WXYZ-1234",
    });
    expect(children).toHaveLength(0);

    expect(await orch.cancel(loginId)).toBe(true);
    expect(deviceSignal?.aborted).toBe(true);
  });

  it("device-auth uses the no-browser flow instead of spawning the Grok CLI", async () => {
    const rawAuthJson = JSON.stringify(makeModernAuthFile());
    const deviceAuthFn = vi.fn(
      async ({ onChallenge }: Parameters<NonNullable<TunableOptions["deviceAuthFn"]>>[0]) => {
        onChallenge({
          authUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
          userCode: "ABCD-1234",
        });
        return { rawAuthJson };
      },
    );
    const { orch, children, events } = setup({ mode: "device-auth", deviceAuthFn });

    const result = await orch.start();
    const loginId = loginIdOf(result);
    expect(result).toEqual({
      outcome: "started",
      loginId,
      authUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
    });
    expect(deviceAuthFn).toHaveBeenCalledOnce();
    expect(children).toHaveLength(0);
    await vi.waitFor(() => expect(lastEvent(events).phase).toBe("completed"));
  });

  it("waits for a device challenge beyond the OAuth URL scrape window", async () => {
    const deviceAuthFn = vi.fn(
      delayedDeviceAuth(
        {
          authUrl: "https://accounts.x.ai/oauth2/device?user_code=LATE-1234",
          userCode: "LATE-1234",
        },
        25,
      ),
    );
    const { orch } = setup({
      mode: "device-auth",
      deviceAuthFn,
      urlScrapeTimeoutMs: 5,
    });

    const result = await orch.start();
    const loginId = loginIdOf(result);
    try {
      expect(result).toMatchObject({
        authUrl: "https://accounts.x.ai/oauth2/device?user_code=LATE-1234",
        userCode: "LATE-1234",
      });
    } finally {
      await orch.cancel(loginId);
    }
  });

  it("start({ mode: 'device-auth' }) overrides an oauth default", async () => {
    // Constructed with the default (oauth) mode, but THIS call opts into device-auth.
    const deviceAuthFn = vi.fn(
      pendingDeviceAuth({
        authUrl: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
        userCode: "WXYZ-1234",
      }),
    );
    const { orch, children } = setup({ deviceAuthFn });

    const result = await orch.start({ mode: "device-auth" });
    const loginId = loginIdOf(result);
    expect(result).toMatchObject({
      authUrl: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
      userCode: "WXYZ-1234",
    });
    expect(deviceAuthFn).toHaveBeenCalledOnce();
    expect(children).toHaveLength(0);

    await orch.cancel(loginId);
  });

  it("start({ mode: 'oauth' }) forces --oauth and scrapes no user code even when the default is device-auth", async () => {
    const { orch, children } = setup({ mode: "device-auth" });

    const startPromise = orch.start({ mode: "oauth" });
    const child = children[0];
    // A device code on the line must be ignored in oauth mode.
    child.emitStderrLine("Open this URL to sign in:");
    child.emitStderrLine(OAUTH_URL);

    const result = await startPromise;
    const loginId = loginIdOf(result);
    if (result.outcome === "started") {
      expect(result.authUrl).toBe(OAUTH_URL);
      expect(result.userCode).toBeNull();
    }
    expect(child.spawn.args).toEqual(["login", "--oauth"]);

    await orch.cancel(loginId);
  });

  it("is single-flight: a second start() reports already_in_progress", async () => {
    const { orch, children } = setup();

    const startPromise = orch.start();
    children[0].emitStderrLine(OAUTH_URL);
    const first = await startPromise;
    const loginId = loginIdOf(first);

    const second = await orch.start();
    expect(second).toEqual({ outcome: "already_in_progress", loginId });
    // No second process was spawned.
    expect(children).toHaveLength(1);

    await orch.cancel(loginId);
  });

  it("resolves with a null authUrl when the scrape window elapses", async () => {
    const { orch, events } = setup({ urlScrapeTimeoutMs: 15 });

    const result = await orch.start();
    const loginId = loginIdOf(result);
    expect(result).toMatchObject({ outcome: "started", authUrl: null, userCode: null });
    expect(events).toContainEqual({
      phase: "awaiting_browser",
      loginId,
      authUrl: null,
      userCode: null,
    });

    await orch.cancel(loginId);
  });
});

describe("GrokLoginOrchestrator terminal outcomes", () => {
  it("harvests the staging auth.json on exit 0 and emits completed", async () => {
    const { orch, stagingDir, children, events } = setup();

    const startPromise = orch.start();
    const child = children[0];
    child.emitStderrLine(OAUTH_URL);
    const loginId = loginIdOf(await startPromise);

    // grok writes auth.json into its staging GROK_HOME only on success (spike S2).
    const stagingLoginDir = join(stagingDir, loginId);
    const rawBytes = JSON.stringify(makeModernAuthFile());
    writeFileSync(join(stagingLoginDir, "auth.json"), rawBytes);

    child.emitExit(0);

    const completed = lastEvent(events);
    expect(completed.phase).toBe("completed");
    if (completed.phase === "completed") {
      expect(completed.loginId).toBe(loginId);
      expect(completed.rawBytes).toBe(rawBytes);
      expect(completed.parsed.kind).toBe("modern");
      expect(completed.identity.userId).toBe("fake-user-id-1");
      expect(completed.identity.email).toBe("fake-user@example.com");
    }
    // Staging dir removed on the terminal transition.
    expect(existsSync(stagingLoginDir)).toBe(false);
    expect(orch.isInProgress()).toBe(false);
  });

  it("fails when exit 0 leaves no usable credential file", async () => {
    const { orch, children, events } = setup();

    const startPromise = orch.start();
    const child = children[0];
    child.emitStderrLine(OAUTH_URL);
    await startPromise;

    // Exit 0 but nothing written to staging → not a success.
    child.emitExit(0);

    const failed = lastEvent(events);
    expect(failed.phase).toBe("failed");
    if (failed.phase === "failed") {
      expect(failed.reason).toBe("error");
      expect(failed.error).not.toBeNull();
    }
    expect(orch.isInProgress()).toBe(false);
  });

  it("emits failed{error} on a non-zero exit and cleans staging", async () => {
    const { orch, stagingDir, children, events } = setup({ urlScrapeTimeoutMs: 15 });

    const startPromise = orch.start();
    const child = children[0];
    child.emitStderrLine("Error: authorization was denied by the user");
    const loginId = loginIdOf(await startPromise);

    child.emitExit(1);

    const failed = lastEvent(events);
    expect(failed.phase).toBe("failed");
    if (failed.phase === "failed") {
      expect(failed.reason).toBe("error");
      expect(failed.error).toContain("authorization was denied");
    }
    expect(existsSync(join(stagingDir, loginId))).toBe(false);
  });

  it("emits failed{error} when the process emits a spawn error (ENOENT)", async () => {
    const { orch, children, events } = setup({ urlScrapeTimeoutMs: 15 });

    const startPromise = orch.start();
    const child = children[0];
    child.emitSpawnError(new Error("spawn grok ENOENT"));

    const started = await startPromise;
    expect(started.outcome).toBe("started");

    const failed = lastEvent(events);
    expect(failed.phase).toBe("failed");
    if (failed.phase === "failed") {
      expect(failed.reason).toBe("error");
      expect(failed.error).toContain("ENOENT");
    }
    expect(orch.isInProgress()).toBe(false);
  });

  it("settles cleanly when spawning the OAuth process throws synchronously", async () => {
    const { orch, events } = setup({
      spawnFn: () => {
        throw new Error("spawn grok ENOENT");
      },
    });

    const started = await orch.start();

    expect(started.outcome).toBe("started");
    const failed = lastEvent(events);
    expect(failed).toMatchObject({ phase: "failed", reason: "error" });
    expect(orch.isInProgress()).toBe(false);
  });

  it("terminates and reports timed_out when the login timeout elapses", async () => {
    const { orch, stagingDir, children, events, terminatedChildren } = setup({
      loginTimeoutMs: 20,
      urlScrapeTimeoutMs: 60_000,
    });

    const startPromise = orch.start();
    const child = children[0];
    // Never resolve via URL or exit; the login timeout must fire.
    const loginId = loginIdOf(await startPromise);

    expect(terminatedChildren).toEqual([child]);
    const failed = lastEvent(events);
    expect(failed).toMatchObject({ phase: "failed", reason: "timed_out" });
    expect(existsSync(join(stagingDir, loginId))).toBe(false);
    expect(orch.isInProgress()).toBe(false);
  });

  it("cancel() kills the tree, reports cancelled, and cleans staging", async () => {
    const { orch, stagingDir, children, events, terminatedChildren } = setup();

    const startPromise = orch.start();
    const child = children[0];
    child.emitStderrLine(OAUTH_URL);
    const loginId = loginIdOf(await startPromise);

    const cancelled = await orch.cancel(loginId);
    expect(cancelled).toBe(true);
    expect(terminatedChildren).toEqual([child]);
    expect(events).toContainEqual({
      phase: "failed",
      loginId,
      reason: "cancelled",
      error: null,
    });
    expect(existsSync(join(stagingDir, loginId))).toBe(false);
    expect(orch.isInProgress()).toBe(false);

    // A second cancel of the same id is a no-op.
    expect(await orch.cancel(loginId)).toBe(false);
  });
});

describe("GrokLoginOrchestrator output hygiene", () => {
  it("never leaks a token from CLI output into any emitted event", async () => {
    const { orch, children, events } = setup({ urlScrapeTimeoutMs: 15 });
    const secret = "tok_SUPERSECRETVALUE_do_not_leak_0123456789";

    const startPromise = orch.start();
    const child = children[0];
    // A realistic error line carrying a token; must be scrubbed everywhere.
    child.emitStderrLine(`fatal: authentication rejected token=${secret}`);
    const started = await startPromise;
    // Scrape window elapsed with no URL, so nothing leaked into the start result.
    expect(started).toMatchObject({ outcome: "started", authUrl: null });

    child.emitExit(1);

    const failed = lastEvent(events);
    expect(failed.phase).toBe("failed");
    if (failed.phase === "failed") {
      expect(failed.error).toBeTruthy();
      expect(failed.error).not.toContain(secret);
    }
    // Belt and suspenders: the secret appears in NO emitted event, in any field.
    expect(JSON.stringify(events)).not.toContain(secret);
    // And the orchestrator was constructed without any logger dependency, so raw
    // output has nowhere to go except the (scrubbed) event error above.
  });
});

// Guard against silent orphaning: after every terminal path the store's staging
// root holds no per-login subdirectories.
describe("GrokLoginOrchestrator staging cleanup", () => {
  it("leaves the staging root empty after a completed login", async () => {
    const { orch, stagingDir, children, events } = setup();

    const startPromise = orch.start();
    const child = children[0];
    child.emitStderrLine(OAUTH_URL);
    const loginId = loginIdOf(await startPromise);
    writeFileSync(join(stagingDir, loginId, "auth.json"), JSON.stringify(makeModernAuthFile()));
    child.emitExit(0);

    expect(lastEvent(events).phase).toBe("completed");
    expect(readdirSync(stagingDir)).toEqual([]);
  });
});
