import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createAuthorizationRequest,
  exchangeCodeForIdentity,
  type FeishuAuthConfig
} from "./feishu-auth";

const config: FeishuAuthConfig = {
  appId: "cli_test123",
  appSecret: "app-secret",
  redirectUri: "https://auto-ux.example/auto-ux/api/auth/feishu/callback",
  sessionSecret: "session-secret-that-is-at-least-32-characters"
};

describe("Feishu OAuth client", () => {
  it("builds an authorization URL with state and S256 PKCE", () => {
    const auth = createAuthorizationRequest(
      config,
      new Date("2026-09-01T10:00:00.000Z")
    );
    const url = new URL(auth.authorizationUrl);

    expect(url.origin + url.pathname).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe(config.appId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe(auth.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(auth.codeVerifier).digest("base64url")
    );
    expect(auth.expiresAt.toISOString()).toBe("2026-09-01T10:05:00.000Z");
  });

  it("uses the v3 token endpoint and returns only normalized identity", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            access_token: "user-access-token-must-not-escape",
            expires_in: 7200,
            token_type: "Bearer"
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            data: {
              name: "测试用户",
              avatar_url: "https://example.invalid/avatar.png",
              open_id: "ou_test",
              union_id: "on_test",
              tenant_key: "tenant_test"
            }
          }),
          { status: 200 }
        )
      );

    const identity = await exchangeCodeForIdentity(
      config,
      "authorization-code-1234567890",
      "v".repeat(43),
      fetchImplementation
    );

    expect(identity).toEqual({
      name: "测试用户",
      avatarUrl: "https://example.invalid/avatar.png",
      openId: "ou_test",
      unionId: "on_test",
      tenantKey: "tenant_test"
    });
    expect(JSON.stringify(identity)).not.toContain("user-access-token");
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://accounts.feishu.cn/oauth/v3/token"
    );
    const tokenRequest = fetchImplementation.mock.calls[0]?.[1];
    expect(tokenRequest?.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded"
    });
    expect(String(tokenRequest?.body)).toContain("code_verifier=");
    expect(fetchImplementation.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: "Bearer user-access-token-must-not-escape",
      "content-type": "application/json; charset=utf-8"
    });
  });

  it("returns a bounded error without exposing provider details", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 20002,
          error: "invalid_client",
          error_description: "sensitive provider detail"
        }),
        { status: 400 }
      )
    );

    await expect(
      exchangeCodeForIdentity(
        config,
        "authorization-code-1234567890",
        "v".repeat(43),
        fetchImplementation
      )
    ).rejects.toThrow("FEISHU_TOKEN_EXCHANGE_FAILED");
  });
});
