import { describe, expect, it, vi } from "vitest";

import type { TaskWorkspaceService } from "../../../server/task-workspace/service";
import { createTaskWorkspaceHandlers } from "./route";

const scope = { userId: "User_1", workspaceId: "Workspace_1" };

function service(overrides: Partial<TaskWorkspaceService> = {}) {
  return {
    getWorkspace: vi.fn().mockResolvedValue({ draft: null, executions: [] }),
    saveDraft: vi.fn(),
    deleteDraft: vi.fn(),
    ...overrides
  } as unknown as TaskWorkspaceService;
}

describe("task workspace API", () => {
  it("returns only the authenticated account workspace", async () => {
    const taskService = service();
    const handlers = createTaskWorkspaceHandlers(
      taskService,
      vi.fn().mockResolvedValue(scope)
    );

    const response = await handlers.GET(
      new Request("https://auto-ux.example/api/task-workspace")
    );

    expect(response.status).toBe(200);
    expect(taskService.getWorkspace).toHaveBeenCalledWith(scope);
    expect(await response.json()).toEqual({ draft: null, executions: [] });
  });

  it("saves a validated cross-device draft in the same scope", async () => {
    const input = {
      feishuUrls: ["https://guanghe.feishu.cn/docx/ABC"],
      requirements: "创建机器人",
      phoneFilePath: "/Users/demo/phones.xlsx",
      robotName: "九月回访"
    };
    const taskService = service({
      saveDraft: vi.fn().mockResolvedValue({
        ...input,
        updatedAt: "2026-09-01T10:00:00.000Z"
      })
    });
    const handlers = createTaskWorkspaceHandlers(
      taskService,
      vi.fn().mockResolvedValue(scope)
    );

    const response = await handlers.PUT(
      new Request("https://auto-ux.example/api/task-workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })
    );

    expect(response.status).toBe(200);
    expect(taskService.saveDraft).toHaveBeenCalledWith(scope, input);
  });

  it("rejects invalid draft paths without writing", async () => {
    const taskService = service();
    const handlers = createTaskWorkspaceHandlers(
      taskService,
      vi.fn().mockResolvedValue(scope)
    );
    const response = await handlers.PUT(
      new Request("https://auto-ux.example/api/task-workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feishuUrls: [],
          requirements: "",
          phoneFilePath: "relative.xlsx",
          robotName: ""
        })
      })
    );

    expect(response.status).toBe(400);
    expect(taskService.saveDraft).not.toHaveBeenCalled();
  });

  it("does not expose history without authentication", async () => {
    const taskService = service();
    const handlers = createTaskWorkspaceHandlers(
      taskService,
      vi.fn().mockResolvedValue(null)
    );
    const response = await handlers.GET(
      new Request("https://auto-ux.example/api/task-workspace")
    );

    expect(response.status).toBe(401);
    expect(taskService.getWorkspace).not.toHaveBeenCalled();
  });
});
