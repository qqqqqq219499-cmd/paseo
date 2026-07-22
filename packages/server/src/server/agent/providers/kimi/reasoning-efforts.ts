import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";

import { resolveKimiHome } from "./session-context.js";

export interface KimiThinkingConfig {
  enabled: boolean;
  effort: string | null;
}

export interface KimiModelEffortSupport {
  modelAlias: string;
  /** Multi-level efforts from config.toml `support_efforts`. Empty when model only has on/off thinking. */
  supportEfforts: string[];
  defaultEffort: string | null;
  hasThinkingCapability: boolean;
}

const EFFORT_LABELS: Record<string, { label: string; description: string }> = {
  low: {
    label: "Low Effort",
    description: "CLI thinking effort low",
  },
  high: {
    label: "High Effort",
    description: "CLI thinking effort high",
  },
  max: {
    label: "Max Effort",
    description: "CLI thinking effort max",
  },
  on: {
    label: "Thinking On",
    description: "Model always thinks at fixed depth",
  },
  off: {
    label: "Thinking Off",
    description: "Disable thinking when the model allows it",
  },
};

function effortLabel(id: string): { label: string; description: string } {
  return (
    EFFORT_LABELS[id] ?? {
      label: id,
      description: `CLI thinking effort ${id}`,
    }
  );
}

/** Read global `[thinking]` block from config.toml. */
export function readKimiThinkingConfig(kimiHome: string): KimiThinkingConfig {
  const configPath = join(kimiHome, "config.toml");
  if (!existsSync(configPath)) {
    return { enabled: true, effort: null };
  }
  let toml: string;
  try {
    toml = readFileSync(configPath, "utf8");
  } catch {
    return { enabled: true, effort: null };
  }

  const header = "[thinking]";
  const start = toml.indexOf(header);
  if (start === -1) {
    return { enabled: true, effort: null };
  }
  const body = toml.slice(start + header.length);
  const nextSection = body.search(/\r?\n\s*\[/);
  const section = nextSection === -1 ? body : body.slice(0, nextSection);

  const enabledMatch = /^\s*enabled\s*=\s*(true|false)\s*$/im.exec(section);
  const effortMatch = /^\s*effort\s*=\s*"([^"]+)"\s*$/m.exec(section);
  return {
    enabled: enabledMatch ? enabledMatch[1]!.toLowerCase() === "true" : true,
    effort: effortMatch?.[1] ?? null,
  };
}

/**
 * Parse one `[models."<alias>"]` section for effort support.
 * Narrow TOML subset — same machine-written shape as context-window reader.
 */
export function readKimiModelEffortSupport(
  kimiHome: string,
  modelAlias: string,
): KimiModelEffortSupport | null {
  const configPath = join(kimiHome, "config.toml");
  if (!existsSync(configPath) || modelAlias.includes("]")) {
    return null;
  }
  let toml: string;
  try {
    toml = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  const header = `[models."${modelAlias}"]`;
  const start = toml.indexOf(header);
  if (start === -1) {
    return null;
  }
  const body = toml.slice(start + header.length);
  const nextSection = body.search(/\r?\n\s*\[/);
  const section = nextSection === -1 ? body : body.slice(0, nextSection);

  const efforts: string[] = [];
  const effortsMatch = /^\s*support_efforts\s*=\s*\[([^\]]*)\]\s*$/m.exec(section);
  if (effortsMatch) {
    for (const part of effortsMatch[1]!.split(",")) {
      const m = /"([^"]+)"/.exec(part);
      if (m?.[1]) {
        efforts.push(m[1]);
      }
    }
  }

  const defaultMatch = /^\s*default_effort\s*=\s*"([^"]+)"\s*$/m.exec(section);
  const capsMatch = /^\s*capabilities\s*=\s*\[([^\]]*)\]\s*$/m.exec(section);
  let hasThinkingCapability = efforts.length > 0;
  if (capsMatch) {
    hasThinkingCapability =
      hasThinkingCapability ||
      /"thinking"|"always_thinking"/.test(capsMatch[1] ?? "");
  }

  return {
    modelAlias,
    supportEfforts: efforts,
    defaultEffort: defaultMatch?.[1] ?? null,
    hasThinkingCapability,
  };
}

/**
 * Persist `[thinking].effort` so the next Kimi LLM step (and resumed sessions)
 * pick up the same depth the TUI would set via config.
 */
