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
    expect(markup).toContain("暂无执行任务");
    expect(markup).toContain("发起真实配置");
    expect(markup).toContain("飞书文档链接");
    expect(markup).toContain("本地号码文件路径");
    expect(markup).toContain("一键配置并打开 Codex");
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

    expect(markup).toContain("发起真实配置");
    expect(markup).toContain("连接这台 Mac");
    expect(markup).not.toContain("创建演示任务");
  });
});
