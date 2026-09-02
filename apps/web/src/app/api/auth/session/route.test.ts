import { describe, expect, it, vi } from "vitest";

import { createAuthSessionHandlers } from "./route";

describe("auth session API", () => {
  it("returns only display profile fields and disables caching", async () => {
    const response = await createAuthSessionHandlers(
      vi.fn().mockReturnValue({
        userId: "User_1",
        workspaceId: "Workspace_1",
        name: "测试用户",
        avatarUrl: null
      }),
      () => true
    ).GET(new Request("https://auto-ux.example/api/auth/session"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      authenticated: true,
      managedByProxy: true,
      user: { name: "测试用户", avatarUrl: null }
    });
  });

  it("clears the HttpOnly session only for same-origin logout", async () => {
    const handlers = createAuthSessionHandlers(vi.fn());
    const rejected = await handlers.DELETE(
      new Request("https://auto-ux.example/api/auth/session", {
        method: "DELETE",
        headers: { origin: "https://attacker.example" }
      })
    );
    expect(rejected.status).toBe(403);

    const response = await handlers.DELETE(
      new Request("https://auto-ux.example/api/auth/session", {
        method: "DELETE",
        headers: { origin: "https://auto-ux.example" }
      })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});
