"use client";

import {
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Text,
  Textarea,
  Title2
} from "@fluentui/react-components";
import Link from "next/link";
import { FormEvent, useState } from "react";

import { publicPath } from "../../lib/public-path";

import { buildStandaloneCodexPrompt } from "./build-codex-prompt";

type FormState =
  | "idle"
  | "creating"
  | "queued"
  | "error";

type CreatedTask = {
  executionId: string;
};

export function RealExecutionForm({
  pairedDeviceReady = false
}: {
  bootstrap?: { userId: string; workspaceId: string };
  apiBaseUrl?: string;
  localLaunchEnabled: boolean;
  cloudPairingEnabled?: boolean;
  pairedDeviceReady?: boolean;
}) {
  const [state, setState] = useState<FormState>("idle");
  const [created, setCreated] = useState<CreatedTask>();
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state === "creating" || state === "queued") {
      return;
    }
    setError(undefined);
    try {
      const data = new FormData(event.currentTarget);
      const feishuUrls = String(data.get("feishuUrls") ?? "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const requirements = String(data.get("requirements") ?? "");
      const phoneFilePath = String(data.get("phoneFilePath") ?? "");
      const robotName = String(data.get("robotName") ?? "");
      buildStandaloneCodexPrompt({
        feishuUrls,
        requirements,
        phoneFilePath,
        robotName
      });
      if (!pairedDeviceReady) {
        throw new Error("请先完成一次性 Mac 配对并保持助手在线。");
      }
      setState("creating");
      const response = await fetch(publicPath("/api/paired-tasks"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: createRequestId(),
          feishuUrls,
          requirements,
          phoneFilePath,
          robotName
        })
      });
      const value = (await response.json().catch(() => ({}))) as {
        executionId?: string;
        message?: string;
        code?: string;
        diagnosticId?: string;
      };
      if (!response.ok || !value.executionId) {
        throw new Error(pairedTaskErrorMessage(value, response.status));
      }
      setCreated({ executionId: value.executionId });
      setState("queued");
    } catch (cause) {
      setError(userFacingError(cause));
      setState("error");
    }
  };

  const busy = state === "creating" || state === "queued";
  const buttonLabel = state === "creating"
    ? "正在发送到 Mac"
    : state === "queued"
      ? "任务已发送"
      : pairedDeviceReady
        ? "一键发送到 Mac Codex"
        : "请先配对 Mac 助手";

  return (
    <Card className="dashboard-panel real-execution-card">
      <CardHeader
        header={<Title2 as="h2">发起真实配置</Title2>}
        description={
          <Text>填写来源和要求。网站创建任务后会在这台 Mac 上打开 Codex。</Text>
        }
      />
      <form className="real-execution-form" onSubmit={submit} noValidate>
        <Field label="飞书文档链接" required hint="每行一个 HTTPS 链接">
          <Textarea name="feishuUrls" required resize="vertical" />
        </Field>
        <Field label="补充需求" required>
          <Textarea name="requirements" required resize="vertical" />
        </Field>
        <div className="real-form-row">
          <Field label="本地号码文件路径" required hint="网站不会上传或读取文件内容">
            <Input name="phoneFilePath" required placeholder="/Users/you/Desktop/phones.xlsx" />
          </Field>
          <Field label="机器人名称" hint="可选">
            <Input name="robotName" />
          </Field>
        </div>
        <Button type="submit" appearance="primary" disabled={busy || !pairedDeviceReady}>
          {buttonLabel}
        </Button>
      </form>
      <div aria-live="polite" className="real-execution-feedback">
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody role="alert">{error}</MessageBarBody>
          </MessageBar>
        ) : null}
        {state === "queued" ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <strong>任务已进入 Mac 队列</strong>。助手会通过 Codex 接口直接创建并发送任务。
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {created ? (
          <Link href={`/executions/${created.executionId}`}>查看任务页面</Link>
        ) : null}
      </div>
    </Card>
  );
}

function createRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `request_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function pairedTaskErrorMessage(
  value: { message?: string; code?: string; diagnosticId?: string },
  status: number
): string {
  const code = typeof value.code === "string" && /^[A-Z0-9_]{2,80}$/.test(value.code)
    ? value.code
    : status
      ? `HTTP_${status}`
      : "INVALID_RESPONSE";
  const messages: Record<string, string> = {
    UNAUTHENTICATED: "浏览器的 Mac 配对凭证已失效，请重新配对。",
    DEVICE_NOT_PAIRED: "当前浏览器尚未与 Mac 助手完成配对，请重新配对。",
    AUTO_UX_PUBLIC_BASE_URL_INVALID: "服务端公开地址配置无效，请联系管理员检查部署配置。",
    EXECUTION_TOKEN_MISSING: "任务已创建，但执行凭证生成失败，请稍后重试。",
    INVALID_REQUEST: "提交内容格式不正确，请检查后重试。",
    INVALID_TASK: "任务内容无法进入 Mac 队列，请检查内容长度和本地文件路径。",
    INTERNAL_ERROR: "服务端创建任务失败，请稍后重试。",
    INVALID_RESPONSE: "服务端返回了无法识别的结果，请稍后重试。"
  };
  const fallbackMessage = typeof value.message === "string" && value.message.trim()
    ? value.message.trim()
    : "无法把任务发送到 Mac。";
  const message = messages[code] ?? fallbackMessage;
  const diagnosticId = typeof value.diagnosticId === "string" && /^diag_[a-f0-9]{16,64}$/.test(value.diagnosticId)
    ? value.diagnosticId
    : undefined;
  const diagnostic = diagnosticId
    ? `诊断码：${code}；追踪号：${diagnosticId}`
    : `诊断码：${code}`;
  return `${message}（${diagnostic}）`;
}

function userFacingError(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return "请求失败，请重试。";
  }
  const messages: Record<string, string> = {
    FEISHU_URL_REQUIRED: "请至少填写一个飞书文档链接。",
    REQUIREMENTS_REQUIRED: "请填写补充需求。",
    INVALID_PHONE_FILE_PATH: "请输入不含换行的 Mac 本地绝对文件路径。",
    INVALID_URL: "飞书文档链接必须是有效的 HTTPS 地址。",
    INVALID_ROBOT_NAME: "机器人名称不能包含换行或空字符。",
    PROMPT_TOO_LARGE: "任务内容过长，请精简到 32 KiB 以内。"
  };
  return messages[cause.message] ?? cause.message;
}
