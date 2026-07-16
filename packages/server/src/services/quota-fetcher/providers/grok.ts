import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ProviderUsage, ProviderUsageBalance } from "../../../server/messages.js";
import {
  extractBearerToken,
  parseGrokAuthFile,
  resolveGrokHome,
} from "../../grok/grok-auth-file.js";
import { fetchGrokBilling, GrokBillingError } from "../../grok/grok-billing.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import { balanceToneFromRemaining, unavailableUsage } from "../usage.js";

interface GrokQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
}

// Live usage card for the ACTIVE grok account (feeds `provider.usage.list`).
// Reads the daemon-resolved live auth file through the shared codec and the
// shared billing reader — the same home rule and credential shape the account
// switcher uses. Per-account quota for parked accounts lives in the account
// service (Step 5); this reader only ever reflects whoever is currently active.
export class GrokQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "grok";
  readonly displayName = "Grok";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: GrokQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    // Precedence unchanged: explicit env keys win over the live auth file.
    const token =
      process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"] || (await this.readGrokToken());

    if (!token) return unavailableUsage(this);

    let billing;
    try {
      billing = await fetchGrokBilling(this.fetchApi, token);
    } catch (error) {
      if (error instanceof GrokBillingError) {
        this.logger.debug({ status: error.status }, "Grok usage fetch failed");
        return unavailableUsage(this);
      }
      throw error;
    }

    const { monthlyLimit, creditUsage } = billing;
    const balances: ProviderUsageBalance[] = [];
    if (monthlyLimit !== null || creditUsage !== null) {
      const remaining =
        monthlyLimit !== null && creditUsage !== null
          ? Math.max(0, monthlyLimit - creditUsage)
          : null;
      balances.push({
        id: "monthly_credits",
        label: "Monthly credits",
        used: creditUsage,
        remaining,
        limit: monthlyLimit,
        unit: "credits",
        tone: balanceToneFromRemaining(remaining),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [],
      balances,
      details: [],
      error: null,
    };
  }

  // Bearer token of the active account from the daemon-resolved grok home
  // (`resolveGrokHome`: GROK_HOME or ~/.grok). Modern issuer-keyed files resolve
  // the active entry's `key` through the shared codec; a legacy top-level
  // `access_token` file still works via the codec's legacy branch.
  private async readGrokToken(): Promise<string | null> {
    const path = join(resolveGrokHome(process.env, homedir), "auth.json");
    if (!existsSync(path)) return null;
    try {
      return extractBearerToken(parseGrokAuthFile(await fs.readFile(path, "utf8")));
    } catch {
      return null;
    }
  }
}
