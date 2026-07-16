import { z } from "zod";
import type { ProviderApiFetch } from "../quota-fetcher/provider.js";

// Browser-free RFC 8628 login for the UI's copy-link channel. Grok 0.2.93's
// own --device-auth command opens the default browser on every platform, so it
// cannot implement a channel whose contract is "copy only". This module talks
// to the same public-client endpoints and returns Grok's native auth.json shape;
// the orchestrator keeps that credential in its existing staging directory.
const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_OAUTH_ISSUER = "https://auth.x.ai";
const GROK_DEVICE_ENDPOINT = `${GROK_OAUTH_ISSUER}/oauth2/device/code`;
const GROK_TOKEN_ENDPOINT = `${GROK_OAUTH_ISSUER}/oauth2/token`;
const GROK_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
});

const OAuthErrorSchema = z.object({ error: z.string() });

export interface GrokDeviceAuthChallenge {
  authUrl: string;
  userCode: string;
}

export interface GrokDeviceAuthResult {
  rawAuthJson: string;
}

export interface RunGrokDeviceAuthOptions {
  fetchApi?: ProviderApiFetch;
  signal: AbortSignal;
  onChallenge: (challenge: GrokDeviceAuthChallenge) => void;
  now?: () => Date;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export async function runGrokDeviceAuth(
  options: RunGrokDeviceAuthOptions,
): Promise<GrokDeviceAuthResult> {
  const fetchApi = options.fetchApi ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? sleepWithAbort;
  const deviceResponse = await fetchApi(GROK_DEVICE_ENDPOINT, {
    method: "POST",
    headers: oauthHeaders(),
    body: new URLSearchParams({
      client_id: GROK_OAUTH_CLIENT_ID,
      scope: GROK_OAUTH_SCOPE,
      referrer: "grok-build",
    }).toString(),
    signal: options.signal,
  });
  if (!deviceResponse.ok) {
    throw new Error(`Grok device authorization request failed (HTTP ${deviceResponse.status})`);
  }

  const device = parseResponse(DeviceCodeResponseSchema, await deviceResponse.json());
  const authUrl =
    device.verification_uri_complete ??
    `${device.verification_uri}?${new URLSearchParams({ user_code: device.user_code })}`;
  options.onChallenge({ authUrl, userCode: device.user_code });

  const expiresAt = now().getTime() + device.expires_in * 1000;
  let pollDelayMs = (device.interval ?? 5) * 1000;
  while (now().getTime() < expiresAt) {
    await sleep(pollDelayMs, options.signal);
    const tokenResponse = await fetchApi(GROK_TOKEN_ENDPOINT, {
      method: "POST",
      headers: oauthHeaders(),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: GROK_OAUTH_CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
      signal: options.signal,
    });
    if (tokenResponse.ok) {
      const token = parseResponse(TokenResponseSchema, await tokenResponse.json());
      return { rawAuthJson: buildAuthJson(token, now()) };
    }

    const oauthError = await readOAuthError(tokenResponse);
    if (oauthError === "authorization_pending") {
      continue;
    }
    if (oauthError === "slow_down") {
      pollDelayMs += 5_000;
      continue;
    }
    if (oauthError === "access_denied") {
      throw new Error("Grok device authorization was denied");
    }
    if (oauthError === "expired_token") {
      throw new Error("Grok device authorization expired");
    }
    throw new Error(`Grok device token request failed (HTTP ${tokenResponse.status})`);
  }
  throw new Error("Grok device authorization expired");
}

function oauthHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "x-grok-client-surface": "headless",
  };
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Grok authentication returned an invalid response");
  }
  return parsed.data;
}

async function readOAuthError(response: Response): Promise<string | null> {
  try {
    const parsed = OAuthErrorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

function buildAuthJson(token: z.infer<typeof TokenResponseSchema>, createdAt: Date): string {
  const accessClaims = decodeJwtPayload(token.access_token);
  const idClaims = token.id_token ? decodeJwtPayload(token.id_token) : {};
  const userId = stringClaim(idClaims, "sub") ?? stringClaim(accessClaims, "sub");
  if (!userId) {
    throw new Error("Grok authentication token did not identify an account");
  }
  const expiresAt = new Date(createdAt.getTime() + (token.expires_in ?? 3600) * 1000).toISOString();
  const entry = {
    key: token.access_token,
    auth_mode: "oidc",
    create_time: createdAt.toISOString(),
    user_id: userId,
    ...optionalString("email", stringClaim(idClaims, "email")),
    ...optionalString("first_name", stringClaim(idClaims, "given_name")),
    ...optionalString("last_name", stringClaim(idClaims, "family_name")),
    ...optionalString("principal_type", stringClaim(accessClaims, "principal_type")),
    ...optionalString("principal_id", stringClaim(accessClaims, "principal_id") ?? userId),
    ...optionalString("team_id", stringClaim(accessClaims, "team_id")),
    refresh_token: token.refresh_token,
    expires_at: expiresAt,
    oidc_issuer: GROK_OAUTH_ISSUER,
    oidc_client_id: GROK_OAUTH_CLIENT_ID,
  };
  return `${JSON.stringify({ [`${GROK_OAUTH_ISSUER}::${GROK_OAUTH_CLIENT_ID}`]: entry }, null, 2)}\n`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split(".")[1];
  if (!encoded) {
    throw new Error("Grok authentication returned an invalid token");
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid JWT payload");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Grok authentication returned an invalid token");
  }
}

function stringClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(name: string, value: string | null): Record<string, string> {
  return value === null ? {} : { [name]: value };
}

function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Grok device authorization cancelled");
  error.name = "AbortError";
  return error;
}
