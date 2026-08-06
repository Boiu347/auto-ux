import { describe, expect, it, vi } from "vitest";
import { createPairedTaskStatusHandler } from "./route";

describe("paired task status API", () => {
  it("returns only delivery metadata for the paired browser", async () => {
    const handler = createPairedTaskStatusHandler({
      authenticate: vi.fn().mockResolvedValue({ userId: "U-1", workspaceId: "W-1" }),
      find: vi.fn().mockResolvedValue({ status: "failed", errorCode: "CODEX_SEND_FAILED", updatedAt: new Date("2026-08-06T04:00:00Z") })
    });
    const response = await handler(new Request("https://site/api/paired-tasks/EX-1"), {
      params: Promise.resolve({ executionId: "EX-1" })
    });
    expect(await response.json()).toEqual({
      status: "failed", errorCode: "CODEX_SEND_FAILED", updatedAt: "2026-08-06T04:00:00.000Z"
    });
  });
});
