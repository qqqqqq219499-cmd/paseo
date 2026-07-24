import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  PASEO_SUBAGENT_HISTORY_MAX_ENTRIES,
  PASEO_SUBAGENT_HISTORY_MAX_PAGES,
  paseoSubagentHistoryKey,
  refreshPaseoSubagentHistory,
  syncPaseoSubagentHistory,
  usePaseoSubagentHistoryStore,
} from "./paseo-history-store";

type TimelineClient = Pick<DaemonClient, "fetchAgentTimeline">;
type TimelineRequest = Parameters<TimelineClient["fetchAgentTimeline"]>[1];
type TimelinePage = Awaited<ReturnType<TimelineClient["fetchAgentTimeline"]>>;
type TimelineEntry = TimelinePage["entries"][number];

const SERVER_ID = "server-1";
const AGENT_ID = "agent-1";

function historyKey(serverId = SERVER_ID, agentId = AGENT_ID): string {
  return paseoSubagentHistoryKey(serverId, agentId);
}

function assistantMessage(text: string): AgentTimelineItem {
  return { type: "assistant_message", text };
}

function toolCall(callId: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name: "Read",
    status: "completed",
    error: null,
    detail: { type: "unknown", input: null, output: null },
  };
}

function makeEntry(item: AgentTimelineItem, seq: number): TimelineEntry {
  return {
    provider: "claude",
    item,
    timestamp: new Date(seq * 1000).toISOString(),
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
  };
}

function makePage(
  entries: TimelineEntry[],
  overrides: { hasOlder?: boolean; startCursor?: { epoch: string; seq: number } | null } = {},
): TimelinePage {
  return {
    entries,
    hasOlder: overrides.hasOlder ?? false,
    startCursor: overrides.startCursor ?? null,
  } as TimelinePage;
}

function makeClient(pages: TimelinePage[]) {
  const requests: Array<{ agentId: string; request: TimelineRequest }> = [];
  let index = 0;
  const client: TimelineClient = {
    fetchAgentTimeline: vi.fn(async (agentId: string, request: TimelineRequest) => {
      requests.push({ agentId, request });
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return page;
    }),
  };
  return { client, requests };
}

beforeEach(() => {
  usePaseoSubagentHistoryStore.setState({ entries: new Map(), runningSeen: new Set() });
});

describe("syncPaseoSubagentHistory", () => {
  test("does not fetch while the agent is running", () => {
    const { client } = makeClient([]);
    expect(syncPaseoSubagentHistory(client, SERVER_ID, AGENT_ID, true)).toBeNull();
    expect(client.fetchAgentTimeline).not.toHaveBeenCalled();
    expect(usePaseoSubagentHistoryStore.getState().runningSeen.has(historyKey())).toBe(true);
  });

  test("fetches once when the agent leaves the running state", async () => {
    const page = makePage([
      makeEntry(toolCall("call-1"), 1),
      makeEntry(assistantMessage("Done"), 2),
    ]);
    const { client } = makeClient([page]);

    expect(syncPaseoSubagentHistory(client, SERVER_ID, AGENT_ID, true)).toBeNull();
    const request = syncPaseoSubagentHistory(client, SERVER_ID, AGENT_ID, false);
    expect(request).not.toBeNull();
    await request;

    const entry = usePaseoSubagentHistoryStore.getState().entries.get(historyKey());
    expect(entry?.toolCallCount).toBe(1);
    expect(entry?.lastPreview).toBe("Done");
    expect(entry?.fetchedAt).toBeGreaterThan(0);

    // A later finished sync without an intervening run does not refetch.
    expect(syncPaseoSubagentHistory(client, SERVER_ID, AGENT_ID, false)).toBeNull();
    expect(client.fetchAgentTimeline).toHaveBeenCalledTimes(1);
  });

  test("backfills finished agents that have no cached entry", async () => {
    const { client } = makeClient([makePage([makeEntry(assistantMessage("old"), 1)])]);
    const request = syncPaseoSubagentHistory(client, SERVER_ID, AGENT_ID, false);
    expect(request).not.toBeNull();
    await request;
    expect(client.fetchAgentTimeline).toHaveBeenCalledTimes(1);
  });

  test("refetches after the agent ran again", async () => {
    const { client } = makeClient([makePage([]), makePage([])]);
    await syncPaseoSubagentHistory(client, SERVER_ID, AGENT_ID, false);
    syncPaseoSubagentHistory(client, SERVER_ID, AGENT_ID, true);
    await syncPaseoSubagentHistory(client, SERVER_ID, AGENT_ID, false);
    expect(client.fetchAgentTimeline).toHaveBeenCalledTimes(2);
  });
});

