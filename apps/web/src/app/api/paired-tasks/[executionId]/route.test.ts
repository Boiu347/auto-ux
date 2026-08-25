import { describe, expect, it, vi } from "vitest";
import { createPairedTaskStatusHandlers } from "./route";

describe("paired task status API", () => {
  it("returns only delivery metadata for the paired browser", async () => {
    const handlers = createPairedTaskStatusHandlers({
      authenticate: vi.fn().mockResolvedValue({ userId: "U-1", workspaceId: "W-1" }),
      find: vi.fn().mockResolvedValue({
        status: "failed",
        errorCode: "CODEX_SEND_FAILED",
        updatedAt: new Date("2026-08-06T04:00:00Z"),
        attempt: 1,
        executionLockAgentId: null
      }),
      retry: vi.fn(),
      now: () => new Date("2026-08-06T04:00:30Z")
    });
    const response = await handlers.GET(new Request("https://site/api/paired-tasks/EX-1"), {
      params: Promise.resolve({ executionId: "EX-1" })
    });
    expect(await response.json()).toEqual({
      status: "failed",
      errorCode: "CODEX_SEND_FAILED",
      updatedAt: "2026-08-06T04:00:00.000Z",
      retryable: false
    });
  });

  it("keeps a successful keystroke delivery pending until Codex claims the execution", async () => {
    const handlers = createPairedTaskStatusHandlers({
      authenticate: vi.fn().mockResolvedValue({ userId: "U-1", workspaceId: "W-1" }),
      find: vi.fn().mockResolvedValue({
        status: "prompt_sent",
        errorCode: null,
        updatedAt: new Date("2026-08-06T04:00:00Z"),
        attempt: 1,
        executionLockAgentId: null
      }),
      retry: vi.fn(),
      now: () => new Date("2026-08-06T04:00:30Z")
    });

    const response = await handlers.GET(new Request("https://site/api/paired-tasks/EX-1"), {
      params: Promise.resolve({ executionId: "EX-1" })
    });

    expect(await response.json()).toMatchObject({
      status: "prompt_sent",
      errorCode: null,
      retryable: false
    });
  });

  it("reports success only after Codex claims the execution", async () => {
    const handlers = createPairedTaskStatusHandlers({
      authenticate: vi.fn().mockResolvedValue({ userId: "U-1", workspaceId: "W-1" }),
      find: vi.fn().mockResolvedValue({
        status: "prompt_sent",
        errorCode: null,
        updatedAt: new Date("2026-08-06T04:00:00Z"),
        attempt: 1,
        executionLockAgentId: "MacCodex"
      }),
      retry: vi.fn(),
      now: () => new Date("2026-08-06T04:02:00Z")
    });

    const response = await handlers.GET(new Request("https://site/api/paired-tasks/EX-1"), {
      params: Promise.resolve({ executionId: "EX-1" })
    });

    expect(await response.json()).toMatchObject({
      status: "agent_started",
      errorCode: null,
      retryable: false
    });
  });

  it("times out an unacknowledged prompt and allows one explicit retry", async () => {
    const task = {
      status: "prompt_sent",
      errorCode: null,
      updatedAt: new Date("2026-08-06T04:00:00Z"),
      attempt: 1,
      executionLockAgentId: null
    };
    const retry = vi.fn().mockResolvedValue({ ...task, status: "queued", updatedAt: new Date("2026-08-06T04:01:01Z") });
    const handlers = createPairedTaskStatusHandlers({
      authenticate: vi.fn().mockResolvedValue({ userId: "U-1", workspaceId: "W-1" }),
      find: vi.fn().mockResolvedValue(task),
      retry,
      now: () => new Date("2026-08-06T04:01:01Z")
    });

    const statusResponse = await handlers.GET(new Request("https://site/api/paired-tasks/EX-1"), {
      params: Promise.resolve({ executionId: "EX-1" })
    });
    expect(await statusResponse.json()).toMatchObject({
      status: "ack_timeout",
      errorCode: "CODEX_ACK_TIMEOUT",
      retryable: true
    });

    const retryResponse = await handlers.POST(new Request("https://site/api/paired-tasks/EX-1", {
      method: "POST"
    }), { params: Promise.resolve({ executionId: "EX-1" }) });
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({ status: "queued", retryable: false });
    expect(retry).toHaveBeenCalledWith(
      { userId: "U-1", workspaceId: "W-1" },
      "EX-1",
      new Date("2026-08-06T04:00:01.000Z")
    );
  });

  it("does not offer a third delivery attempt", async () => {
    const handlers = createPairedTaskStatusHandlers({
      authenticate: vi.fn().mockResolvedValue({ userId: "U-1", workspaceId: "W-1" }),
      find: vi.fn().mockResolvedValue({
        status: "prompt_sent",
        errorCode: null,
        updatedAt: new Date("2026-08-06T04:00:00Z"),
        attempt: 2,
        executionLockAgentId: null
      }),
      retry: vi.fn(),
      now: () => new Date("2026-08-06T04:02:00Z")
    });

    const response = await handlers.GET(new Request("https://site/api/paired-tasks/EX-1"), {
      params: Promise.resolve({ executionId: "EX-1" })
    });
    expect(await response.json()).toMatchObject({
      status: "ack_timeout",
      errorCode: "CODEX_ACK_TIMEOUT",
      retryable: false
    });
  });
});
