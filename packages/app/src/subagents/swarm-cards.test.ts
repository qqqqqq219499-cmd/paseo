import { describe, expect, test } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";
import { providerSubagentKey } from "./provider-store";
import type { ProviderSubagentTimelineState } from "./provider-store";
import type { PaseoSubagentHistoryEntry } from "./paseo-history-store";
import type { StreamItem } from "@/types/stream";
import {
  buildSwarmCardViewModels,
  lastStreamActivityPreview,
  summarizeSwarmCards,
} from "./swarm-cards";

const SERVER_ID = "server-1";
const PARENT_ID = "parent-1";
const BASE_TS = Date.parse("2026-07-12T10:00:00.000Z");

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TS + offsetSeconds * 1000).toISOString();
}

function keyFor(subagentId: string, serverId = SERVER_ID, parentAgentId = PARENT_ID): string {
  return providerSubagentKey(serverId, parentAgentId, subagentId);
}

function makeDescriptor(
  subagentId: string,
  overrides: Partial<ProviderSubagentDescriptorPayload> = {},
): ProviderSubagentDescriptorPayload {
  return {
    id: subagentId,
    parentAgentId: PARENT_ID,
    provider: "claude",
    title: null,
    description: null,
    status: "running",
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
    toolCallId: null,
    ...overrides,
  };
}

function makeTimelineWithSeqs(
  entries: Array<{ seq: number; item: AgentTimelineItem }>,
): ProviderSubagentTimelineState {
  const rows: ProviderSubagentTimelineState["rows"] = new Map();
  let lastSeq = 0;
  for (const { seq, item } of entries) {
    rows.set(seq, { provider: "claude", item, timestamp: isoAt(seq) });
    lastSeq = Math.max(lastSeq, seq);
  }
  return { tail: [], head: [], epoch: "epoch-1", lastSeq, hasOlder: false, rows };
}

function makeTimeline(items: AgentTimelineItem[]): ProviderSubagentTimelineState {
  return makeTimelineWithSeqs(items.map((item, index) => ({ seq: index + 1, item })));
}

function completedToolCall(callId: string, name = "Read"): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name,
    status: "completed",
    error: null,
    detail: { type: "unknown", input: null, output: null },
  };
}

function runningToolCall(callId: string, name = "Read"): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name,
    status: "running",
    error: null,
    detail: { type: "unknown", input: null, output: null },
  };
}

function makePaseoAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  const createdAt = new Date(BASE_TS);
  return {
    serverId: SERVER_ID,
    id,
    provider: "claude",
    status: "running",
    activeTurn: null,
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt: createdAt,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    model: null,
    parentAgentId: PARENT_ID,
    labels: {},
    ...overrides,
  };
}

function buildCards(
  descriptors: Map<string, ProviderSubagentDescriptorPayload>,
  timelines: Map<string, ProviderSubagentTimelineState> = new Map(),
  paseoAgents: Agent[] = [],
  agentStreamTail?: Map<string, StreamItem[]>,
) {
  return buildSwarmCardViewModels({
    serverId: SERVER_ID,
    parentAgentId: PARENT_ID,
    paseoAgents,
    descriptors,
    timelines,
    agentStreamTail,
  });
}

