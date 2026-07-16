import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GrokAccount, GrokAccountsState } from "@getpaseo/protocol/messages";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

const GROK_ACCOUNTS_STALE_TIME_MS = 60 * 1000;

export function grokAccountsQueryKey(serverId: string | null | undefined) {
  return ["grokAccounts", serverId ?? ""] as const;
}

export interface GrokStartLoginOutcome {
  outcome: "started" | "already_in_progress";
  loginId: string | null;
  authUrl: string | null;
  userCode: string | null;
}

export interface GrokSwitchOutcome {
  outcome: "switched" | "blocked";
  activeAccountId: string | null;
  blockingAgents: { agentId: string; title: string | null }[];
}

export interface GrokRemoveOutcome {
  outcome: "removed" | "blocked_active_account";
}

export interface UseGrokAccountsResult {
  // Whether the daemon advertises the Grok multi-account capability.
  supported: boolean;
  // True only when this client is the Electron desktop app AND this serverId is
  // its own desktop-managed local daemon — the gate for the Add-account button.
  isLocalDaemon: boolean;
  accounts: GrokAccount[];
  activeAccountId: string | null;
  unsavedActive: { email: string | null } | null;
  managedConfigActive: boolean;
  login: GrokAccountsState["login"];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  startLogin: (mode: "oauth" | "device-auth") => Promise<GrokStartLoginOutcome>;
  cancelLogin: (loginId: string) => Promise<void>;
  switchAccount: (accountId: string, options?: { force?: boolean }) => Promise<GrokSwitchOutcome>;
  removeAccount: (accountId: string, options?: { force?: boolean }) => Promise<GrokRemoveOutcome>;
}

const IDLE_LOGIN: GrokAccountsState["login"] = {
  state: "idle",
  loginId: null,
  error: null,
};

/** The rpc_error code carried by a daemon mutation rejection, if present. */
export function grokRpcErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

// Owns the Grok Build saved-account state for a host.
// The daemon is the custodian: every add / switch / remove / login-lifecycle
// change is broadcast on provider.grok.changed to ALL connected clients, so this
// hook subscribes to that push and writes the fresh state straight into the
// query cache — no refetch, and every client (phone, web, desktop) tracks the
// same live state. Mutations call the RPC and rely on the broadcast, with a
// query invalidation as a belt-and-suspenders fallback.
export function useGrokAccounts(serverId: string | null | undefined): UseGrokAccountsResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isLocalDaemon = useIsLocalDaemon(serverId ?? "");
  const supported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.grokAccounts === true,
  );
  const queryKey = useMemo(() => grokAccountsQueryKey(serverId), [serverId]);
  const canQuery = Boolean(serverId && client && isConnected && supported);

  const query = useQuery<GrokAccountsState>({
    queryKey,
    enabled: canQuery,
    staleTime: GROK_ACCOUNTS_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host connection is not ready");
      }
      // Ask for a per-account quota refresh on the primary list read.
      return client.grokListAccounts({ refreshQuota: true });
    },
  });

  useEffect(() => {
    if (!client || !supported) {
      return;
    }
    const unsubscribe = client.on("provider.grok.changed", (message) => {
      queryClient.setQueryData<GrokAccountsState>(queryKey, message.payload);
    });
    return unsubscribe;
  }, [client, supported, queryClient, queryKey]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const startLogin = useCallback(
    async (mode: "oauth" | "device-auth"): Promise<GrokStartLoginOutcome> => {
      if (!client) {
        throw new Error("Host connection is not ready");
      }
      const result = await client.grokStartLogin({ mode });
      return {
        outcome: result.outcome,
        loginId: result.loginId,
        authUrl: result.authUrl ?? null,
        userCode: result.userCode ?? null,
      };
    },
    [client],
  );

  const cancelLogin = useCallback(
    async (loginId: string) => {
      if (!client) {
        throw new Error("Host connection is not ready");
      }
      await client.grokCancelLogin({ loginId });
    },
    [client],
  );

  const switchAccount = useCallback(
    async (accountId: string, options?: { force?: boolean }): Promise<GrokSwitchOutcome> => {
      if (!client) {
        throw new Error("Host connection is not ready");
      }
      const result = await client.grokSwitchAccount({ accountId, force: options?.force });
      // The broadcast is authoritative; invalidate only as a fallback for a
      // client that missed the push.
      await queryClient.invalidateQueries({ queryKey });
      return {
        outcome: result.outcome,
        activeAccountId: result.activeAccountId ?? null,
        blockingAgents: (result.blockingAgents ?? []).map((agent) => ({
          agentId: agent.agentId,
          title: agent.title ?? null,
        })),
      };
    },
    [client, queryClient, queryKey],
  );

  const removeAccount = useCallback(
    async (accountId: string, options?: { force?: boolean }): Promise<GrokRemoveOutcome> => {
      if (!client) {
        throw new Error("Host connection is not ready");
      }
      const result = await client.grokRemoveAccount({ accountId, force: options?.force });
      await queryClient.invalidateQueries({ queryKey });
      return { outcome: result.outcome };
    },
    [client, queryClient, queryKey],
  );

  const state = query.data;

  return {
    supported,
    isLocalDaemon,
    accounts: state?.accounts ?? [],
    activeAccountId: state?.activeAccountId ?? null,
    unsavedActive: state?.unsavedActive ?? null,
    managedConfigActive: state?.managedConfigActive === true,
    login: state?.login ?? IDLE_LOGIN,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refresh,
    startLogin,
    cancelLogin,
    switchAccount,
    removeAccount,
  };
}
