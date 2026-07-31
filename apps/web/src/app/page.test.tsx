import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePage from "./page";

describe("home page", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows an empty execution list and an unavailable Codex launch action", () => {
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain("百度云外呼一键配置");
    expect(markup).toContain("暂无执行任务");
    expect(markup).toContain("在 Codex 中开始执行");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("创建并确认配置草案后，才能在 Codex 中开始执行。");
    expect(markup).toContain("开发会话");
    expect(markup).toContain("用户 ID");
    expect(markup).toContain("工作区 ID");
    expect(markup).toContain("建立开发会话");
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

    expect(markup).not.toContain("开发会话");
    expect(markup).not.toContain("创建演示任务");
  });
});
