import { describe, expect, it, vi } from "vitest";
import { runGrokDeviceAuth } from "./grok-device-auth.js";

const DEVICE_ENDPOINT = "https://auth.x.ai/oauth2/device/code";
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
    JSON.stringify(payload),
  ).toString("base64url")}.signature`;
}

describe("runGrokDeviceAuth", () => {
  it("returns a Grok-compatible credential after a pending device-code poll", async () => {
    const accessToken = jwt({
      iss: "https://auth.x.ai",
      sub: "user-1",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      iat: Date.parse("2026-07-11T23:55:00.000Z") / 1000,
      exp: Date.parse("2026-07-12T00:55:00.000Z") / 1000,
      principal_type: "User",
      principal_id: "user-1",
      team_id: "team-1",
    });
    const idToken = jwt({
      sub: "user-1",
      email: "user@example.com",
      given_name: "Example",
      family_name: "User",
    });
    const responses = [
      new Response(
        JSON.stringify({
          device_code: "device-secret",
          user_code: "ABCD-1234",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
          expires_in: 1800,
          interval: 5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: "refresh-secret",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ];
    const fetchApi = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected fetch");
      return response;
    });
    const onChallenge = vi.fn();
    const sleep = vi.fn(async () => undefined);

    const result = await runGrokDeviceAuth({
      fetchApi,
      signal: new AbortController().signal,
      onChallenge,
      sleep,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(onChallenge).toHaveBeenCalledOnce();
    expect(onChallenge).toHaveBeenCalledWith({
      authUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetchApi).toHaveBeenCalledTimes(3);
    expect(fetchApi.mock.calls[0]?.[0]).toBe(DEVICE_ENDPOINT);
    expect(fetchApi.mock.calls[1]?.[0]).toBe(TOKEN_ENDPOINT);
    expect(String(fetchApi.mock.calls[0]?.[1]?.body)).toContain(
      "client_id=b1a00492-073a-47ea-816f-4c329264a828",
    );
    expect(String(fetchApi.mock.calls[0]?.[1]?.body)).toContain("referrer=grok-build");
    expect(fetchApi.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-grok-client-surface": "headless",
    });
    expect(String(fetchApi.mock.calls[1]?.[1]?.body)).toContain("device_code=device-secret");

    expect(JSON.parse(result.rawAuthJson)).toEqual({
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: accessToken,
        auth_mode: "oidc",
        create_time: "2026-07-12T00:00:00.000Z",
        user_id: "user-1",
        email: "user@example.com",
        first_name: "Example",
        last_name: "User",
        principal_type: "User",
        principal_id: "user-1",
        team_id: "team-1",
        refresh_token: "refresh-secret",
        expires_at: "2026-07-12T01:00:00.000Z",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      },
    });
  });
});
