import type { TFunction } from "i18next";

import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";

/**
 * Server-provided agent features and thinking options carry English labels.
 * For well-known IDs we override with localized strings; unknown IDs fall back
 * to whatever the daemon sent.
 */
const KNOWN_FEATURE_IDS = ["fast_mode", "plan_mode", "ultracode"] as const;
type KnownFeatureId = (typeof KNOWN_FEATURE_IDS)[number];

function isKnownFeatureId(id: string): id is KnownFeatureId {
  return (KNOWN_FEATURE_IDS as readonly string[]).includes(id);
}

export function localizeAgentFeature(t: TFunction, feature: AgentFeature): AgentFeature {
  if (!isKnownFeatureId(feature.id)) {
    return feature;
  }
  return {
    ...feature,
    label: t(`agentControls.features.known.${feature.id}.label`),
    description: t(`agentControls.features.known.${feature.id}.description`),
    tooltip: t(`agentControls.features.known.${feature.id}.tooltip`),
  };
}

const KNOWN_MODE_KEYS = [
  "alwaysAsk",
  "autoMode",
  "autoReview",
  "defaultPermissions",
  "fullAccess",
  "acceptFileEdits",
  "planMode",
  "bypass",
  "readOnly",
  "dontAsk",
] as const;
type KnownModeKey = (typeof KNOWN_MODE_KEYS)[number];

function compactModeLabel(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s_-]+/g, "").toLowerCase();
}

const COMPACT_ID_TO_MODE: Record<string, KnownModeKey> = {
  autoreview: "autoReview",
  fullaccess: "fullAccess",
  acceptedits: "acceptFileEdits",
  plan: "planMode",
  planmode: "planMode",
  bypasspermissions: "bypass",
  alwaysapprove: "bypass",
  yolo: "bypass",
  readonly: "readOnly",
  dontask: "dontAsk",
  defaultpermissions: "defaultPermissions",
  alwaysask: "alwaysAsk",
  automode: "autoMode",
  acceptfileedits: "acceptFileEdits",
  bypass: "bypass",
};

function resolveKnownModeKey(mode: { id: string; label?: string | null }): KnownModeKey | null {
  const compactId = compactModeLabel(mode.id);
  const compactLabel = compactModeLabel(mode.label);

  if (compactId === "auto") {
    return compactLabel === "defaultpermissions" ? "defaultPermissions" : "autoMode";
  }
  if (compactId === "default") {
    if (compactLabel === "alwaysask" || compactLabel === "default" || !compactLabel) {
      return "alwaysAsk";
    }
    return null;
  }
  return COMPACT_ID_TO_MODE[compactId] ?? COMPACT_ID_TO_MODE[compactLabel] ?? null;
}

export function localizeAgentModeLabel(
  t: TFunction,
  mode: { id: string; label?: string | null },
  fallback: (mode: { id: string; label?: string | null }) => string,
): string {
  const key = resolveKnownModeKey(mode);
  return key ? t(`agentControls.mode.known.${key}`) : fallback(mode);
}

const THINKING_LEVEL_IDS = ["low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevelId = (typeof THINKING_LEVEL_IDS)[number];

function asThinkingLevelId(value: string): ThinkingLevelId | null {
  const compact = value.replace(/[\s_-]+/g, "").toLowerCase();
  if (compact === "extrahigh") return "xhigh";
  return (THINKING_LEVEL_IDS as readonly string[]).includes(compact)
    ? (compact as ThinkingLevelId)
    : null;
}

export function localizeThinkingOptionLabel(
  t: TFunction,
  option: { id: string; label?: string | null },
): string {
  const compactId = option.id.replace(/[\s_-]+/g, "").toLowerCase();
  if (compactId === "ultracode") {
    return t("agentControls.thinking.levels.ultracode");
  }
  const level = asThinkingLevelId(option.id) ?? asThinkingLevelId(option.label ?? "");
  if (level) {
    return t(`agentControls.thinking.levels.${level}`);
  }
  // Fallback uses i18n-aware formatter (handles extra-high aliases, etc.).
  return formatThinkingOptionLabel(option);
}
