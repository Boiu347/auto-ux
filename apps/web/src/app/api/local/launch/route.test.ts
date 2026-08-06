import { describe, expect, it, vi } from "vitest";

import { createLocalLaunchHandler } from "./route";

const user = { userId: "U-1", workspaceId: "W-1" };
const prompt = "运行真实任务";

function localRequest(body: unknown = { prompt }, init?: RequestInit): Request {
  return new Request("http://localhost:3000/api/local/launch", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init
  });
}

describe("local Codex launch route", () => {
  it("launches for an authenticated local development session", async () => {
    const launch = vi.fn(async () => ({
      opened: true as const,
      pasted: true,
      fallback: "none" as const
    }));
    const POST = createLocalLaunchHandler({ launch }, {
      authenticate: () => user,
      nodeEnv: "development",
      enabled: true
    });
    const response = await POST(localRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      opened: true,
      pasted: true,
      fallback: "none"
    });
    expect(launch).toHaveBeenCalledWith(prompt);
  });

  it.each([
    ["UNAUTHENTICATED", { authenticate: () => null, nodeEnv: "development", enabled: true }],
    ["LOCAL_LAUNCH_DISABLED", { authenticate: () => user, nodeEnv: "production", enabled: true }],
    ["LOCAL_LAUNCH_DISABLED", { authenticate: () => user, nodeEnv: "development", enabled: false }]
  ] as const)("returns %s when unavailable", async (code, options) => {
    const POST = createLocalLaunchHandler({ launch: vi.fn() }, options);
    const response = await POST(localRequest());
    await expect(response.json()).resolves.toEqual({ code });
  });

  it("rejects non-loopback and cross-origin requests", async () => {
    const options = { authenticate: () => user, nodeEnv: "development", enabled: true } as const;
    const POST = createLocalLaunchHandler({ launch: vi.fn() }, options);
    const remote = await POST(
      new Request("https://example.com/api/local/launch", {
        method: "POST",
        headers: { origin: "https://example.com", "content-type": "application/json" },
        body: JSON.stringify({ prompt })
      })
    );
    expect(remote.status).toBe(403);
    const crossOrigin = await POST(localRequest(undefined, {
      headers: { origin: "http://evil.local", "content-type": "application/json" }
    }));
    expect(crossOrigin.status).toBe(403);
  });

  it("rejects invalid JSON and oversized prompts before launch", async () => {
    const launch = vi.fn();
    const POST = createLocalLaunchHandler({ launch }, {
      authenticate: () => user,
      nodeEnv: "development",
      enabled: true
    });
    const invalid = await POST(localRequest(undefined, { body: "{" }));
    expect(invalid.status).toBe(400);
    const oversized = await POST(localRequest({ prompt: "x".repeat(32_769) }));
    expect(oversized.status).toBe(400);
    expect(launch).not.toHaveBeenCalled();
  });

  it("returns the manual-paste fallback", async () => {
    const POST = createLocalLaunchHandler({
      launch: async () => ({ opened: true, pasted: false, fallback: "manual_paste" })
    }, {
      authenticate: () => user,
      nodeEnv: "development",
      enabled: true
    });
    await expect((await POST(localRequest())).json()).resolves.toMatchObject({
      fallback: "manual_paste"
    });
  });
});
