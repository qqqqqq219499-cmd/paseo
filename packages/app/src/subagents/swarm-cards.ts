import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { providerSubagentKey } from "@/subagents/provider-store";
import type { ProviderSubagentTimelineState } from "@/subagents/provider-store";
import type { PaseoSubagentHistoryEntry } from "@/subagents/paseo-history-store";

export type SwarmCardStatus = "running" | "completed" | "failed" | "canceled";

export type SwarmCardDisplayState =
  | "queued"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled";

export interface SwarmCardViewModel {
  key: string;
  kind: "paseo" | "provider";
  subagentId: string;
  parentAgentId: string;
  provider: ProviderSubagentDescriptorPayload["provider"];
  title: string;
  description: string | null;
  status: SwarmCardStatus;
  displayState: SwarmCardDisplayState;
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

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncatePreview(text: string): string {
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

function streamItemPreviewText(item: StreamItem): string | null {
  switch (item.kind) {
    case "assistant_message":
    case "thought":
      return collapseWhitespace(item.text);
    case "tool_call": {
      const name =
        item.payload.source === "agent" ? item.payload.data.name : item.payload.data.toolName;
      return collapseWhitespace(name);
    }
    case "activity_log":
      return collapseWhitespace(item.message);
    default:
      return null;
  }
}

export function lastStreamActivityPreview(tail: StreamItem[] | undefined): string | null {
  if (!tail || tail.length === 0) {
    return null;
  }
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const item = tail[i];
    if (!item) continue;
    const text = streamItemPreviewText(item);
    if (text) {
      return truncatePreview(text);
    }
  }
  return null;
}

function countStreamToolCalls(tail: StreamItem[] | undefined): number | undefined {
  if (!tail || tail.length === 0) {
    return undefined;
  }
  let count = 0;
  for (const item of tail) {
    if (item.kind === "tool_call") {
      count += 1;
    }
  }
  return count;
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

function isTerminalLifecycle(status: AgentLifecycleStatus): boolean {
  return status === "idle" || status === "error" || status === "closed";
}

function paseoAgentNeedsPermission(agent: Agent): boolean {
  if (agent.pendingPermissions.length > 0) {
    return true;
  }
  return agent.attentionReason === "permission";
}

/**
 * Map Paseo lifecycle → card status.
 * `closed` alone means runtime unloaded / terminated; when attention still
 * records a finished/error outcome (legacy daemon restarts that overwrote
 * lastStatus), prefer that over labeling every closed agent "canceled".
 */
export function paseoAgentStatus(
  status: AgentLifecycleStatus,
  attentionReason?: Agent["attentionReason"],
): SwarmCardStatus {
  switch (status) {
    case "initializing":
    case "running":
      return "running";
    case "idle":
      return "completed";
    case "error":
      return "failed";
    case "closed":
      if (attentionReason === "finished") {
        return "completed";
      }
      if (attentionReason === "error") {
        return "failed";
      }
      return "canceled";
  }
}

export function paseoAgentDisplayState(agent: Agent): SwarmCardDisplayState {
  if (!isTerminalLifecycle(agent.status) && paseoAgentNeedsPermission(agent)) {
    return "waiting";
  }
  switch (agent.status) {
    case "initializing":
      return "queued";
    case "running":
      return "working";
    case "idle":
      return "completed";
    case "error":
      return "failed";
    case "closed":
      if (agent.attentionReason === "finished") {
        return "completed";
      }
      if (agent.attentionReason === "error") {
        return "failed";
      }
      return "canceled";
  }
}

function providerDisplayState(
  status: ProviderSubagentDescriptorPayload["status"],
): SwarmCardDisplayState {
  switch (status) {
    case "running":
      return "working";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
  }
}

export interface BuildSwarmCardViewModelsInput {
  serverId: string;
  parentAgentId: string;
  paseoAgents: Agent[];
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
  agentStreamTail?: Map<string, StreamItem[]>;
  paseoHistory?: Map<string, PaseoSubagentHistoryEntry>;
}

function buildPaseoSwarmCards(input: BuildSwarmCardViewModelsInput): SwarmCardViewModel[] {
  const cards: SwarmCardViewModel[] = [];
  const streamTail = input.agentStreamTail;
  for (const agent of input.paseoAgents) {
    const createdAt = agent.createdAt.toISOString();
    const updatedAt = agent.updatedAt.toISOString();
    // Live stream wins while it has items; once the agent finishes the tail is
    // cleared and the persisted-history cache takes over.
    const tail = streamTail?.get(agent.id);
    const history = input.paseoHistory?.get(agent.id);
    cards.push({
      key: `paseo:${agent.id}`,
      kind: "paseo",
      subagentId: agent.id,
      parentAgentId: agent.parentAgentId ?? input.parentAgentId,
      provider: agent.provider,
      title: agent.title?.trim() || FALLBACK_TITLE,
      description: null,
      status: paseoAgentStatus(agent.status, agent.attentionReason),
      displayState: paseoAgentDisplayState(agent),
      toolCallCount: countStreamToolCalls(tail) ?? history?.toolCallCount ?? 0,
      lastActivityPreview: lastStreamActivityPreview(tail) ?? history?.lastPreview ?? null,
      createdAt,
      updatedAt,
      durationMs: durationMs(createdAt, updatedAt),
    });
  }
  return cards;
}

function buildProviderSwarmCards(input: BuildSwarmCardViewModelsInput): SwarmCardViewModel[] {
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
      kind: "provider",
      subagentId: subagent.id,
      parentAgentId: subagent.parentAgentId,
      provider: subagent.provider,
      title,
      description,
      status: subagent.status,
      displayState: providerDisplayState(subagent.status),
      toolCallCount: countToolCalls(timeline),
      lastActivityPreview: lastActivityPreview(timeline),
      createdAt: subagent.createdAt,
      updatedAt: subagent.updatedAt,
      durationMs: durationMs(subagent.createdAt, subagent.updatedAt),
    });
  }
  return cards;
}

export function buildSwarmCardViewModels(
  input: BuildSwarmCardViewModelsInput,
): SwarmCardViewModel[] {
  return [...buildPaseoSwarmCards(input), ...buildProviderSwarmCards(input)].sort(
    compareSwarmCards,
  );
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
