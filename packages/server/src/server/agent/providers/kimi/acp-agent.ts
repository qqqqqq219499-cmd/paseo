import type { Logger } from "pino";

import { GenericACPAgentClient } from "../generic-acp-agent.js";
import {
  createKimiConfigOptionsTransformer,
  createKimiThinkingOptionWriter,
} from "./reasoning-efforts.js";
import { createKimiContextUsageResolver } from "./session-context.js";

interface KimiACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

/**
 * Kimi Code CLI over ACP (`kimi acp`).
 *
 * Parity goals vs Grok provider:
 * - Context ring: kimi acp does not emit `usage_update`, so we load usage from
 *   on-disk `wire.jsonl` + `max_context_size` in config.toml (see session-context).
 * - Thinking picker: ACP only advertises thought_level `on`. Multi-level models
 *   (e.g. k3 with support_efforts low|high|max) are expanded from config.toml;
 *   selecting a level writes `[thinking].effort` so the CLI uses it on the next
 *   LLM step the same way the native TUI does.
 * - Modes/model list: driven by ACP configOptions as-is.
 */
export class KimiACPAgentClient extends GenericACPAgentClient {
  constructor(options: KimiACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      // Persist/resume handles must carry the registry provider id ("kimi"),
      // not the generic "acp" sentinel — otherwise wrapClientProvider rewrites
      // every handle and resume would lose the Kimi provider id.
      provider: options.providerId ?? "kimi",
      providerId: options.providerId ?? "kimi",
      label: options.label ?? "Kimi Code CLI",
      providerParams: options.providerParams,
      contextUsageResolver: createKimiContextUsageResolver(),
      configOptionsTransformer: createKimiConfigOptionsTransformer(),
      thinkingOptionWriter: createKimiThinkingOptionWriter(),
    });
  }
}
