import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { Agent } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { applySidebarSessionPlacements } from "./sidebar-session-placements";

/**
 * One row in the new-theme flat sessions sidebar: a single agent session
 * (conversation), enriched with the recency key we sort by and the project
 * name shown as the row subtitle.
 */
export interface SidebarSessionEntry extends AgentDirectoryEntry {
  /**
   * Sort key. The user wants ordering by "the most recent user message", which
   * lives on the live Agent as `lastUserMessageAt`; we fall back to
   * `lastActivityAt` for history-only sessions that aren't hydrated yet.
   */
  recencyAt: Date;
  /** Project (or workspace) name for the row subtitle, when known. */
  projectName: string | null;
}

export interface SidebarSessionsListResult {
  sessions: SidebarSessionEntry[];
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

const EMPTY_SESSIONS: SidebarSessionEntry[] = [];

/**
 * Sidebar workspace/session lists only show top-level agents. Child agents
 * created via create_agent stay out of the flat list and host/project counts;
 * they remain reachable from the parent session Swarm / subagents track.
 */
export function isSidebarTopLevelSessionAgent(
  agent: Pick<AgentDirectoryEntry, "parentAgentId">,
): boolean {
  return agent.parentAgentId == null;
}

/**
 * Merge history + live agents into the recency-sorted sidebar session list.
 * Pure so tests can cover archive filtering and subagent exclusion without RN.
 */
type SidebarLiveAgentSource = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "status"
  | "lastActivityAt"
  | "lastUserMessageAt"
  | "cwd"
  | "workspaceId"
  | "provider"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "archivedAt"
  | "createdAt"
  | "labels"
  | "projectPlacement"
  | "parentAgentId"
> & {
  pendingPermissions: { length: number };
};

export function buildSidebarSessionsList(input: {
  historyAgents: readonly AgentDirectoryEntry[];
  liveAgents?: Iterable<SidebarLiveAgentSource> | null;
}): SidebarSessionEntry[] {
  const byId = new Map<string, SidebarSessionEntry>();

  for (const agent of input.historyAgents) {
    if (agent.archivedAt || !isSidebarTopLevelSessionAgent(agent)) {
      continue;
    }
    byId.set(agent.id, {
      ...agent,
      parentAgentId: agent.parentAgentId ?? null,
      recencyAt: agent.lastActivityAt,
      projectName: agent.projectPlacement?.projectName ?? null,
    });
  }

  if (input.liveAgents) {
    for (const agent of input.liveAgents) {
      if (agent.archivedAt || !isSidebarTopLevelSessionAgent(agent)) {
        // Live state wins: a child (or archived) agent must not linger from history.
        byId.delete(agent.id);
        continue;
      }
      byId.set(agent.id, {
        id: agent.id,
        serverId: agent.serverId,
        title: agent.title ?? null,
        status: agent.status,
        lastActivityAt: agent.lastActivityAt,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId ?? undefined,
        provider: agent.provider,
        pendingPermissionCount: agent.pendingPermissions.length,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason,
        attentionTimestamp: agent.attentionTimestamp ?? null,
        archivedAt: agent.archivedAt ?? null,
        createdAt: agent.createdAt,
        labels: agent.labels,
        projectPlacement: agent.projectPlacement,
        parentAgentId: agent.parentAgentId ?? null,
        recencyAt: agent.lastUserMessageAt ?? agent.lastActivityAt,
        projectName: agent.projectPlacement?.projectName ?? null,
      });
    }
  }

  if (byId.size === 0) {
    return EMPTY_SESSIONS;
  }

  return applySidebarSessionPlacements(Array.from(byId.values())).sort(
    (left, right) => right.recencyAt.getTime() - left.recencyAt.getTime(),
  );
}

/**
 * Flat, recency-sorted list of every non-archived top-level session on the active host.
 *
 * Merges the per-server agent-history cache (the full set, incl. sessions not
 * loaded this run) with the live session-store agents (so new sessions,
 * renames, status changes, and fresh user messages show up without a refetch).
 * Live agents win on id and contribute `lastUserMessageAt` for the recency key.
 * Subagents (parentAgentId set) are excluded so the sidebar stays uncluttered.
 */
export function useSidebarSessionsList(serverId: string | null): SidebarSessionsListResult {
  const { agents, isInitialLoad, isRevalidating, refreshAll } = useAgentHistory({ serverId });
  const liveAgentsMap = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.agents : undefined,
  );

  const sessions = useMemo(
    () =>
      buildSidebarSessionsList({
        historyAgents: agents,
        liveAgents: liveAgentsMap?.values() ?? null,
      }),
    [agents, liveAgentsMap],
  );

  return { sessions, isInitialLoad, isRevalidating, refreshAll };
}
