import { z } from "zod";
import type { ProviderApiFetch } from "../quota-fetcher/provider.js";
import { ApiNumberSchema, fetchProviderApi } from "../quota-fetcher/usage.js";

// Shared reader for grok's billing/quota endpoint, used by both the live
// (active-account) usage card in `quota-fetcher/providers/grok.ts` and the
// per-account quota fan-out in the account service (Step 5). Pure over an
// injected `fetchApi` + a bearer token — no file/home resolution, no logging;
// callers own credential resolution and error policy.
//
// STRUCTURAL SECRECY (task design §1 rule 3): this module takes an already
// resolved bearer token and never persists or logs it. It must never move into
// `packages/protocol` — no wire schema may carry token bytes.

const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

// Confirmed live response shape (spike S5, 2026-07-11, HTTP 200 with a saved
// key): usage lives at `config.used.val`, limit at `config.monthlyLimit.val`,
// with `config.billingPeriodEnd` as a reset hint. The older reader looked at
// `usage.creditUsage`, which is ABSENT in the live response — kept only as a
// legacy fallback. Every numeric wrapper is the `{ val }` form; parse
// tolerantly (`.nullish()`) and let unknown fields (onDemandCap, history, …)
// pass through and be stripped.
const GrokBillingResponseSchema = z.object({
  config: z
    .object({
      monthlyLimit: z.object({ val: ApiNumberSchema.nullish() }).nullish(),
      used: z.object({ val: ApiNumberSchema.nullish() }).nullish(),
      billingPeriodEnd: z.string().nullish(),
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.nullish(),
    })
    .nullish(),
});

export interface GrokBilling {
  monthlyLimit: number | null;
  creditUsage: number | null;
  periodEnd: string | null;
}

// Non-2xx from the billing endpoint. Thrown (not swallowed to null) so callers
// decide the surface: the usage card maps it to "unavailable", the per-account
// quota path to `quota.status: "unknown"`.
export class GrokBillingError extends Error {
  constructor(readonly status: number) {
    super(`Grok billing API returned ${status}`);
    this.name = "GrokBillingError";
  }
}

export async function fetchGrokBilling(
  fetchApi: ProviderApiFetch,
  token: string,
): Promise<GrokBilling> {
  const res = await fetchProviderApi(fetchApi, GROK_BILLING_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new GrokBillingError(res.status);
  }

  const resp = GrokBillingResponseSchema.parse(await res.json());
  // `??` (not `||`) so a legitimate 0 from `config.used.val` is preserved and
  // does not fall through to the legacy field.
  const creditUsage = resp.config?.used?.val ?? resp.usage?.creditUsage ?? null;
  return {
    monthlyLimit: resp.config?.monthlyLimit?.val ?? null,
    creditUsage,
    periodEnd: resp.config?.billingPeriodEnd ?? null,
  };
}
