import { describe, expect, it, vi } from "vitest";
import { createDecisionHandlers } from "./route";

const context = { params: Promise.resolve({ executionId: "EX-1" }) };

describe("execution confirmation decisions", () => {
  it("accepts the first website decision for the active gate", async () => {
    const decide = vi.fn().mockResolvedValue({
      action: "publish", decision: "approved", source: "website"
    });
    const handlers = createDecisionHandlers({
      authenticateBrowser: vi.fn().mockResolvedValue({ userId: "U-1", workspaceId: "W-1" }),
      authenticateAgent: vi.fn(), decide, get: vi.fn()
    });
    const response = await handlers.POST(new Request("https://site/api/executions/EX-1/decision", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "publish", decision: "approved" })
    }), context);
    expect(response.status).toBe(200);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ source: "website" }));
  });

  it("lets Codex poll the same decision with its execution bearer", async () => {
    const get = vi.fn().mockResolvedValue({ action: "start_dial", decision: "rejected", source: "website" });
    const handlers = createDecisionHandlers({
      authenticateBrowser: vi.fn(),
      authenticateAgent: vi.fn().mockResolvedValue({ userId: "U-1", workspaceId: "W-1" }),
      decide: vi.fn(), get
    });
    const response = await handlers.GET(new Request(
      "https://site/api/executions/EX-1/decision?action=start_dial",
      { headers: { authorization: `Bearer execution_token:${"a".repeat(64)}` } }
    ), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ decision: "rejected" });
  });
});
