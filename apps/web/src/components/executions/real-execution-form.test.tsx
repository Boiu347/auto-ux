import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealExecutionForm } from "./real-execution-form";

afterEach(() => vi.unstubAllGlobals());

describe("RealExecutionForm", () => {
  it("bootstraps the session, creates once, then launches Codex", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      if (url === "/api/dev/session") return new Response(null, { status: 204 });
      if (url === "/api/executions") {
        return Response.json({
          execution: { id: "EX-REAL", mode: "real_codex" },
          agentToken: `execution_token:${"a".repeat(64)}`,
          tokenExpiresAt: "2026-08-07T00:00:00.000Z"
        }, { status: 201 });
      }
      return Response.json({ opened: true, pasted: true, fallback: "none" });
    }));

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
    fireEvent.click(screen.getByRole("button", { name: "一键配置并打开 Codex" }));

    await screen.findByText("任务已交给 Codex");
    expect(calls.map(({ url }) => url)).toEqual([
      "/api/dev/session",
      "/api/executions",
      "/api/local/launch"
    ]);
    expect(screen.getByRole("link", { name: "查看任务页面" })).toHaveAttribute(
      "href",
      "/executions/EX-REAL"
    );
  });

  it("preserves the execution and retries only launch", async () => {
    let launchAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/dev/session") return new Response(null, { status: 204 });
      if (url === "/api/executions") {
        return Response.json({
          execution: { id: "EX-REAL", mode: "real_codex" },
          agentToken: `execution_token:${"a".repeat(64)}`
        }, { status: 201 });
      }
      launchAttempts += 1;
      return launchAttempts === 1
        ? Response.json({ code: "OPEN_FAILED" }, { status: 500 })
        : Response.json({ opened: true, pasted: false, fallback: "manual_paste" });
    });
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
      target: { value: "配置机器人" }
    });
    fireEvent.change(screen.getByLabelText(/本地号码文件路径/), {
      target: { value: "/Users/demo/phones.xlsx" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一键配置并打开 Codex" }));
    await screen.findByRole("button", { name: "重试打开 Codex" });
    fireEvent.click(screen.getByRole("button", { name: "重试打开 Codex" }));
    await screen.findByText(/已复制到剪贴板/);

    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/executions")).toHaveLength(1);
    expect(launchAttempts).toBe(2);
  });

  it("validates fields before sending requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RealExecutionForm
        bootstrap={{ userId: "U-1", workspaceId: "W-1" }}
        apiBaseUrl="http://localhost:3000"
        localLaunchEnabled
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "一键配置并打开 Codex" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("copies a standalone Skill prompt when deployed without the Mac launcher", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
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
    fireEvent.click(screen.getByRole("button", { name: "复制任务提示词" }));

    await screen.findByText(/提示词已复制/);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("独立模式"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
