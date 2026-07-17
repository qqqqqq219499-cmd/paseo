import type { SessionModelState } from "@agentclientprotocol/sdk";

import type { AgentSelectOption } from "../agent-sdk-types.js";

function parseReasoningEffortOption(entry: unknown): AgentSelectOption | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as {
    id?: unknown;
    value?: unknown;
    label?: unknown;
    description?: unknown;
    default?: unknown;
  };
  const id =
    (typeof record.id === "string" && record.id) ||
    (typeof record.value === "string" && record.value) ||
    null;
  if (!id) {
    return null;
  }
  return {
    id,
    label: typeof record.label === "string" && record.label ? record.label : id,
    description: typeof record.description === "string" ? record.description : undefined,
    isDefault: record.default === true,
  };
}

export function deriveThinkingOptionsFromModelMeta(
  model: { _meta?: Record<string, unknown> | null } | null | undefined,
): { thinkingOptions: AgentSelectOption[]; currentThinkingOptionId: string | null } {
  const meta = model?._meta;
  if (!meta || typeof meta !== "object") {
    return { thinkingOptions: [], currentThinkingOptionId: null };
  }

  const efforts = meta.reasoningEfforts;
  if (!Array.isArray(efforts) || efforts.length === 0) {
    return { thinkingOptions: [], currentThinkingOptionId: null };
  }

  const thinkingOptions = efforts.flatMap((entry) => {
    const option = parseReasoningEffortOption(entry);
    return option ? [option] : [];
  });
  const currentThinkingOptionId =
    typeof meta.reasoningEffort === "string" && meta.reasoningEffort
      ? meta.reasoningEffort
      : (thinkingOptions.find((option) => option.isDefault)?.id ?? null);

  return { thinkingOptions, currentThinkingOptionId };
}

export function deriveCurrentThinkingOptionFromModels(
  models: SessionModelState | null | undefined,
  currentModelId?: string | null,
): string | null {
  if (!models?.availableModels?.length) {
    return null;
  }
  const modelId = currentModelId ?? models.currentModelId;
  const model =
    models.availableModels.find((entry) => entry.modelId === modelId) ??
    models.availableModels.find((entry) => entry.modelId === models.currentModelId) ??
    null;
  return deriveThinkingOptionsFromModelMeta(model).currentThinkingOptionId;
}

export function resolveThinkingOptionAfterModelChange(input: {
  requestedThinkingOptionId: string | null;
  targetFromMeta: {
    thinkingOptions: AgentSelectOption[];
    currentThinkingOptionId: string | null;
  };
}): string | null {
  const { requestedThinkingOptionId, targetFromMeta } = input;
  if (targetFromMeta.thinkingOptions.length === 0) {
    return requestedThinkingOptionId;
  }
  if (
    requestedThinkingOptionId &&
    targetFromMeta.thinkingOptions.some((option) => option.id === requestedThinkingOptionId)
  ) {
    return requestedThinkingOptionId;
  }
  return (
    targetFromMeta.currentThinkingOptionId ??
    targetFromMeta.thinkingOptions.find((option) => option.isDefault)?.id ??
    targetFromMeta.thinkingOptions[0]?.id ??
    null
  );
}
