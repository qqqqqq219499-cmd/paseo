import type { SessionStateResponse } from "../acp-agent.js";

/**
 * Grok CLI settable reasoning efforts for models that support reasoning.
 *
 * Source of truth is the Grok Build CLI surface, not a hard-coded Paseo
 * invention:
 * - `/effort` documents: low | medium | high | xhigh
 *   (see ~/.grok/docs/user-guide/04-slash-commands.md)
 * - `--effort` also accepts none | minimal | max(=xhigh) and per-model menu
 *   ids; for the Paseo composer we mirror the interactive `/effort` set so
 *   the UI matches what a user can type in the Grok TUI.
 *
 * Grok's per-model `reasoningEfforts` menu is often a shorter recommended
 * list (e.g. high/medium/low only). Paseo still shows every CLI-settable
 * level for models that support reasoning, and keeps any extra per-model
 * menu ids (e.g. "deep") that the catalog advertises.
 */
export const GROK_CLI_REASONING_EFFORTS = [
  {
    id: "xhigh",
    value: "xhigh",
    label: "Extra high Effort",
    description: "CLI /effort xhigh — maximum reasoning depth",
    default: false,
  },
  {
    id: "high",
    value: "high",
    label: "High Effort",
    description: "CLI /effort high",
    default: false,
  },
  {
    id: "medium",
    value: "medium",
    label: "Medium Effort",
    description: "CLI /effort medium",
    default: false,
  },
  {
    id: "low",
    value: "low",
    label: "Low Effort",
    description: "CLI /effort low",
    default: false,
  },
] as const;

type AvailableModel = NonNullable<
  NonNullable<SessionStateResponse["models"]>["availableModels"]
>[number];

interface EffortEntry {
  id?: unknown;
  value?: unknown;
  label?: unknown;
  description?: unknown;
  default?: unknown;
}

function effortId(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as EffortEntry;
  if (typeof record.id === "string" && record.id) {
    return record.id;
  }
  if (typeof record.value === "string" && record.value) {
    return record.value;
  }
  return null;
}

function modelSupportsReasoningEffort(meta: Record<string, unknown>): boolean {
  if (meta.supportsReasoningEffort === true || meta.supports_reasoning_effort === true) {
    return true;
  }
  const efforts = meta.reasoningEfforts ?? meta.reasoning_efforts;
  return Array.isArray(efforts) && efforts.length > 0;
}

function readModelEfforts(meta: Record<string, unknown>): unknown[] {
  const efforts = meta.reasoningEfforts ?? meta.reasoning_efforts;
  return Array.isArray(efforts) ? efforts : [];
}

/**
 * Merge Grok CLI-settable efforts with the per-model recommended menu.
 * - Models without reasoning support are left unchanged.
 * - Existing menu entries keep their label/default when present.
 * - CLI levels missing from the menu are added so the UI matches `/effort`.
 * - Extra per-model ids (not in the CLI set) are preserved at the end.
 */
export function mergeGrokCliReasoningEfforts(modelEfforts: unknown[]): unknown[] {
  const byId = new Map<string, unknown>();
  for (const entry of modelEfforts) {
    const id = effortId(entry);
    if (id) {
      byId.set(id, entry);
    }
  }

  const merged: unknown[] = [];
  const seen = new Set<string>();

  // Prefer CLI display order (xhigh → high → medium → low).
  for (const cli of GROK_CLI_REASONING_EFFORTS) {
    const fromModel = byId.get(cli.id);
    if (fromModel) {
      merged.push(fromModel);
    } else {
      merged.push({ ...cli });
    }
    seen.add(cli.id);
  }

  // Keep any model-specific option ids the catalog advertised (e.g. "deep").
  for (const entry of modelEfforts) {
    const id = effortId(entry);
    if (!id || seen.has(id)) {
      continue;
    }
    merged.push(entry);
    seen.add(id);
  }

  return merged;
}

export function enrichGrokModelReasoningEfforts(model: AvailableModel): AvailableModel {
  const meta = model._meta;
  if (!meta || typeof meta !== "object") {
    return model;
  }

  if (!modelSupportsReasoningEffort(meta)) {
    return model;
  }

  const modelEfforts = readModelEfforts(meta);
  const merged = mergeGrokCliReasoningEfforts(modelEfforts);
  const existingIds = modelEfforts
    .map((entry) => effortId(entry))
    .filter((id): id is string => Boolean(id));
  const mergedIds = merged
    .map((entry) => effortId(entry))
    .filter((id): id is string => Boolean(id));

  // No change needed if the model menu already covers the CLI set in full.
  if (
    existingIds.length === mergedIds.length &&
    existingIds.every((id, index) => id === mergedIds[index])
  ) {
    return model;
  }

  return {
    ...model,
    _meta: {
      ...meta,
      reasoningEfforts: merged,
    },
  };
}

export function enrichGrokSessionReasoningEfforts(
  response: SessionStateResponse,
): SessionStateResponse {
  const models = response.models;
  if (!models?.availableModels?.length) {
    return response;
  }

  return {
    ...response,
    models: {
      ...models,
      availableModels: models.availableModels.map(enrichGrokModelReasoningEfforts),
    },
  };
}
