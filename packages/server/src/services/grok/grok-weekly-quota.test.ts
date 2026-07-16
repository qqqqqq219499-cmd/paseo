import { describe, expect, it } from "vitest";
import type { ProviderApiFetch } from "../quota-fetcher/provider.js";
import { fetchGrokWeeklyQuota, GrokWeeklyQuotaError } from "./grok-weekly-quota.js";

// A real GetGrokCreditsConfig gRPC-web response captured 2026-07-11 (quota
// numbers only — no credential material). Total 40%, Grok Build 35% / API 3% /
// Chat 2%, resets 2026-07-17 02:40 (+08:00). Matches the user's screenshot.
const REAL_RESPONSE_BASE64 =
  "AAAAAGgKZg0AACBCEgAaACIMCInWv9IGEODP3MkDKgwIicvk0gYQ4M/cyQM6BwgCFQAADEI6BwgBFQAAQEA6BwgEFQAAAEBCHggCEgwIida/0gYQ4M/cyQMaDAiJy+TSBhDgz9zJA1gBYgBoAYAAAAAPZ3JwYy1zdGF0dXM6MA0K";

function fakeFetch(options: {
  status?: number;
  grpcStatus?: string | null;
  body?: Uint8Array;
}): ProviderApiFetch {
  const status = options.status ?? 200;
  const body = options.body ?? new Uint8Array();
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "grpc-status" ? (options.grpcStatus ?? null) : null,
      },
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }) as unknown) as never;
}

describe("fetchGrokWeeklyQuota", () => {
  it("decodes the real gRPC-web response into weekly percent + reset + breakdown", async () => {
    const body = Uint8Array.from(Buffer.from(REAL_RESPONSE_BASE64, "base64"));
    const quota = await fetchGrokWeeklyQuota(fakeFetch({ body }), "fake-token");

    expect(quota.percentUsed).toBe(40);
    // 2026-07-16T18:40:09Z == 2026-07-17 02:40 +08:00 (the user's screenshot).
    expect(quota.resetsAt?.startsWith("2026-07-16T18:40")).toBe(true);

    const byCategory = Object.fromEntries(quota.breakdown.map((b) => [b.category, b.percentUsed]));
    expect(byCategory).toEqual({ build: 35, api: 3, chat: 2 });
    // The split sums to the whole-account total.
    const sum = quota.breakdown.reduce((acc, b) => acc + b.percentUsed, 0);
    expect(sum).toBe(quota.percentUsed);
  });

  it("throws http_error on a non-2xx status", async () => {
    await expect(fetchGrokWeeklyQuota(fakeFetch({ status: 401 }), "t")).rejects.toMatchObject({
      kind: "http_error",
    });
  });

  it("throws grpc_error when a grpc-status rides an HTTP 200", async () => {
    await expect(
      fetchGrokWeeklyQuota(fakeFetch({ status: 200, grpcStatus: "16" }), "t"),
    ).rejects.toBeInstanceOf(GrokWeeklyQuotaError);
  });

  it("throws decode_error on an empty/garbage frame", async () => {
    await expect(
      fetchGrokWeeklyQuota(fakeFetch({ body: new Uint8Array([0, 0, 0, 0, 0]) }), "t"),
    ).rejects.toMatchObject({ kind: "decode_error" });
  });
});
