import { describe, expect, it, vi } from "vitest";

import { createPairingHandlers } from "../pairings/route";
import { createCurrentPairingHandler } from "../pairings/current/route";
import { createDevicePairHandler } from "./pair/route";
import { createNextTaskHandler } from "./tasks/next/route";
import { createDeviceTaskStatusHandler } from "./tasks/[taskId]/route";

describe("Mac device API", () => {
  const scope = { userId: "User_1", workspaceId: "Workspace_1" };

  it("creates a pairing and stores the browser secret only in an HttpOnly cookie", async () => {
    const createPairing = vi.fn().mockResolvedValue({
        pairingId: "Pairing_1",
        code: "A1B2C3D4",
        browserToken: `browser_token:${"a".repeat(64)}`,
        expiresAt: "2026-08-06T04:10:00.000Z"
      });
    const handlers = createPairingHandlers(
      { createPairing },
      vi.fn().mockResolvedValue(scope)
    );
    const response = await handlers.POST(
      new Request("https://auto-ux.example/api/pairings", { method: "POST" })
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      pairingId: "Pairing_1",
      code: "A1B2C3D4",
      expiresAt: "2026-08-06T04:10:00.000Z"
    });
    expect(response.headers.get("set-cookie")).toContain(
      `paired_browser=browser_token:${"a".repeat(64)}`
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(createPairing).toHaveBeenCalledWith(scope);
  });

  it("reads the current pairing from the browser cookie", async () => {
    const getBrowserPairing = vi.fn().mockResolvedValue({
      pairingId: "Pairing_1",
      status: "paired",
      agentId: "MacAgent_1",
      version: "0.1.0",
      online: true,
      lastSeenAt: "2026-08-06T04:00:00.000Z"
    });
    const handler = createCurrentPairingHandler(
      { getBrowserPairing },
      vi.fn().mockResolvedValue(scope)
    );
    const response = await handler(
      new Request("https://auto-ux.example/api/pairings/current", {
        headers: { cookie: `paired_browser=browser_token:${"b".repeat(64)}` }
      })
    );

    expect(response.status).toBe(200);
    expect(getBrowserPairing).toHaveBeenCalledWith(
      `browser_token:${"b".repeat(64)}`,
      scope
    );
    expect((await response.json()).status).toBe("paired");
  });

  it("requires a signed-in user before creating a pairing", async () => {
    const createPairing = vi.fn();
    const handlers = createPairingHandlers(
      { createPairing },
      vi.fn().mockResolvedValue(null)
    );
    const response = await handlers.POST(
      new Request("https://auto-ux.example/api/pairings", { method: "POST" })
    );

    expect(response.status).toBe(401);
    expect(createPairing).not.toHaveBeenCalled();
  });

  it("lets the Mac claim a one-time code", async () => {
    const claimPairing = vi.fn().mockResolvedValue({
      pairingId: "Pairing_1",
      deviceToken: `device_token:${"c".repeat(64)}`,
      agentId: "MacAgent_1"
    });
    const handler = createDevicePairHandler({ claimPairing });
    const response = await handler(
      new Request("https://auto-ux.example/api/devices/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "A1B2C3D4",
          agentId: "MacAgent_1",
          version: "0.1.0"
        })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deviceToken: `device_token:${"c".repeat(64)}`
    });
  });

  it("returns 204 while an authenticated Mac has no queued task", async () => {
    const claimNextTask = vi.fn().mockResolvedValue(null);
    const handler = createNextTaskHandler({ claimNextTask });
    const response = await handler(
      new Request("https://auto-ux.example/api/devices/tasks/next", {
        headers: {
          authorization: `Bearer device_token:${"d".repeat(64)}`,
          "x-auto-ux-agent-version": "0.4.3"
        }
      })
    );

    expect(response.status).toBe(204);
    expect(claimNextTask).toHaveBeenCalledWith(
      `device_token:${"d".repeat(64)}`,
      "0.4.3"
    );
  });

  it("rejects device polling without a device bearer token", async () => {
    const handler = createNextTaskHandler({ claimNextTask: vi.fn() });
    const response = await handler(
      new Request("https://auto-ux.example/api/devices/tasks/next")
    );
    expect(response.status).toBe(401);
  });

  it("records that Codex was opened and the prompt was sent", async () => {
    const updateTask = vi.fn().mockResolvedValue({
      id: "Task_1",
      status: "prompt_sent",
      errorCode: null
    });
    const handler = createDeviceTaskStatusHandler({ updateTask });
    const response = await handler(
      new Request("https://auto-ux.example/api/devices/tasks/Task_1", {
        method: "POST",
        headers: {
          authorization: `Bearer device_token:${"d".repeat(64)}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          claimToken: `task_claim:${"e".repeat(64)}`,
          status: "prompt_sent"
        })
      }),
      { params: Promise.resolve({ taskId: "Task_1" }) }
    );

    expect(response.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(
      `device_token:${"d".repeat(64)}`,
      "Task_1",
      {
        claimToken: `task_claim:${"e".repeat(64)}`,
        status: "prompt_sent"
      }
    );
  });

  it("records that the helper is waiting for Accessibility approval", async () => {
    const updateTask = vi.fn().mockResolvedValue({
      id: "Task_1",
      status: "waiting_permission",
      errorCode: "MAC_ACCESSIBILITY_REQUIRED"
    });
    const handler = createDeviceTaskStatusHandler({ updateTask });
    const response = await handler(
      new Request("https://auto-ux.example/api/devices/tasks/Task_1", {
        method: "POST",
        headers: {
          authorization: `Bearer device_token:${"d".repeat(64)}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          claimToken: `task_claim:${"e".repeat(64)}`,
          status: "waiting_permission",
          errorCode: "MAC_ACCESSIBILITY_REQUIRED"
        })
      }),
      { params: Promise.resolve({ taskId: "Task_1" }) }
    );
    expect(response.status).toBe(200);
  });
});
