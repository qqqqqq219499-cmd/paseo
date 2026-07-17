import type { Logger } from "pino";

import type {
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "../../agent-sdk-types.js";
import type { GrokQuotaFailoverController } from "../../../../services/grok/grok-account-service.js";
import { GenericACPAgentClient } from "../generic-acp-agent.js";
import { createGrokAutoFailoverSession } from "./auto-failover.js";
import { enrichGrokSessionModes, GROK_MODES, normalizeGrokModeId } from "./modes.js";
import { enrichGrokSessionReasoningEfforts } from "./reasoning-efforts.js";
import { createGrokContextUsageResolver } from "./session-context.js";

function enrichGrokSessionResponse(
  response: Parameters<typeof enrichGrokSessionReasoningEfforts>[0],
) {
  return enrichGrokSessionModes(enrichGrokSessionReasoningEfforts(response));
}

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
  accountController?: GrokQuotaFailoverController;
}

/**
 * Grok Build over ACP.
 *
 * Account switching reloads the same native session on the active credentials
 * (see docs/grok-accounts.md). Composer controls (synced from Grok CLI):
 * - Thinking: `/effort` set (low|medium|high|xhigh) merged onto model meta
 * - Modes: CLI permission modes via session/set_mode (ACP returns modes:null
 *   but accepts set_mode — we advertise GROK_MODES so the UI can list them)
 */
export class GrokACPAgentClient extends GenericACPAgentClient {
  private readonly accountController?: GrokQuotaFailoverController;

  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      // Persist/resume handles must carry the registry provider id ("grok"),
      // not the generic "acp" sentinel — otherwise wrapClientProvider rewrites
      // every handle and resume would lose the Grok provider id.
      provider: options.providerId ?? "grok",
      providerId: options.providerId ?? "grok",
      label: options.label ?? "Grok",
      providerParams: options.providerParams,
      defaultModes: GROK_MODES,
      modeIdTransformer: normalizeGrokModeId,
      sessionResponseTransformer: enrichGrokSessionResponse,
      contextUsageResolver: createGrokContextUsageResolver(),
    });
    this.accountController = options.accountController;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = await super.createSession(config, launchContext);
    return this.wrapAutoFailover(session, launchContext);
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = await super.resumeSession(handle, overrides, launchContext);
    return this.wrapAutoFailover(session, launchContext);
  }

  private wrapAutoFailover(
    session: AgentSession,
    launchContext?: AgentLaunchContext,
  ): AgentSession {
    const accountController = this.accountController;
    if (!accountController) {
      return session;
    }

    return createGrokAutoFailoverSession({
      session,
      accountController,
      agentId: launchContext?.agentId ?? null,
      boundAccountId: accountController.getActiveAccountId(),
      logger: this.logger,
      resumeSession: async (current) => {
        const handle = current.describePersistence();
        if (!handle) {
          throw new Error("Grok account reload requires a persisted session id");
        }
        return super.resumeSession(handle, undefined, launchContext);
      },
    });
  }
}
