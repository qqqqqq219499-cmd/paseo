import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";

export interface PaseoSubagentHistoryEntry {
  toolCallCount: number;
  lastPreview: string | null;
  fetchedAt: number;
}

interface PaseoSubagentHistoryState {
  entries: Map<string, PaseoSubagentHistoryEntry>;
  runningSeen: Set<string>;
  noteRunning(serverId: string, agentId: string): void;
  clearRunning(serverId: string, agentId: string): void;
  setEntry(serverId: string, agentId: string, entry: PaseoSubagentHistoryEntry): void;
}

export const PASEO_SUBAGENT_HISTORY_MAX_PAGES = 10;
export const PASEO_SUBAGENT_HISTORY_MAX_ENTRIES = 2000;
const PASEO_SUBAGENT_HISTORY_PAGE_LIMIT = 200;
const PREVIEW_MAX_LENGTH = 80;

export function paseoSubagentHistoryKey(serverId: string, agentId: string): string {
  return `${serverId}\0${agentId}`;
}

export const usePaseoSubagentHistoryStore = create<PaseoSubagentHistoryState>((set) => ({
  entries: new Map(),
  runningSeen: new Set(),
  noteRunning(serverId, agentId) {
    const key = paseoSubagentHistoryKey(serverId, agentId);
    set((state) => {
      if (state.runningSeen.has(key)) {
        return state;
      }
      const runningSeen = new Set(state.runningSeen);
      runningSeen.add(key);
      return { runningSeen };
    });
  },
  clearRunning(serverId, agentId) {
    const key = paseoSubagentHistoryKey(serverId, agentId);
    set((state) => {
      if (!state.runningSeen.has(key)) {
        return state;
      }
      const runningSeen = new Set(state.runningSeen);
      runningSeen.delete(key);
      return { runningSeen };
    });
  },
  setEntry(serverId, agentId, entry) {
    const key = paseoSubagentHistoryKey(serverId, agentId);
    set((state) => {
      const entries = new Map(state.entries);
      entries.set(key, entry);
      return { entries };
    });
  },
}));

type PaseoSubagentHistoryClient = Pick<DaemonClient, "fetchAgentTimeline">;

const pendingHistoryRequests = new WeakMap<
  PaseoSubagentHistoryClient,
  Map<string, Promise<void>>
>();

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function historyEntryPreviewText(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return collapseWhitespace(item.text);
    case "error":
      return collapseWhitespace(item.message);
    default:
      return null;
  }
}

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, PREVIEW_MAX_LENGTH - 1)}…`;
}

async function fetchHistorySummary(
  client: PaseoSubagentHistoryClient,
  agentId: string,
): Promise<{ toolCallCount: number; lastPreview: string | null }> {
  let toolCallCount = 0;
  let fetchedCount = 0;
  let lastPreview: string | null = null;

  let payload = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: PASEO_SUBAGENT_HISTORY_PAGE_LIMIT,
    projection: "projected",
  });

  for (let page = 0; page < PASEO_SUBAGENT_HISTORY_MAX_PAGES; page += 1) {
    // Pages arrive newest-first while entries inside a page are chronological,
    // so the first text-like entry found scanning backwards is the latest one.
    for (let index = payload.entries.length - 1; index >= 0; index -= 1) {
      const entry = payload.entries[index];
      if (!entry) continue;
      if (entry.item.type === "tool_call") {
        toolCallCount += 1;
      }
      if (lastPreview === null) {
        const text = historyEntryPreviewText(entry.item);
        if (text) {
          lastPreview = truncatePreview(text);
        }
      }
    }
    fetchedCount += payload.entries.length;
    if (
      fetchedCount >= PASEO_SUBAGENT_HISTORY_MAX_ENTRIES ||
      !payload.hasOlder ||
      !payload.startCursor ||
      page + 1 >= PASEO_SUBAGENT_HISTORY_MAX_PAGES
    ) {
      break;
    }
    payload = await client.fetchAgentTimeline(agentId, {
      direction: "before",
      cursor: payload.startCursor,
      limit: PASEO_SUBAGENT_HISTORY_PAGE_LIMIT,
      projection: "projected",
    });
  }

  return { toolCallCount, lastPreview };
}

export function refreshPaseoSubagentHistory(
  client: PaseoSubagentHistoryClient,
  serverId: string,
  agentId: string,
): Promise<void> {
  const requestKey = paseoSubagentHistoryKey(serverId, agentId);
  let clientRequests = pendingHistoryRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingHistoryRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(requestKey);
  if (pending) return pending;

  const request = fetchHistorySummary(client, agentId)
    .then((summary) =>
      usePaseoSubagentHistoryStore.getState().setEntry(serverId, agentId, {
        toolCallCount: summary.toolCallCount,
        lastPreview: summary.lastPreview,
        fetchedAt: Date.now(),
      }),
    )
    .finally(() => {
      clientRequests?.delete(requestKey);
    });
  clientRequests.set(requestKey, request);
  return request;
}

/**
 * Keep the persisted-history cache in sync with a paseo subagent card:
 * remember running agents, and fetch persisted history once when an agent
 * leaves the running state (or when no cached entry exists yet).
 * Returns the in-flight fetch promise, or null when no fetch was needed.
 */
export function syncPaseoSubagentHistory(
  client: PaseoSubagentHistoryClient,
  serverId: string,
  agentId: string,
  isRunning: boolean,
): Promise<void> | null {
  const key = paseoSubagentHistoryKey(serverId, agentId);
  const state = usePaseoSubagentHistoryStore.getState();
  if (isRunning) {
    state.noteRunning(serverId, agentId);
    return null;
  }
  if (!state.runningSeen.has(key) && state.entries.has(key)) {
    return null;
  }
  state.clearRunning(serverId, agentId);
  return refreshPaseoSubagentHistory(client, serverId, agentId);
}