describe("buildSwarmCardViewModels", () => {
  test("returns an empty array for empty input", () => {
    expect(buildCards(new Map())).toEqual([]);
  });

  test("ignores descriptors belonging to other parents or servers", () => {
    const descriptors = new Map([
      [keyFor("sub-1"), makeDescriptor("sub-1")],
      [
        keyFor("sub-2", SERVER_ID, "parent-2"),
        makeDescriptor("sub-2", { parentAgentId: "parent-2" }),
      ],
      [keyFor("sub-3", "server-2", PARENT_ID), makeDescriptor("sub-3")],
    ]);
    const cards = buildCards(descriptors);
    expect(cards.map((card) => card.subagentId)).toEqual(["sub-1"]);
  });

  test("builds a complete view model from descriptor and timeline", () => {
    const key = keyFor("sub-1");
    const descriptors = new Map([
      [
        key,
        makeDescriptor("sub-1", {
          provider: "codex",
          title: "  ",
          description: " Inspect the repo ",
          status: "completed",
          createdAt: isoAt(0),
          updatedAt: isoAt(5.5),
        }),
      ],
    ]);
    const timelines = new Map([
      [key, makeTimeline([{ type: "assistant_message", text: "Done." }])],
    ]);

    expect(buildCards(descriptors, timelines)).toEqual([
      {
        key,
        kind: "provider",
        subagentId: "sub-1",
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Inspect the repo",
        description: "Inspect the repo",
        status: "completed",
        displayState: "completed",
        toolCallCount: 0,
        lastActivityPreview: "Done.",
        createdAt: isoAt(0),
        updatedAt: isoAt(5.5),
        durationMs: 5500,
      },
    ]);
  });

  test("falls back to the default title when title and description are empty", () => {
    const descriptors = new Map([
      [keyFor("sub-1"), makeDescriptor("sub-1", { title: "   ", description: null })],
    ]);
    const cards = buildCards(descriptors);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("Subagent");
    expect(cards[0]?.description).toBeNull();
  });

  test("sorts running cards by createdAt ascending, then others by updatedAt descending", () => {
    const descriptors = new Map([
      [keyFor("sub-1"), makeDescriptor("sub-1", { status: "running", createdAt: isoAt(5) })],
      [
        keyFor("sub-2"),
        makeDescriptor("sub-2", { status: "completed", createdAt: isoAt(1), updatedAt: isoAt(10) }),
      ],
      [keyFor("sub-3"), makeDescriptor("sub-3", { status: "running", createdAt: isoAt(1) })],
      [
        keyFor("sub-4"),
        makeDescriptor("sub-4", { status: "failed", createdAt: isoAt(2), updatedAt: isoAt(20) }),
      ],
      [
        keyFor("sub-5"),
        makeDescriptor("sub-5", { status: "canceled", createdAt: isoAt(3), updatedAt: isoAt(15) }),
      ],
    ]);
    const cards = buildCards(descriptors);
    expect(cards.map((card) => card.subagentId)).toEqual([
      "sub-3",
      "sub-1",
      "sub-4",
      "sub-5",
      "sub-2",
    ]);
  });

  test("counts tool calls by unique call id across lifecycle rows", () => {
    const key = keyFor("sub-1");
    const timelines = new Map([
      [
        key,
        makeTimeline([
          runningToolCall("call-a", "Read"),
          completedToolCall("call-a", "Read"),
          completedToolCall("call-b", "Bash"),
          { type: "assistant_message", text: "Working on it." },
          { type: "todo", items: [{ text: "task", completed: false }] },
        ]),
      ],
    ]);
    const cards = buildCards(new Map([[key, makeDescriptor("sub-1")]]), timelines);
    expect(cards[0]?.toolCallCount).toBe(2);
  });

  test("reports zero tool calls and null activity without a timeline", () => {
    const cards = buildCards(new Map([[keyFor("sub-1"), makeDescriptor("sub-1")]]));
    expect(cards[0]?.toolCallCount).toBe(0);
    expect(cards[0]?.lastActivityPreview).toBeNull();
  });

  test("uses the latest row for the activity preview", () => {
    const key = keyFor("sub-1");
    const timelines = new Map([
      [
        key,
        makeTimelineWithSeqs([
          { seq: 1, item: { type: "assistant_message", text: "Earlier message." } },
          { seq: 4, item: completedToolCall("call-a", "Grep") },
        ]),
      ],
    ]);
    const cards = buildCards(new Map([[key, makeDescriptor("sub-1")]]), timelines);
    expect(cards[0]?.lastActivityPreview).toBe("Grep");
  });

  test("returns null activity when the latest row has no readable text", () => {
    const key = keyFor("sub-1");
    const timelines = new Map([
      [
        key,
        makeTimeline([
          completedToolCall("call-a", "Read"),
          { type: "todo", items: [{ text: "task", completed: true }] },
        ]),
      ],
    ]);
    const cards = buildCards(new Map([[key, makeDescriptor("sub-1")]]), timelines);
    expect(cards[0]?.lastActivityPreview).toBeNull();
  });

  test("truncates the activity preview to 80 characters with an ellipsis", () => {
    const key = keyFor("sub-1");
    const longText = "a".repeat(120);
    const timelines = new Map([
      [key, makeTimeline([{ type: "assistant_message", text: longText }])],
    ]);
    const cards = buildCards(new Map([[key, makeDescriptor("sub-1")]]), timelines);
    const preview = cards[0]?.lastActivityPreview;
    expect(preview).toBe(`${"a".repeat(79)}…`);
    expect(preview?.length).toBe(80);
  });

  test("collapses multiline activity text into a single line", () => {
    const key = keyFor("sub-1");
    const timelines = new Map([
      [key, makeTimeline([{ type: "error", message: "  first line\n\nsecond   line  " }])],
    ]);
    const cards = buildCards(new Map([[key, makeDescriptor("sub-1")]]), timelines);
    expect(cards[0]?.lastActivityPreview).toBe("first line second line");
  });

  test("clamps duration to zero when updatedAt precedes createdAt", () => {
    const descriptors = new Map([
      [keyFor("sub-1"), makeDescriptor("sub-1", { createdAt: isoAt(10), updatedAt: isoAt(4) })],
    ]);
    const cards = buildCards(descriptors);
    expect(cards[0]?.durationMs).toBe(0);
  });

  test("maps each paseo agent lifecycle status to card status and displayState", () => {
    const cases: Array<[AgentLifecycleStatus, string, string]> = [
      ["initializing", "running", "queued"],
      ["running", "running", "working"],
      ["idle", "completed", "completed"],
      ["error", "failed", "failed"],
      ["closed", "canceled", "canceled"],
    ];
    for (const [lifecycle, expectedStatus, expectedDisplay] of cases) {
      const cards = buildCards(new Map(), new Map(), [
        makePaseoAgent("paseo-1", { status: lifecycle }),
      ]);
      expect(cards[0]?.kind).toBe("paseo");
      expect(cards[0]?.status).toBe(expectedStatus);
      expect(cards[0]?.displayState).toBe(expectedDisplay);
    }
  });

  test("maps closed + attentionReason finished/error as completed/failed (legacy restart fallback)", () => {
    const finished = buildCards(new Map(), new Map(), [
      makePaseoAgent("paseo-1", { status: "closed", attentionReason: "finished" }),
    ]);
    expect(finished[0]?.status).toBe("completed");
    expect(finished[0]?.displayState).toBe("completed");

    const failed = buildCards(new Map(), new Map(), [
      makePaseoAgent("paseo-2", { status: "closed", attentionReason: "error" }),
    ]);
    expect(failed[0]?.status).toBe("failed");
    expect(failed[0]?.displayState).toBe("failed");
  });

  test("maps pending permission to waiting displayState with priority over working/queued", () => {
    const runningWaiting = buildCards(new Map(), new Map(), [
      makePaseoAgent("paseo-1", {
        status: "running",
        pendingPermissions: [{ id: "perm-1" } as never],
      }),
    ]);
    expect(runningWaiting[0]?.status).toBe("running");
    expect(runningWaiting[0]?.displayState).toBe("waiting");

    const initWaiting = buildCards(new Map(), new Map(), [
      makePaseoAgent("paseo-2", {
        status: "initializing",
        attentionReason: "permission",
      }),
    ]);
    expect(initWaiting[0]?.status).toBe("running");
    expect(initWaiting[0]?.displayState).toBe("waiting");

    const terminalWithPerm = buildCards(new Map(), new Map(), [
      makePaseoAgent("paseo-3", {
        status: "idle",
        pendingPermissions: [{ id: "perm-2" } as never],
      }),
    ]);
    expect(terminalWithPerm[0]?.status).toBe("completed");
    expect(terminalWithPerm[0]?.displayState).toBe("completed");
  });

  test("maps provider statuses to displayState", () => {
    const cases: Array<["running" | "completed" | "failed" | "canceled", string]> = [
      ["running", "working"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["canceled", "canceled"],
    ];
    for (const [status, display] of cases) {
      const cards = buildCards(new Map([[keyFor("sub-1"), makeDescriptor("sub-1", { status })]]));
      expect(cards[0]?.status).toBe(status);
      expect(cards[0]?.displayState).toBe(display);
    }
  });

  test("extracts paseo stream activity preview from agentStreamTail", () => {
    const tail: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "a1",
        text: " intermediate ",
        timestamp: new Date(BASE_TS),
      },
      {
        kind: "tool_call",
        id: "t1",
        timestamp: new Date(BASE_TS + 1),
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "c1",
            name: "  Bash  ",
            status: "running",
            error: null,
            detail: { type: "unknown", input: null, output: null },
          },
        },
      },
    ];
    const stream = new Map([["paseo-1", tail]]);
    const cards = buildCards(
      new Map(),
      new Map(),
      [makePaseoAgent("paseo-1", { status: "running" })],
      stream,
    );
    expect(cards[0]?.lastActivityPreview).toBe("Bash");
  });

  test("returns null paseo activity when agentStreamTail has no entry", () => {
    const cards = buildCards(new Map(), new Map(), [makePaseoAgent("paseo-1")]);
    expect(cards[0]?.lastActivityPreview).toBeNull();
  });

  test("builds a paseo card from an agent without a timeline", () => {
    const createdAt = new Date(BASE_TS);
    const updatedAt = new Date(BASE_TS + 3000);
    const cards = buildCards(new Map(), new Map(), [
      makePaseoAgent("paseo-1", { title: "  ", provider: "codex", createdAt, updatedAt }),
    ]);
    expect(cards).toEqual([
      {
        key: "paseo:paseo-1",
        kind: "paseo",
        subagentId: "paseo-1",
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Subagent",
        description: null,
        status: "running",
        displayState: "working",
        toolCallCount: 0,
        lastActivityPreview: null,
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
        durationMs: 3000,
      },
    ]);
  });

  test("sorts mixed paseo and provider cards together", () => {
    const descriptors = new Map([
      [keyFor("sub-1"), makeDescriptor("sub-1", { status: "running", createdAt: isoAt(5) })],
      [
        keyFor("sub-2"),
        makeDescriptor("sub-2", { status: "completed", createdAt: isoAt(1), updatedAt: isoAt(30) }),
      ],
    ]);
    const paseoAgents = [
      makePaseoAgent("paseo-1", {
        status: "running",
        createdAt: new Date(BASE_TS + 1000),
        updatedAt: new Date(BASE_TS + 1000),
      }),
      makePaseoAgent("paseo-2", {
        status: "error",
        createdAt: new Date(BASE_TS + 2000),
        updatedAt: new Date(BASE_TS + 40000),
      }),
    ];
    const cards = buildCards(descriptors, new Map(), paseoAgents);
    expect(cards.map((card) => [card.kind, card.subagentId])).toEqual([
      ["paseo", "paseo-1"],
      ["provider", "sub-1"],
      ["paseo", "paseo-2"],
      ["provider", "sub-2"],
    ]);
  });
});

