import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { providerSubagentKey } from "@/subagents/provider-store";
import type { ProviderSubagentTimelineState } from "@/subagents/provider-store";

export type SwarmCardStatus = "running" | "completed" | "failed" | "canceled";

export interface SwarmCardViewModel {
  key: string;
  subagentId: string;
  parentAgentId: string;
  provider: ProviderSubagentDescriptorPayload["provider"];
  title: string;
  description: string | null;
  status: SwarmCardStatus;
  toolCallCount: number;
  lastActivityPreview: string | null;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
}

export interface SwarmSummary {
  total: number;
  running: number;
  completed: number;
  failed: number;
  canceled: number;
}

const FALLBACK_TITLE = "Subagent";
const PREVIEW_MAX_LENGTH = 80;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, PREVIEW_MAX_LENGTH - 1)}…`;
}

function activityPreviewText(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "tool_call":
      return collapseWhitespace(item.name);
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

function countToolCalls(timeline: ProviderSubagentTimelineState | undefined): number {
  if (!timeline) {
    return 0;
  }
  const callIds = new Set<string>();
  for (const row of timeline.rows.values()) {
    if (row.item.type === "tool_call") {
      callIds.add(row.item.callId);
    }
  }
  return callIds.size;
}

function lastActivityPreview(timeline: ProviderSubagentTimelineState | undefined): string | null {
  if (!timeline || timeline.rows.size === 0) {
    return null;
  }
  let latestSeq = -1;
  let latestItem: AgentTimelineItem | null = null;
  for (const [seq, row] of timeline.rows) {
    if (seq > latestSeq) {
      latestSeq = seq;
      latestItem = row.item;
    }
  }
  if (!latestItem) {
    return null;
  }
  const text = activityPreviewText(latestItem);
  if (!text) {
    return null;
  }
  return truncatePreview(text);
}

function durationMs(createdAt: string, updatedAt: string): number {
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareSwarmCards(left: SwarmCardViewModel, right: SwarmCardViewModel): number {
  const leftRunning = left.status === "running";
  const rightRunning = right.status === "running";
  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1;
  }
  if (leftRunning) {
    return compareStrings(left.createdAt, right.createdAt) || compareStrings(left.key, right.key);
  }
  return compareStrings(right.updatedAt, left.updatedAt) || compareStrings(left.key, right.key);
}

export function buildSwarmCardViewModels(input: {
  serverId: string;
  parentAgentId: string;
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
}): SwarmCardViewModel[] {
  const cards: SwarmCardViewModel[] = [];
  for (const [key, subagent] of input.descriptors) {
    if (key !== providerSubagentKey(input.serverId, input.parentAgentId, subagent.id)) {
      continue;
    }
    const timeline = input.timelines.get(key);
    const title = subagent.title?.trim() || subagent.description?.trim() || FALLBACK_TITLE;
    const description = subagent.description?.trim() || null;
    cards.push({
      key,
      subagentId: subagent.id,
      parentAgentId: subagent.parentAgentId,
      provider: subagent.provider,
      title,
      description,
      status: subagent.status,
      toolCallCount: countToolCalls(timeline),
      lastActivityPreview: lastActivityPreview(timeline),
      createdAt: subagent.createdAt,
      updatedAt: subagent.updatedAt,
      durationMs: durationMs(subagent.createdAt, subagent.updatedAt),
    });
  }
  return cards.sort(compareSwarmCards);
}

export function summarizeSwarmCards(cards: SwarmCardViewModel[]): SwarmSummary {
  const summary: SwarmSummary = {
    total: cards.length,
    running: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
  };
  for (const card of cards) {
    summary[card.status] += 1;
  }
  return summary;
}
