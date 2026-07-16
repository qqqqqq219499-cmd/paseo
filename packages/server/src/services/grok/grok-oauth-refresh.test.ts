import { describe, expect, it, vi } from "vitest";
import type { ProviderApiFetch } from "../quota-fetcher/provider.js";
import { GrokRefreshError, refreshGrokToken } from "./grok-oauth-refresh.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeFetch(response: Response): ProviderApiFetch {
  return vi.fn(async () => response) as unknown as ProviderApiFetch;
}

// Deterministic clock so `expiresAt` is stable.
const fixedNow = () => new Date("2026-07-11T00:00:00.000Z");

async function captureRefreshError(promise: Promise<unknown>): Promise<GrokRefreshError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GrokRefreshError) {
      return err;
    }
    throw err;
  }
  throw new Error("expected refreshGrokToken to reject");
}

describe("refreshGrokToken", () => {
  it("maps fields and computes expiresAt from expires_in", async () => {
    const fetchApi = fakeFetch(
      jsonResponse({
        access_token: "at_new",
        refresh_token: "rt_new",
        id_token: "id_new",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );

    await expect(refreshGrokToken(fetchApi, "rt_map", { now: fixedNow })).resolves.toEqual({
      accessToken: "at_new",
      refreshToken: "rt_new",
      idToken: "id_new",
      expiresAt: "2026-07-11T01:00:00.000Z",
    });
  });

  it("leaves expiresAt null and optional fields null when omitted", async () => {
    const fetchApi = fakeFetch(jsonResponse({ access_token: "at_only" }));

    await expect(refreshGrokToken(fetchApi, "rt_minimal", { now: fixedNow })).resolves.toEqual({
      accessToken: "at_only",
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    });
  });

  it("sends the public client id form-encoded to the xai token endpoint", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ access_token: "at" }));

    await refreshGrokToken(fetchSpy as unknown as ProviderApiFetch, "rt_form", { now: fixedNow });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://auth.x.ai/oauth2/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );
    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit;
    const body = String(init.body ?? "");
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_id=b1a00492-073a-47ea-816f-4c329264a828");
    expect(body).toContain("refresh_token=rt_form");
  });

  it("classifies invalid_grant as a dead-token error", async () => {
    const fetchApi = fakeFetch(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const err = await captureRefreshError(refreshGrokToken(fetchApi, "rt_dead", { now: fixedNow }));

    expect(err.kind).toBe("invalid_grant");
  });

  it("classifies a 500 as a transient http_error", async () => {
    const fetchApi = fakeFetch(new Response("server exploded", { status: 500 }));

    const err = await captureRefreshError(refreshGrokToken(fetchApi, "rt_500", { now: fixedNow }));

    expect(err.kind).toBe("http_error");
  });

  it("classifies a fetch throw as a network error", async () => {
    const fetchApi = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as ProviderApiFetch;

    const err = await captureRefreshError(refreshGrokToken(fetchApi, "rt_net", { now: fixedNow }));

    expect(err.kind).toBe("network");
  });

  it("dedupes concurrent refreshes of the same token (singleflight)", async () => {
    let resolveFetch: ((res: Response) => void) | null = null;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = refreshGrokToken(fetchSpy as unknown as ProviderApiFetch, "rt_shared", {
      now: fixedNow,
    });
    const second = refreshGrokToken(fetchSpy as unknown as ProviderApiFetch, "rt_shared", {
      now: fixedNow,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch?.(jsonResponse({ access_token: "at_shared", expires_in: 3600 }));
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(a.accessToken).toBe("at_shared");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("issues a fresh POST once an earlier refresh of the same token settled", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ access_token: "at_again" }));

    await refreshGrokToken(fetchSpy as unknown as ProviderApiFetch, "rt_serial", { now: fixedNow });
    await refreshGrokToken(fetchSpy as unknown as ProviderApiFetch, "rt_serial", { now: fixedNow });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
