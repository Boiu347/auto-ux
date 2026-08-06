import { describe, expect, it } from "vitest";

import {
  buildCodexPrompt,
  buildStandaloneCodexPrompt
} from "./build-codex-prompt";

const input = {
  executionId: "EX-1",
  agentToken: `execution_token:${"a".repeat(64)}`,
  apiBaseUrl: "http://localhost:3000",
  feishuUrls: ["https://guanghe.feishu.cn/docx/ABC123"],
  requirements: "创建机器人并配置字段",
  phoneFilePath: "/Users/demo/Desktop/phones.xlsx",
  robotName: "八月回访"
};

describe("buildCodexPrompt", () => {
  it("builds the bounded real workflow handoff", () => {
    const prompt = buildCodexPrompt(input);
    expect(prompt).toContain("$baidu-cloud-one-click-config");
    expect(prompt).toContain("EX-1");
    expect(prompt).toContain(input.agentToken);
    expect(prompt).toContain(input.feishuUrls[0]);
    expect(prompt).toContain(input.phoneFilePath);
    expect(prompt).toContain("create_only");
    expect(prompt).toContain("发布、导入号码、开始外呼");
    expect(prompt).toContain("report_progress.py");
    expect(prompt).toContain("不得输出完整号码");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(32 * 1024);
  });

  it.each([
    [{ ...input, feishuUrls: ["javascript:alert(1)"] }],
    [{ ...input, requirements: "   " }],
    [{ ...input, phoneFilePath: "/tmp/a\nrm" }],
    [{ ...input, phoneFilePath: "/tmp/a\0b" }],
    [{ ...input, requirements: "x".repeat(40_000) }]
  ])("rejects unsafe or oversized input", (candidate) => {
    expect(() => buildCodexPrompt(candidate)).toThrow();
  });

  it("builds a Railway-safe standalone prompt without a fake execution token", () => {
    const prompt = buildStandaloneCodexPrompt(input);
    expect(prompt).toContain("$baidu-cloud-one-click-config");
    expect(prompt).toContain(input.feishuUrls[0]);
    expect(prompt).not.toContain("execution_token:");
    expect(prompt).not.toContain("report_progress.py");
    expect(prompt).toContain("独立模式");
  });
});