describe("refreshPaseoSubagentHistory", () => {
  test("dedupes concurrent refreshes for the same agent", async () => {
    let resolvePage: (page: TimelinePage) => void = () => {};
    const gate = new Promise<TimelinePage>((resolve) => {
      resolvePage = resolve;
    });
    const client: TimelineClient = { fetchAgentTimeline: vi.fn(async () => gate) };

    const first = refreshPaseoSubagentHistory(client, SERVER_ID, AGENT_ID);
    const second = refreshPaseoSubagentHistory(client, SERVER_ID, AGENT_ID);
    expect(second).toBe(first);
    resolvePage(makePage([makeEntry(toolCall("call-1"), 1)]));
    await Promise.all([first, second]);
    expect(client.fetchAgentTimeline).toHaveBeenCalledTimes(1);
  });

  test("pages backwards until the history is exhausted", async () => {
    const cursor = { epoch: "epoch-1", seq: 10 };
    const pages = [
      makePage([makeEntry(assistantMessage("latest"), 3)], { hasOlder: true, startCursor: cursor }),
      makePage([makeEntry(toolCall("call-1"), 2), makeEntry(assistantMessage("earlier"), 1)]),
    ];
    const { client, requests } = makeClient(pages);

    await refreshPaseoSubagentHistory(client, SERVER_ID, AGENT_ID);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.request).toMatchObject({ direction: "tail" });
    expect(requests[1]?.request).toMatchObject({ direction: "before", cursor });
    const entry = usePaseoSubagentHistoryStore.getState().entries.get(historyKey());
    // The newest page wins the preview even though it was fetched first.
    expect(entry?.lastPreview).toBe("latest");
    expect(entry?.toolCallCount).toBe(1);
  });

  test("caps pagination at the page limit", async () => {
    const cursor = { epoch: "epoch-1", seq: 1 };
    const page = makePage([makeEntry(toolCall("call-1"), 1)], {
      hasOlder: true,
      startCursor: cursor,
    });
    const { client, requests } = makeClient([page]);

    await refreshPaseoSubagentHistory(client, SERVER_ID, AGENT_ID);

    expect(requests).toHaveLength(PASEO_SUBAGENT_HISTORY_MAX_PAGES);
  });

  test("stops once the entry budget is reached", async () => {
    const entries = Array.from({ length: PASEO_SUBAGENT_HISTORY_MAX_ENTRIES }, (_, index) =>
      makeEntry(toolCall(`call-${index}`), index + 1),
    );
    const page = makePage(entries, {
      hasOlder: true,
      startCursor: { epoch: "epoch-1", seq: 1 },
    });
    const { client, requests } = makeClient([page]);

    await refreshPaseoSubagentHistory(client, SERVER_ID, AGENT_ID);

    expect(requests).toHaveLength(1);
    const entry = usePaseoSubagentHistoryStore.getState().entries.get(historyKey());
    expect(entry?.toolCallCount).toBe(PASEO_SUBAGENT_HISTORY_MAX_ENTRIES);
  });

  test("clears the pending marker on failure so a retry can happen", async () => {
    const client: TimelineClient = {
      fetchAgentTimeline: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(makePage([makeEntry(assistantMessage("ok"), 1)])),
    };

    await expect(refreshPaseoSubagentHistory(client, SERVER_ID, AGENT_ID)).rejects.toThrow("boom");
    await refreshPaseoSubagentHistory(client, SERVER_ID, AGENT_ID);

    expect(client.fetchAgentTimeline).toHaveBeenCalledTimes(2);
    const entry = usePaseoSubagentHistoryStore.getState().entries.get(historyKey());
    expect(entry?.lastPreview).toBe("ok");
  });
});

describe("paseoSubagentHistoryKey", () => {
  test("separates server and agent ids without collisions", () => {
    expect(paseoSubagentHistoryKey("server", "12")).not.toBe(
      paseoSubagentHistoryKey("server1", "2"),
    );
    expect(historyKey()).toBe(`${SERVER_ID}\0${AGENT_ID}`);
  });
});
