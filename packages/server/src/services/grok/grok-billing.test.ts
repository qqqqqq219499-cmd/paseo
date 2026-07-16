import { describe, expect, it, vi } from "vitest";
import type { ProviderApiFetch } from "../quota-fetcher/provider.js";
import { fetchGrokBilling, GrokBillingError } from "./grok-billing.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeFetch(response: Response): ProviderApiFetch {
  return vi.fn(async () => response) as unknown as ProviderApiFetch;
}

describe("fetchGrokBilling", () => {
  it("maps the live billing shape (usage at config.used.val)", async () => {
    // Verbatim spike S5 body (HTTP 200 with a real saved key).
    const fetchApi = fakeFetch(
      jsonResponse({
        config: {
          monthlyLimit: { val: 15000 },
          used: { val: 1233 },
          onDemandCap: { val: 0 },
          billingPeriodStart: "2026-07-01T00:00:00+00:00",
          billingPeriodEnd: "2026-08-01T00:00:00+00:00",
          history: [{ billingCycle: {} }],
        },
      }),
    );

    await expect(fetchGrokBilling(fetchApi, "tok")).resolves.toEqual({
      monthlyLimit: 15000,
      creditUsage: 1233,
      periodEnd: "2026-08-01T00:00:00+00:00",
    });
  });

  it("falls back to the legacy usage.creditUsage field", async () => {
    const fetchApi = fakeFetch(
      jsonResponse({
        config: { monthlyLimit: { val: 60000 } },
        usage: { creditUsage: 12000 },
      }),
    );

    await expect(fetchGrokBilling(fetchApi, "tok")).resolves.toEqual({
      monthlyLimit: 60000,
      creditUsage: 12000,
      periodEnd: null,
    });
  });

  it("preserves a zero usage value from config.used.val", async () => {
    const fetchApi = fakeFetch(
      jsonResponse({
        config: { monthlyLimit: { val: 0 }, used: { val: 0 } },
        usage: { creditUsage: 999 },
      }),
    );

    await expect(fetchGrokBilling(fetchApi, "tok")).resolves.toEqual({
      monthlyLimit: 0,
      creditUsage: 0,
      periodEnd: null,
    });
  });

  it("throws GrokBillingError on a non-2xx response", async () => {
    const fetchApi = fakeFetch(new Response(null, { status: 401 }));

    await expect(fetchGrokBilling(fetchApi, "tok")).rejects.toBeInstanceOf(GrokBillingError);
  });

  it("sends the bearer token and xai auth headers", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ config: { used: { val: 5 } } }));

    await fetchGrokBilling(fetchSpy as unknown as ProviderApiFetch, "my-token");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-token",
          "X-XAI-Token-Auth": "xai-grok-cli",
        }),
      }),
    );
  });
});