export function writeKimiThinkingEffort(kimiHome: string, effort: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(effort)) {
    throw new Error(`Invalid Kimi thinking effort: ${effort}`);
  }
  const configPath = join(kimiHome, "config.toml");
  if (!existsSync(configPath)) {
    throw new Error(`Kimi config not found at ${configPath}`);
  }
  const toml = readFileSync(configPath, "utf8");
  const header = "[thinking]";
  const start = toml.indexOf(header);
  if (start === -1) {
    const block = `\n[thinking]\nenabled = true\neffort = "${effort}"\n`;
    writeFileSync(configPath, `${toml.trimEnd()}\n${block}`, "utf8");
    return;
  }

  const bodyStart = start + header.length;
  const body = toml.slice(bodyStart);
  const nextSectionRel = body.search(/\r?\n\s*\[/);
  const sectionEnd = nextSectionRel === -1 ? toml.length : bodyStart + nextSectionRel;
  const section = toml.slice(bodyStart, sectionEnd);

  let nextSection: string;
  if (/^\s*effort\s*=/m.test(section)) {
    nextSection = section.replace(/^\s*effort\s*=\s*"[^"]*"\s*$/m, `effort = "${effort}"`);
  } else {
    nextSection = `${section.replace(/\s*$/, "")}\neffort = "${effort}"\n`;
  }

  writeFileSync(configPath, toml.slice(0, bodyStart) + nextSection + toml.slice(sectionEnd), "utf8");
}

function currentModelAlias(configOptions: SessionConfigOption[]): string | null {
  const modelOption = configOptions.find(
    (entry): entry is Extract<SessionConfigOption, { type: "select" }> =>
      entry.type === "select" && (entry.category === "model" || entry.id === "model"),
  );
  if (!modelOption || typeof modelOption.currentValue !== "string") {
    return null;
  }
  return modelOption.currentValue;
}

/**
 * Expand Kimi ACP's stub `thought_level` ("on" only) into the real CLI efforts
 * from config.toml when the active model advertises `support_efforts`.
 */
export function enrichKimiConfigOptions(
  configOptions: SessionConfigOption[],
  options: {
    kimiHome?: string;
    env?: NodeJS.ProcessEnv;
    homedirFn?: () => string;
  } = {},
): SessionConfigOption[] {
  const kimiHome =
    options.kimiHome ?? resolveKimiHome(options.env ?? process.env, options.homedirFn ?? homedir);
  const modelAlias = currentModelAlias(configOptions);
  const support = modelAlias ? readKimiModelEffortSupport(kimiHome, modelAlias) : null;
  const thinking = readKimiThinkingConfig(kimiHome);

  return configOptions.map((entry) => {
    if (entry.type !== "select") {
      return entry;
    }
    if (entry.category !== "thought_level" && entry.id !== "thinking") {
      return entry;
    }

    // Multi-level models (e.g. k3): low | high | max
    if (support && support.supportEfforts.length > 0) {
      const efforts = support.supportEfforts;
      const preferred =
        (thinking.effort && efforts.includes(thinking.effort) && thinking.effort) ||
        (support.defaultEffort && efforts.includes(support.defaultEffort) && support.defaultEffort) ||
        efforts[0]!;
      return {
        ...entry,
        name: entry.name || "Thinking",
        category: "thought_level",
        currentValue: preferred,
        options: efforts.map((id) => {
          const meta = effortLabel(id);
          return {
            value: id,
            name: meta.label,
            description: meta.description,
          };
        }),
      };
    }

    // Fixed-depth thinking models: keep on (optionally surface off if CLI listed it)
    if (support?.hasThinkingCapability) {
      const current =
        typeof entry.currentValue === "string" && entry.currentValue
          ? entry.currentValue
          : "on";
      return {
        ...entry,
        category: "thought_level",
        currentValue: current,
        options:
          entry.options && entry.options.length > 0
            ? entry.options
            : [{ value: "on", name: "Thinking On", description: effortLabel("on").description }],
      };
    }

    return entry;
  });
}

export function createKimiConfigOptionsTransformer(
  options: {
    kimiHome?: string;
    env?: NodeJS.ProcessEnv;
    homedirFn?: () => string;
  } = {},
): (configOptions: SessionConfigOption[]) => SessionConfigOption[] {
  return (configOptions) => enrichKimiConfigOptions(configOptions, options);
}

/**
 * Kimi ACP ignores non-`on` thought_level values. Persist effort into config.toml
 * so wire.jsonl / LLM requests pick up thinkingEffort like the native TUI.
 */
export function createKimiThinkingOptionWriter(
  options: {
    kimiHome?: string;
    env?: NodeJS.ProcessEnv;
    homedirFn?: () => string;
  } = {},
): (
  _connection: ClientSideConnection,
  _sessionId: string,
  thinkingOptionId: string,
) => Promise<void> {
  return async (_connection, _sessionId, thinkingOptionId) => {
    const kimiHome =
      options.kimiHome ?? resolveKimiHome(options.env ?? process.env, options.homedirFn ?? homedir);
    // "on" is the fixed-depth sentinel — still write a sane default high when present.
    if (thinkingOptionId === "on") {
      return;
    }
    if (thinkingOptionId === "off") {
      // Leave effort as-is; disabling thinking is not expressed as an effort string
      // in current config.toml samples. No-op rather than write an invalid value.
      return;
    }
    writeKimiThinkingEffort(kimiHome, thinkingOptionId);
  };
}
