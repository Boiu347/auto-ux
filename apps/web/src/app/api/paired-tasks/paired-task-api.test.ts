import { afterEach, describe, expect, it, vi } from "vitest";

import { createPairedTaskHandler } from "./route";

describe("paired task API", () => {
  const authenticatedUser = {
    userId: "User_1",
    workspaceId: "Workspace_1"
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates a real execution and queues its bounded Codex prompt", async () => {
    vi.stubEnv("AUTO_UX_PUBLIC_BASE_URL", "https://auto-ux.example/auto-ux/");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/auto-ux");
    const getBrowserScope = vi.fn().mockResolvedValue({
      pairingId: "Pairing_1",
      userId: "User_1",
      workspaceId: "Workspace_1",
      agentId: "MacAgent_1"
    });
    const createExecution = vi.fn().mockResolvedValue({
      execution: { id: "Execution_1" },
      agentToken: `execution_token:${"a".repeat(64)}`
    });
    const enqueueTask = vi.fn().mockResolvedValue({
      id: "Task_1",
      status: "queued"
    });
    const handler = createPairedTaskHandler({
      getRequestUser: vi.fn().mockResolvedValue(authenticatedUser),
      getBrowserScope,
      createExecution,
      enqueueTask
    });
    const response = await handler(
      new Request("http://0.0.0.0:8080/auto-ux/api/paired-tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `paired_browser=browser_token:${"b".repeat(64)}`
        },
        body: JSON.stringify({
          requestId: "request_1234567890abcdef",
          feishuUrls: ["https://guanghe.feishu.cn/docx/ABC123"],
          requirements: "创建一个新的回访机器人",
          phoneFilePath: "/Users/demo/phones.xlsx",
          robotName: "八月回访"
        })
      })
    );

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload).toEqual({
      executionId: "Execution_1",
      taskId: "Task_1",
      status: "queued"
    });
    expect(createExecution).toHaveBeenCalledWith(
      { userId: "User_1", workspaceId: "Workspace_1" },
      expect.objectContaining({ mode: "real_codex", configVersion: 1 })
    );
    expect(getBrowserScope).toHaveBeenCalledWith(
      `browser_token:${"b".repeat(64)}`,
      authenticatedUser
    );
    expect(enqueueTask).toHaveBeenCalledWith(
      `browser_token:${"b".repeat(64)}`,
      expect.objectContaining({
        executionId: "Execution_1",
        feishuUrls: ["https://guanghe.feishu.cn/docx/ABC123"],
        requirements: "创建一个新的回访机器人",
        phoneFilePath: "/Users/demo/phones.xlsx",
        robotName: "八月回访",
        prompt: expect.stringContaining("$baidu-cloud-one-click-config")
      })
    );
    const queuedPrompt = enqueueTask.mock.calls[0]?.[1]?.prompt as string;
    expect(queuedPrompt).toContain(
      "apiBaseUrl: https://auto-ux.example/auto-ux"
    );
    expect(queuedPrompt).not.toContain("0.0.0.0:8080");
    expect(queuedPrompt).toContain("__AUTO_UX_EXECUTION_TOKEN__");
    expect(queuedPrompt).not.toContain("execution_token:");
    expect(JSON.stringify(payload)).not.toContain("execution_token:");
  });

  it("rejects an unpaired browser", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createPairedTaskHandler({
      getRequestUser: vi.fn().mockResolvedValue(null),
      getBrowserScope: vi.fn(),
      createExecution: vi.fn(),
      enqueueTask: vi.fn()
    });
    const response = await handler(
      new Request("https://auto-ux.example/api/paired-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    );
    expect(response.status).toBe(401);
  });

  it("rejects a pairing owned by another signed-in account", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("AUTO_UX_PUBLIC_BASE_URL", "https://auto-ux.example");
    const createExecution = vi.fn();
    const handler = createPairedTaskHandler({
      getRequestUser: vi.fn().mockResolvedValue(authenticatedUser),
      getBrowserScope: vi.fn().mockRejectedValue(new Error("UNAUTHENTICATED")),
      createExecution,
      enqueueTask: vi.fn()
    });
    const response = await handler(
      new Request("https://auto-ux.example/api/paired-tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `paired_browser=browser_token:${"b".repeat(64)}`
        },
        body: JSON.stringify({
          requestId: "request_1234567890abcdef",
          feishuUrls: ["https://guanghe.feishu.cn/docx/ABC123"],
          requirements: "创建机器人",
          phoneFilePath: "/Users/demo/phones.xlsx"
        })
      })
    );

    expect(response.status).toBe(401);
    expect(createExecution).not.toHaveBeenCalled();
  });

  it("rejects a bind-only API base URL before creating an execution", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const createExecution = vi.fn();
    const handler = createPairedTaskHandler({
      getRequestUser: vi.fn().mockResolvedValue(authenticatedUser),
      getBrowserScope: vi.fn().mockResolvedValue({
        pairingId: "Pairing_1",
        userId: "User_1",
        workspaceId: "Workspace_1",
        agentId: "MacAgent_1"
      }),
      createExecution,
      enqueueTask: vi.fn()
    });
    const response = await handler(
      new Request("http://0.0.0.0:8080/auto-ux/api/paired-tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `paired_browser=browser_token:${"b".repeat(64)}`
        },
        body: JSON.stringify({
          requestId: "request_1234567890abcdef",
          feishuUrls: ["https://guanghe.feishu.cn/docx/ABC123"],
          requirements: "创建一个新的回访机器人",
          phoneFilePath: "/Users/demo/phones.xlsx"
        })
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "AUTO_UX_PUBLIC_BASE_URL_INVALID",
      diagnosticId: expect.stringMatching(/^diag_[a-f0-9]{32}$/)
    });
    expect(createExecution).not.toHaveBeenCalled();
  });

  it("rejects a configured public URL that omits the public base path", async () => {
    vi.stubEnv("AUTO_UX_PUBLIC_BASE_URL", "https://auto-ux.example");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/auto-ux");
    const createExecution = vi.fn();
    const handler = createPairedTaskHandler({
      getRequestUser: vi.fn().mockResolvedValue(authenticatedUser),
      getBrowserScope: vi.fn(),
      createExecution,
      enqueueTask: vi.fn()
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handler(
      new Request("http://0.0.0.0:8080/auto-ux/api/paired-tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `paired_browser=browser_token:${"b".repeat(64)}`
        },
        body: JSON.stringify({
          requestId: "request_1234567890abcdef",
          feishuUrls: ["https://guanghe.feishu.cn/docx/ABC123"],
          requirements: "创建一个新的回访机器人",
          phoneFilePath: "/Users/demo/phones.xlsx"
        })
      })
    );

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({
      code: "AUTO_UX_PUBLIC_BASE_URL_INVALID",
      diagnosticId: expect.stringMatching(/^diag_[a-f0-9]{32}$/)
    });
    expect(consoleError).toHaveBeenCalledWith("paired_task_failed", {
      causeCode: null,
      code: "AUTO_UX_PUBLIC_BASE_URL_INVALID",
      diagnosticId: payload.diagnosticId,
      errorName: "Error",
      executionId: null,
      requestId: "request_1234567890abcdef"
    });
    expect(createExecution).not.toHaveBeenCalled();
  });

  it("sanitizes unknown failures while logging a safe cause code", async () => {
    vi.stubEnv("AUTO_UX_PUBLIC_BASE_URL", "https://auto-ux.example/auto-ux");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/auto-ux");
    const databaseError = Object.assign(new Error("connection details must stay private"), {
      code: "P1001"
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createPairedTaskHandler({
      getRequestUser: vi.fn().mockResolvedValue(authenticatedUser),
      getBrowserScope: vi.fn().mockRejectedValue(databaseError),
      createExecution: vi.fn(),
      enqueueTask: vi.fn()
    });
    const response = await handler(
      new Request("https://auto-ux.example/auto-ux/api/paired-tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `paired_browser=browser_token:${"b".repeat(64)}`
        },
        body: JSON.stringify({
          requestId: "request_1234567890abcdef",
          feishuUrls: ["https://guanghe.feishu.cn/docx/ABC123"],
          requirements: "创建机器人",
          phoneFilePath: "/Users/demo/phones.xlsx"
        })
      })
    );

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({
      code: "INTERNAL_ERROR",
      diagnosticId: expect.stringMatching(/^diag_[a-f0-9]{32}$/)
    });
    expect(JSON.stringify(payload)).not.toContain("connection details");
    expect(consoleError).toHaveBeenCalledWith("paired_task_failed", {
      causeCode: "P1001",
      code: "INTERNAL_ERROR",
      diagnosticId: payload.diagnosticId,
      errorName: "Error",
      executionId: null,
      requestId: "request_1234567890abcdef"
    });
  });
});