describe("paseo card data source priority", () => {
  function makeHistoryEntry(overrides: Partial<PaseoSubagentHistoryEntry> = {}) {
    return { toolCallCount: 42, lastPreview: "persisted preview", fetchedAt: 1, ...overrides };
  }

  function buildPaseoCards(input: {
    agentStreamTail?: Map<string, StreamItem[]>;
    paseoHistory?: Map<string, PaseoSubagentHistoryEntry>;
  }) {
    return buildSwarmCardViewModels({
      serverId: SERVER_ID,
      parentAgentId: PARENT_ID,
      paseoAgents: [makePaseoAgent("paseo-1", { status: "idle" })],
      descriptors: new Map(),
      timelines: new Map(),
      agentStreamTail: input.agentStreamTail,
      paseoHistory: input.paseoHistory,
    });
  }

  const liveTail: StreamItem[] = [
    {
      kind: "tool_call",
      id: "t1",
      timestamp: new Date(BASE_TS),
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "c1",
          name: "Bash",
          status: "running",
          error: null,
          detail: { type: "unknown", input: null, output: null },
        },
      },
    },
    { kind: "assistant_message", id: "a1", text: "live preview", timestamp: new Date(BASE_TS + 1) },
  ];

  test("prefers the live stream while it has items", () => {
    const cards = buildPaseoCards({
      agentStreamTail: new Map([["paseo-1", liveTail]]),
      paseoHistory: new Map([["paseo-1", makeHistoryEntry()]]),
    });
    expect(cards[0]?.toolCallCount).toBe(1);
    expect(cards[0]?.lastActivityPreview).toBe("live preview");
  });

  test("falls back to persisted history once the stream tail is cleared", () => {
    const cards = buildPaseoCards({
      paseoHistory: new Map([["paseo-1", makeHistoryEntry()]]),
    });
    expect(cards[0]?.toolCallCount).toBe(42);
    expect(cards[0]?.lastActivityPreview).toBe("persisted preview");
  });

  test("treats an empty stream tail as absent", () => {
    const cards = buildPaseoCards({
      agentStreamTail: new Map([["paseo-1", []]]),
      paseoHistory: new Map([["paseo-1", makeHistoryEntry()]]),
    });
    expect(cards[0]?.toolCallCount).toBe(42);
    expect(cards[0]?.lastActivityPreview).toBe("persisted preview");
  });

  test("falls back to zero and null without any data source", () => {
    const cards = buildPaseoCards({});
    expect(cards[0]?.toolCallCount).toBe(0);
    expect(cards[0]?.lastActivityPreview).toBeNull();
  });
});

