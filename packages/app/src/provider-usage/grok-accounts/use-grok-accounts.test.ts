/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrokAccount, GrokAccountsState } from "@getpaseo/protocol/messages";

type ChangedHandler = (message: {
  type: "provider.grok.changed";
  payload: GrokAccountsState;
}) => void;

const hoisted = vi.hoisted(() => ({
  supported: true,
  isLocalDaemon: false,
  isConnected: true,
  client: null as unknown as MockClient,
  changedHandlers: [] as ChangedHandler[],
}));

interface MockClient {
  grokListAccounts: ReturnType<typeof vi.fn>;
  grokStartLogin: ReturnType<typeof vi.fn>;
  grokCancelLogin: ReturnType<typeof vi.fn>;
  grokSwitchAccount: ReturnType<typeof vi.fn>;
  grokRemoveAccount: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => hoisted.client,
  useHostRuntimeIsConnected: () => hoisted.isConnected,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "server-1": { serverInfo: { features: { grokAccounts: hoisted.supported } } },
      },
    }),
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useIsLocalDaemon: () => hoisted.isLocalDaemon,
}));

import { useGrokAccounts, type GrokSwitchOutcome } from "./use-grok-accounts";

function makeAccount(overrides: Partial<GrokAccount> & { id: string }): GrokAccount {
  return {
    email: `${overrides.id}@x.ai`,
    name: null,
    addedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeState(overrides?: Partial<GrokAccountsState>): GrokAccountsState {
  return {
    accounts: [],
    activeAccountId: null,
    unsavedActive: null,
    login: { state: "idle", loginId: null, error: null },
    ...overrides,
  };
}

function makeClient(): MockClient {
  return {
    grokListAccounts: vi.fn(async () => ({
      requestId: "req-1",
      ...makeState({ accounts: [makeAccount({ id: "a1" })], activeAccountId: "a1" }),
    })),
    grokStartLogin: vi.fn(async () => ({
      requestId: "req-1",
      outcome: "started" as const,
      loginId: "login-1",
      authUrl: "https://auth.x.ai/authorize?x=1",
    })),
    grokCancelLogin: vi.fn(async () => ({ requestId: "req-1", ok: true })),
    grokSwitchAccount: vi.fn(),
    grokRemoveAccount: vi.fn(),
    on: vi.fn((type: string, handler: ChangedHandler) => {
      if (type === "provider.grok.changed") {
        hoisted.changedHandlers.push(handler);
      }
      return () => {};
    }),
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderGrokHook() {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useGrokAccounts("server-1"), { wrapper });
}

describe("useGrokAccounts", () => {
  beforeEach(() => {
    hoisted.supported = true;
    hoisted.isLocalDaemon = false;
    hoisted.isConnected = true;
    hoisted.changedHandlers = [];
    hoisted.client = makeClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stays disabled and never queries when the capability flag is off", async () => {
    hoisted.supported = false;
    const { result } = renderGrokHook();

    expect(result.current.supported).toBe(false);
    // Give any effects a chance to run; the disabled query must not fire.
    await act(async () => {
      await Promise.resolve();
    });
    expect(hoisted.client.grokListAccounts).not.toHaveBeenCalled();
    expect(result.current.accounts).toEqual([]);
  });

  it("loads accounts and applies provider.grok.changed broadcasts into the cache", async () => {
    const { result } = renderGrokHook();

    await waitFor(() => {
      expect(result.current.accounts).toHaveLength(1);
    });
    expect(result.current.activeAccountId).toBe("a1");
    expect(hoisted.changedHandlers).toHaveLength(1);

    const pushed = makeState({
      accounts: [makeAccount({ id: "a1" }), makeAccount({ id: "a2" })],
      activeAccountId: "a2",
    });
    act(() => {
      for (const handler of hoisted.changedHandlers) {
        handler({ type: "provider.grok.changed", payload: pushed });
      }
    });

    await waitFor(() => {
      expect(result.current.accounts).toHaveLength(2);
    });
    expect(result.current.activeAccountId).toBe("a2");
    // The push updated the cache without a refetch.
    expect(hoisted.client.grokListAccounts).toHaveBeenCalledTimes(1);
  });

  it("returns the blocked outcome then switches with force", async () => {
    hoisted.client.grokSwitchAccount
      .mockResolvedValueOnce({
        requestId: "req-1",
        outcome: "blocked",
        blockingAgents: [{ agentId: "g1", title: "Running agent" }],
      })
      .mockResolvedValueOnce({
        requestId: "req-1",
        outcome: "switched",
        activeAccountId: "a2",
      });

    const { result } = renderGrokHook();
    await waitFor(() => {
      expect(result.current.accounts).toHaveLength(1);
    });

    let blocked!: GrokSwitchOutcome;
    await act(async () => {
      blocked = await result.current.switchAccount("a2");
    });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.blockingAgents).toEqual([{ agentId: "g1", title: "Running agent" }]);

    let forced!: GrokSwitchOutcome;
    await act(async () => {
      forced = await result.current.switchAccount("a2", { force: true });
    });
    expect(forced.outcome).toBe("switched");
    expect(forced.activeAccountId).toBe("a2");
    expect(hoisted.client.grokSwitchAccount).toHaveBeenNthCalledWith(1, {
      accountId: "a2",
      force: undefined,
    });
    expect(hoisted.client.grokSwitchAccount).toHaveBeenNthCalledWith(2, {
      accountId: "a2",
      force: true,
    });
  });
});
