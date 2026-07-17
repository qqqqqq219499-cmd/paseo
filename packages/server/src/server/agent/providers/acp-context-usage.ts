import type { SessionNotification, UsageUpdate } from "@agentclientprotocol/sdk";

import type { AgentUsage } from "../agent-sdk-types.js";

export interface ACPContextUsageResolver {
  resolveInitialUsage?: (sessionId: string) => AgentUsage | undefined;
  resolveNotificationUsage?: (
    notification: SessionNotification,
    currentUsage: AgentUsage | undefined,
  ) => AgentUsage | undefined;
}

export function mapACPUsageUpdate(update: UsageUpdate | null | undefined): AgentUsage | undefined {
  if (!update) {
    return undefined;
  }

  const used = update.used;
  const size = update.size;
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0 ||
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    size <= 0
  ) {
    return undefined;
  }

  const usage: AgentUsage = {
    contextWindowUsedTokens: used,
    contextWindowMaxTokens: size,
  };
  const amount = update.cost?.amount;
  const currency = update.cost?.currency?.toUpperCase();
  if (
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    (!currency || currency === "USD")
  ) {
    usage.totalCostUsd = amount;
  }
  return usage;
}

export function mergeACPContextUsage(
  current: AgentUsage | undefined,
  update: AgentUsage | undefined,
): AgentUsage | undefined {
  if (!update) {
    return undefined;
  }

  const next = { ...current, ...update };
  const used = next.contextWindowUsedTokens;
  const max = next.contextWindowMaxTokens;
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0 ||
    typeof max !== "number" ||
    !Number.isFinite(max) ||
    max <= 0
  ) {
    return undefined;
  }
  if (
    current?.contextWindowUsedTokens === used &&
    current.contextWindowMaxTokens === max &&
    current.totalCostUsd === next.totalCostUsd
  ) {
    return undefined;
  }
  return next;
}
