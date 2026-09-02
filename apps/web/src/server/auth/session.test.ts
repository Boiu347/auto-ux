import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authSessionCookie,
  createAuthSessionToken,
  createOAuthStateToken,
  oauthStateCookie,
  readAuthSession,
  readOAuthState
} from "./session";

const secret = "session-secret-that-is-at-least-32-characters";
const now = new Date("2026-09-01T10:00:00.000Z");
const user = {
  userId: "User_1",
  workspaceId: "Workspace_1",
  name: "测试用户",
  avatarUrl: null
};

describe("Feishu site session", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a signed unexpired session and rejects tampering", () => {
    const token = createAuthSessionToken(user, secret, now, 60);
    const request = new Request("https://auto-ux.example/", {
      headers: { cookie: `auto_ux_session=${token}` }
    });

    expect(readAuthSession(request, secret, now)).toEqual(user);
    const tampered = new Request("https://auto-ux.example/", {
      headers: { cookie: `auto_ux_session=${token.slice(0, -1)}x` }
    });
    expect(readAuthSession(tampered, secret, now)).toBeNull();
  });

  it("rejects an expired session", () => {
    const token = createAuthSessionToken(user, secret, now, 1);
    const request = new Request("https://auto-ux.example/", {
      headers: { cookie: `auto_ux_session=${token}` }
    });
    expect(
      readAuthSession(request, secret, new Date(now.getTime() + 1_001))
    ).toBeNull();
  });

  it("signs the PKCE verifier into a short-lived HttpOnly state cookie", () => {
    const state = "s".repeat(43);
    const codeVerifier = "v".repeat(43);
    const expiresAt = now.getTime() + 300_000;
    const token = createOAuthStateToken(
      { version: 1, state, codeVerifier, expiresAt },
      secret
    );
    const request = new Request("https://auto-ux.example/", {
      headers: { cookie: `auto_ux_oauth_state=${token}` }
    });

    expect(readOAuthState(request, secret, now)).toEqual({
      version: 1,
      state,
      codeVerifier,
      expiresAt
    });
    expect(readOAuthState(request, secret, new Date(expiresAt))).toBeNull();
  });

  it("scopes secure cookies to the configured application path", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/auto-ux");
    expect(authSessionCookie("signed", true)).toContain("Path=/auto-ux/");
    expect(authSessionCookie("signed", true)).toContain("Secure");
    expect(authSessionCookie("signed", true)).toContain("HttpOnly");
    expect(oauthStateCookie("signed", true)).toContain(
      "Path=/auto-ux/api/auth/feishu"
    );
  });
});
