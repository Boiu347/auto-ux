import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePage from "./page";

describe("home page", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the real Mac task form and execution list", () => {
    vi.stubEnv("AUTO_UX_LOCAL_CODEX_LAUNCH", "1");
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain("百度云外呼一键配置");
    expect(markup).toContain("正在读取历史记录");
    expect(markup).toContain("发起真实配置");
    expect(markup).toContain("飞书文档链接");
    expect(markup).toContain("本地号码文件路径");
    expect(markup).toContain("请先配对 Mac 助手");
  });

  it("presents task creation as the primary workspace with supporting guidance", () => {
    vi.stubEnv("AUTO_UX_LOCAL_CODEX_LAUNCH", "1");
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain('aria-label="发起配置工作区"');
    expect(markup).toContain('aria-label="主要任务"');
    expect(markup).toContain('aria-label="配置辅助信息"');
    expect(markup).toContain("01 整理资料");
    expect(markup).toContain("02 确认配置");
    expect(markup).toContain("03 本机执行");
  });

  it("never passes a local authentication secret into the client bootstrap", () => {
    const localTestKey = "must-never-enter-the-client-bootstrap";
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEV_DEMO_STATE_FILE", "/tmp/demo-state.json");
    vi.stubEnv("AUTO_UX_LOCAL_TEST_KEY", localTestKey);

    const page = HomePage();

    expect(JSON.stringify(page)).not.toContain(localTestKey);
  });

  it("does not expose the local demo adapter in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_DEMO_STATE_FILE", "/tmp/demo-state.json");
    vi.stubEnv(
      "AUTO_UX_LOCAL_TEST_KEY",
      "must-never-enable-production-auth"
    );

    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain("正在确认登录状态");
    expect(markup).not.toContain("发起真实配置");
    expect(markup).not.toContain("连接这台 Mac");
    expect(markup).not.toContain("创建演示任务");
  });
});
