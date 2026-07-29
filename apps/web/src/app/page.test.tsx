import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("home page", () => {
  it("shows an empty execution list and an unavailable Codex launch action", () => {
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain("百度云外呼一键配置");
    expect(markup).toContain("暂无执行任务");
    expect(markup).toContain("在 Codex 中开始执行");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("创建并确认配置草案后，才能在 Codex 中开始执行。");
  });
});