describe("summarizeSwarmCards", () => {
  test("returns zeros for an empty list", () => {
    expect(summarizeSwarmCards([])).toEqual({
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    });
  });

  test("counts cards by status", () => {
    const descriptors = new Map([
      [keyFor("sub-1"), makeDescriptor("sub-1", { status: "running" })],
      [keyFor("sub-2"), makeDescriptor("sub-2", { status: "running" })],
      [keyFor("sub-3"), makeDescriptor("sub-3", { status: "completed" })],
      [keyFor("sub-4"), makeDescriptor("sub-4", { status: "failed" })],
      [keyFor("sub-5"), makeDescriptor("sub-5", { status: "canceled" })],
      [keyFor("sub-6"), makeDescriptor("sub-6", { status: "completed" })],
    ]);
    expect(summarizeSwarmCards(buildCards(descriptors))).toEqual({
      total: 6,
      running: 2,
      completed: 2,
      failed: 1,
      canceled: 1,
    });
  });
});

describe("lastStreamActivityPreview", () => {
  test("prefers the latest previewable stream item", () => {
    const tail: StreamItem[] = [
      {
        kind: "thought",
        id: "th1",
        text: "thinking about files",
        timestamp: new Date(BASE_TS),
        status: "ready",
      },
      {
        kind: "todo_list",
        id: "td1",
        timestamp: new Date(BASE_TS + 1),
        provider: "claude",
        items: [{ text: "x", completed: false }],
      },
      {
        kind: "activity_log",
        id: "e1",
        timestamp: new Date(BASE_TS + 2),
        activityType: "error",
        message: " boom\n boom ",
      },
    ];
    expect(lastStreamActivityPreview(tail)).toBe("boom boom");
  });

  test("returns null for empty or missing tails", () => {
    expect(lastStreamActivityPreview(undefined)).toBeNull();
    expect(lastStreamActivityPreview([])).toBeNull();
  });
});
