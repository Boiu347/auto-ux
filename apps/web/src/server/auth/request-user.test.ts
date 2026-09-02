import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./central-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./central-auth")>();
  return {
    ...actual,
    resolveCentralAuthIdentity: vi.fn().mockResolvedValue({
      userId: "User_legacy",
      workspaceId: "Workspace_legacy",
      name: "中央用户",
      avatarUrl: null
    })
  };
});

import { createAuthSessionToken } from "./session";
import { getRequestUser } from "./request-user";
import { resolveCentralAuthIdentity } from "./central-auth";

const secret = "session-secret-that-is-at-least-32-characters";

describe("request user authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a valid Feishu-backed site session", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", secret);
    const token = createAuthSessionToken(
      {
        userId: "User_1",
        workspaceId: "Workspace_1",
        name: "测试用户",
        avatarUrl: null
      },
      secret
    );
    const user = await getRequestUser(
      new Request("https://auto-ux.example/", {
        headers: { cookie: `auto_ux_session=${token}` }
      })
    );

    expect(user).toEqual({ userId: "User_1", workspaceId: "Workspace_1" });
  });

  it("never treats a paired-browser cookie as user authentication", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", secret);
    const user = await getRequestUser(
      new Request("https://auto-ux.example/", {
        headers: {
          cookie: `paired_browser=browser_token:${"a".repeat(64)}`
        }
      })
    );

    expect(user).toBeNull();
  });

  it("uses a legacy pairing token only after a valid central assertion", async () => {
    const authSecret = "central-auth-test-secret-at-least-32-characters";
    vi.stubEnv("AUTHZ_ASSERTION_SECRET", authSecret);
    vi.stubEnv("AUTHZ_PROJECT_ID", "auto-ux");
    const payload = Buffer.from(JSON.stringify({
      kind: "authz-assertion",
      aud: "wowdata-project.v1",
      project_id: "auto-ux",
      open_id: "ou_central",
      name: "中央用户",
      exp: 1_900_000_000
    })).toString("base64url");
    const { createHmac } = await import("node:crypto");
    const assertion = `${payload}.${createHmac("sha256", authSecret)
      .update(payload)
      .digest("hex")}`;
    const pairingToken = `browser_token:${"a".repeat(64)}`;

    const user = await getRequestUser(new Request("https://site/auto-ux/", {
      headers: {
        "x-wowdata-assertion": assertion,
        cookie: `paired_browser=${pairingToken}`
      }
    }));

    expect(user).toEqual({
      userId: "User_legacy",
      workspaceId: "Workspace_legacy"
    });
    expect(resolveCentralAuthIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ openId: "ou_central" }),
      pairingToken
    );
  });
});
