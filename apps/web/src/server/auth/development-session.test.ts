import { describe, expect, it } from "vitest";

import { createDevelopmentSessionHandlers } from "../../app/api/dev/session/route";
import { getCurrentUser } from "./current-user";

const secret = "test-secret-with-at-least-32-characters";

describe("development browser session", () => {
  it("issues an HttpOnly same-origin cookie that authenticates outside production", async () => {
    const response = await createDevelopmentSessionHandlers({
      environment: "test",
      secret
    }).POST(
      new Request("http://localhost/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
      })
    );

    expect(response.status).toBe(204);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("dev_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("U-1");

    const request = new Request("http://localhost/api/executions/EX-1", {
      headers: { cookie: setCookie!.split(";")[0]! }
    });
    expect(getCurrentUser(request, "test", secret)).toEqual({
      userId: "U-1",
      workspaceId: "W-1"
    });
  });

  it("rejects a tampered cookie and all development auth in production", async () => {
    const issued = await createDevelopmentSessionHandlers({
      environment: "test",
      secret
    }).POST(
      new Request("http://localhost/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
      })
    );
    const cookie = issued.headers.get("set-cookie")!.split(";")[0]!;
    const tampered = `${cookie.slice(0, -1)}x`;

    expect(
      getCurrentUser(
        new Request("http://localhost", { headers: { cookie: tampered } }),
        "test",
        secret
      )
    ).toBeNull();
    expect(
      getCurrentUser(
        new Request("http://localhost", { headers: { cookie } }),
        "production",
        secret
      )
    ).toBeNull();
    const production = await createDevelopmentSessionHandlers({
      environment: "production",
      secret
    }).POST(
      new Request("http://localhost/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
      })
    );
    expect(production.status).toBe(404);
  });

  it("refuses to issue a session without the required signing secret", async () => {
    const response = await createDevelopmentSessionHandlers({
      environment: "test",
      secret: undefined
    }).POST(
      new Request("http://localhost/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEV_SESSION_SECRET_REQUIRED"
    });
  });

  it("rejects a cross-origin browser bootstrap and secures HTTPS cookies", async () => {
    const handlers = createDevelopmentSessionHandlers({
      environment: "test",
      secret
    });
    const foreign = await handlers.POST(
      new Request("https://control.example/api/dev/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example"
        },
        body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
      })
    );
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual({
      code: "CROSS_ORIGIN_REQUEST"
    });

    const sameOrigin = await handlers.POST(
      new Request("https://control.example/api/dev/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://control.example"
        },
        body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
      })
    );
    expect(sameOrigin.status).toBe(204);
    expect(sameOrigin.headers.get("set-cookie")).toContain("Secure");
  });

  it("allows production-built local tests only with an explicit matching key", async () => {
    const localTestKey = "local-test-key-with-at-least-32-characters";
    const handlers = createDevelopmentSessionHandlers({
      environment: "production",
      secret,
      localTestKey
    });
    const denied = await handlers.POST(
      new Request("http://127.0.0.1/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
      })
    );
    expect(denied.status).toBe(404);

    const issued = await handlers.POST(
      new Request("http://127.0.0.1/api/dev/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auto-ux-local-key": localTestKey
        },
        body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
      })
    );
    expect(issued.status).toBe(204);
    const cookie = issued.headers.get("set-cookie")!.split(";")[0]!;

    expect(
      getCurrentUser(
        new Request("http://127.0.0.1/api/executions", {
          headers: { cookie }
        }),
        "production",
        secret,
        localTestKey
      )
    ).toEqual({ userId: "U-1", workspaceId: "W-1" });
    expect(
      getCurrentUser(
        new Request("http://127.0.0.1/api/executions", {
          headers: {
            "x-dev-user-id": "U-1",
            "x-dev-workspace-id": "W-1",
            "x-auto-ux-local-key": "wrong"
          }
        }),
        "production",
        secret,
        localTestKey
      )
    ).toBeNull();
  });
});
