import { z } from "zod";
import type { ProviderApiFetch } from "../quota-fetcher/provider.js";
import { fetchProviderApi } from "../quota-fetcher/usage.js";

// On-demand token refresh against xAI's OAuth token endpoint, scoped strictly
// to the quota path (task design §9): a parked non-active account's stored `key`
// slowly expires because grok only refreshes the ACTIVE file, so quota would
// always read "unknown". This exchanges a stored `refresh_token` for a fresh
// token. NO background scheduler / auto-rotation — callers trigger it only when
// a user views the list or switches.
//
// STRUCTURAL SECRECY (task design §1 rule 3): tokens flow in and out of this
// module but are never persisted or logged here (callers own re-store), and it
// must never move into `packages/protocol`.

// Public PKCE client id the grok CLI itself uses. Confirmed byte-identical to
// this host's `~/.grok/auth.json` issuer key
// `https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828` and cross-validated
// against four independent xAI OAuth ports plus xAI's official OIDC discovery
// document (task research/xai-oauth-refresh-protocol.md). No `client_secret`
// exists — this is a public client, so the constant is not a secret.
const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

const GrokTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.number().optional(),
});

export interface GrokRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  // Canonical ISO 8601, computed from `now + expires_in`, or null when the
  // response omits `expires_in`.
  expiresAt: string | null;
}

export type GrokRefreshErrorKind = "invalid_grant" | "http_error" | "network";

// `invalid_grant` means the refresh token is dead (revoked / expired 7-day
// window): callers surface `needsReauth` and MUST NOT retry-loop it.
// `http_error` and `network` are transient — quota just reads "unknown".
export class GrokRefreshError extends Error {
  constructor(
    readonly kind: GrokRefreshErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GrokRefreshError";
  }
}

export interface RefreshGrokTokenOptions {
  // Injectable clock so `expiresAt` is deterministic in tests.
  now?: () => Date;
}

// Singleflight: concurrent refreshes of the SAME `refresh_token` collapse to a
// single POST (every mined xAI implementation dedupes this way). A per-account
// quota fan-out would otherwise fire N identical refreshes for one token. Keyed
// by refresh_token, cleared on settle.
const inFlight = new Map<string, Promise<GrokRefreshResult>>();

export function refreshGrokToken(
  fetchApi: ProviderApiFetch,
  refreshToken: string,
  options: RefreshGrokTokenOptions = {},
): Promise<GrokRefreshResult> {
  const existing = inFlight.get(refreshToken);
  if (existing) {
    return existing;
  }
  const pending = performRefresh(fetchApi, refreshToken, options).finally(() => {
    inFlight.delete(refreshToken);
  });
  inFlight.set(refreshToken, pending);
  return pending;
}

async function performRefresh(
  fetchApi: ProviderApiFetch,
  refreshToken: string,
  options: RefreshGrokTokenOptions,
): Promise<GrokRefreshResult> {
  const now = options.now ?? (() => new Date());
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: GROK_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });

  let res: Response;
  try {
    res = await fetchProviderApi(fetchApi, GROK_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new GrokRefreshError("network", describeError(cause));
  }

  if (!res.ok) {
    // OAuth returns `invalid_grant` (RFC 6749 §5.2) as the dead-token signal;
    // key off the error code across the 4xx range rather than a single status
    // so a revoked token never falls into the transient `http_error` bucket.
    const detail = await safeReadText(res);
    if (res.status >= 400 && res.status < 500 && /invalid_grant/i.test(detail)) {
      throw new GrokRefreshError("invalid_grant", "grok refresh_token is no longer valid");
    }
    throw new GrokRefreshError("http_error", `grok token endpoint returned ${res.status}`);
  }

  const parsed = GrokTokenResponseSchema.parse(await res.json());
  const expiresAt =
    parsed.expires_in != null
      ? new Date(now().getTime() + parsed.expires_in * 1000).toISOString()
      : null;
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    idToken: parsed.id_token ?? null,
    expiresAt,
  };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "network request failed";
}
