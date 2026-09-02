import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealExecutionForm } from "./real-execution-form";

afterEach(() => vi.unstubAllGlobals());

describe("RealExecutionForm", () => {
  it("does not use the legacy local launcher when the Mac is unpaired", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RealExecutionForm
        bootstrap={{ userId: "U-1", workspaceId: "W-1" }}
        apiBaseUrl="http://localhost:3000"
        localLaunchEnabled
      />
    );
    fireEvent.change(screen.getByLabelText(/飞书文档链接/), {
      target: { value: "https://guanghe.feishu.cn/docx/ABC" }
    });
    fireEvent.change(screen.getByLabelText(/补充需求/), {
      target: { value: "创建机器人并配置字段" }
    });
    fireEvent.change(screen.getByLabelText(/本地号码文件路径/), {
      target: { value: "/Users/demo/Desktop/phones.xlsx" }
    });
    expect(screen.getByRole("button", { name: "请先配对 Mac 助手" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables resubmission after a paired task is queued", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      executionId: "EX-REAL",
      taskId: "Task_1",
      status: "queued"
    }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RealExecutionForm localLaunchEnabled={false} pairedDeviceReady />);
    fireEvent.change(screen.getByLabelText(/飞书文档链接/), {
      target: { value: "https://guanghe.feishu.cn/docx/ABC" }
    });
    fireEvent.change(screen.getByLabelText(/补充需求/), {
      target: { value: "配置机器人" }
    });
    fireEvent.change(screen.getByLabelText(/本地号码文件路径/), {
      target: { value: "/Users/demo/phones.xlsx" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一键发送到 Mac Codex" }));

    expect(await screen.findByRole("button", { name: "任务已发送" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/task-workspace",
      { method: "DELETE" }
    );
  });

  it("validates fields before sending requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RealExecutionForm
        bootstrap={{ userId: "U-1", workspaceId: "W-1" }}
        apiBaseUrl="http://localhost:3000"
        localLaunchEnabled
        pairedDeviceReady
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "一键发送到 Mac Codex" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires one-time Mac pairing instead of copying a prompt", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RealExecutionForm apiBaseUrl="https://auto-ux.example" localLaunchEnabled={false} />
    );
    fireEvent.change(screen.getByLabelText(/飞书文档链接/), {
      target: { value: "https://guanghe.feishu.cn/docx/ABC" }
    });
    fireEvent.change(screen.getByLabelText(/补充需求/), {
      target: { value: "配置机器人" }
    });
    fireEvent.change(screen.getByLabelText(/本地号码文件路径/), {
      target: { value: "/Users/demo/phones.xlsx" }
    });
    expect(screen.getByRole("button", { name: "请先配对 Mac 助手" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queues a paired Railway task instead of copying a prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      executionId: "EX-PAIRED",
      taskId: "Task_1",
      status: "queued"
    }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RealExecutionForm
        apiBaseUrl="https://auto-ux.example"
        localLaunchEnabled={false}
        pairedDeviceReady
      />
    );
    fireEvent.change(screen.getByLabelText(/飞书文档链接/), {
      target: { value: "https://guanghe.feishu.cn/docx/ABC" }
    });
    fireEvent.change(screen.getByLabelText(/补充需求/), {
      target: { value: "配置机器人" }
    });
    fireEvent.change(screen.getByLabelText(/本地号码文件路径/), {
      target: { value: "/Users/demo/phones.xlsx" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一键发送到 Mac Codex" }));

    await screen.findByText("任务已进入 Mac 队列");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/paired-tasks",
      expect.objectContaining({ method: "POST" })
    );
    expect(screen.getByRole("link", { name: "查看任务页面" })).toHaveAttribute(
      "href",
      "/executions/EX-PAIRED"
    );
  });

  it("shows the paired-task diagnostic code returned by the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      code: "AUTO_UX_PUBLIC_BASE_URL_INVALID",
      diagnosticId: "diag_1234567890abcdef"
    }, { status: 500 })));
    render(
      <RealExecutionForm
        apiBaseUrl="https://auto-ux.example"
        localLaunchEnabled={false}
        pairedDeviceReady
      />
    );
    fireEvent.change(screen.getByLabelText(/飞书文档链接/), {
      target: { value: "https://guanghe.feishu.cn/docx/ABC" }
    });
    fireEvent.change(screen.getByLabelText(/补充需求/), {
      target: { value: "配置机器人" }
    });
    fireEvent.change(screen.getByLabelText(/本地号码文件路径/), {
      target: { value: "/Users/demo/phones.xlsx" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一键发送到 Mac Codex" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务端公开地址配置无效，请联系管理员检查部署配置。"
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "诊断码：AUTO_UX_PUBLIC_BASE_URL_INVALID；追踪号：diag_1234567890abcdef"
    );
  });

  it("restores a server draft for the same paired account", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <RealExecutionForm
        localLaunchEnabled={false}
        pairedDeviceReady
        workspaceLoaded
        initialDraft={{
          feishuUrls: ["https://guanghe.feishu.cn/docx/RESTORED"],
          requirements: "恢复后的补充需求",
          phoneFilePath: "/Users/demo/restored.xlsx",
          robotName: "恢复任务",
          updatedAt: "2026-09-01T10:00:00.000Z"
        }}
      />
    );

    expect(await screen.findByDisplayValue(/RESTORED/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("恢复后的补充需求")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/Users/demo/restored.xlsx")).toBeInTheDocument();
    expect(screen.getByDisplayValue("恢复任务")).toBeInTheDocument();
    expect(screen.getByText("草稿已跨设备保存")).toBeInTheDocument();
  });

  it("saves a cross-device draft while the paired Mac is offline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ draft: {} }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RealExecutionForm
        localLaunchEnabled={false}
        pairedDeviceReady={false}
        workspaceLoaded
      />
    );

    fireEvent.change(screen.getByLabelText(/补充需求/), {
      target: { value: "离线时也保存" }
    });
    await vi.advanceTimersByTimeAsync(600);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/task-workspace",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("离线时也保存")
      })
    );
    vi.useRealTimers();
  });
});
