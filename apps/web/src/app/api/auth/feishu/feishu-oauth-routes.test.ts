import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  FeishuAuthConfig,
  FeishuIdentity
} from "../../../../server/auth/feishu-auth";
import {
  createOAuthStateToken,
  oauthStateCookie
} from "../../../../server/auth/session";
import { createFeishuCallbackHandler } from "./callback/route";
import { createFeishuStartHandler } from "./start/route";

const config: FeishuAuthConfig = {
  appId: "cli_test123",
  appSecret: "app-secret",
  redirectUri: "https://auto-ux.example/auto-ux/api/auth/feishu/callback",
  sessionSecret: "session-secret-that-is-at-least-32-characters"
};
const now = new Date("2026-09-01T10:00:00.000Z");
const identity: FeishuIdentity = {
  name: "测试用户",
  avatarUrl: null,
  openId: "ou_test",
  unionId: "on_test",
  tenantKey: "tenant_test"
};

describe("Feishu OAuth routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stores only the state hash and redirects with a secure PKCE cookie", async () => {
    const createLoginState = vi.fn().mockResolvedValue(undefined);
    const handler = createFeishuStartHandler({
      config: () => config,
      store: { createLoginState },
      now: () => now,
      environment: "production"
    });

    const response = await handler(
      new Request("https://auto-ux.example/auto-ux/api/auth/feishu/start")
    );

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location")!);
    const state = target.searchParams.get("state")!;
    expect(target.origin + target.pathname).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
    );
    expect(createLoginState).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      new Date("2026-09-01T10:05:00.000Z")
    );
    expect(createLoginState.mock.calls[0]?.[0]).not.toBe(state);
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).not.toContain(config.appSecret);
  });

  it("consumes state once, creates a site session, and clears PKCE state", async () => {
    const state = "s".repeat(43);
    const codeVerifier = "v".repeat(43);
    const stateToken = createOAuthStateToken(
      {
        version: 1,
        state,
        codeVerifier,
        expiresAt: now.getTime() + 300_000
      },
      config.sessionSecret
    );
    const consumeLoginState = vi.fn().mockResolvedValue(true);
    const resolveIdentity = vi.fn().mockResolvedValue({
      userId: "User_1",
      workspaceId: "Workspace_1",
      name: "测试用户",
      avatarUrl: null
    });
    const exchangeIdentity = vi.fn().mockResolvedValue(identity);
    const handler = createFeishuCallbackHandler({
      config: () => config,
      store: { consumeLoginState, resolveIdentity },
      exchangeIdentity,
      now: () => now,
      environment: "production"
    });
    const response = await handler(
      new Request(
        `https://auto-ux.example/auto-ux/api/auth/feishu/callback?code=${"c".repeat(24)}&state=${state}`,
        {
          headers: {
            cookie: oauthStateCookie(stateToken, true)
              .split(";")[0]!
          }
        }
      )
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://auto-ux.example/?auth=success"
    );
    expect(exchangeIdentity).toHaveBeenCalledWith(
      config,
      "c".repeat(24),
      codeVerifier
    );
    expect(resolveIdentity).toHaveBeenCalledWith(identity);
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("auto_ux_session=");
    expect(cookies).toContain("auto_ux_oauth_state=");
    expect(cookies).toContain("Max-Age=0");
    expect(cookies).not.toContain("user-access-token");
  });

  it("rejects replayed state before exchanging the code", async () => {
    const state = "s".repeat(43);
    const stateToken = createOAuthStateToken(
      {
        version: 1,
        state,
        codeVerifier: "v".repeat(43),
        expiresAt: now.getTime() + 300_000
      },
      config.sessionSecret
    );
    const exchangeIdentity = vi.fn();
    const handler = createFeishuCallbackHandler({
      config: () => config,
      store: {
        consumeLoginState: vi.fn().mockResolvedValue(false),
        resolveIdentity: vi.fn()
      },
      exchangeIdentity,
      now: () => now,
      environment: "production"
    });
    const response = await handler(
      new Request(
        `https://auto-ux.example/api/auth/feishu/callback?code=${"c".repeat(24)}&state=${state}`,
        { headers: { cookie: `auto_ux_oauth_state=${stateToken}` } }
      )
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_OAUTH_STATE" });
    expect(exchangeIdentity).not.toHaveBeenCalled();
  });

  it("refuses production OAuth over plain HTTP", async () => {
    const response = await createFeishuStartHandler({
      config: () => config,
      store: { createLoginState: vi.fn() },
      now: () => now,
      environment: "production"
    })(new Request("http://auto-ux.example/api/auth/feishu/start"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "HTTPS_REQUIRED" });
  });

  it("refuses an HTTP callback configuration in production", async () => {
    const response = await createFeishuStartHandler({
      config: () => ({
        ...config,
        redirectUri: "http://auto-ux.example/api/auth/feishu/callback"
      }),
      store: { createLoginState: vi.fn() },
      now: () => now,
      environment: "production"
    })(new Request("https://auto-ux.example/api/auth/feishu/start"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "FEISHU_AUTH_NOT_CONFIGURED"
    });
  });
});
