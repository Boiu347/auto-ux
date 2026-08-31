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

import { publicOrigin, publicPath } from "../../lib/public-path";

import {
  buildCodexPrompt,
  buildStandaloneCodexPrompt
} from "./build-codex-prompt";

type FormState =
  | "idle"
  | "creating"
  | "launching"
  | "manual_paste"
  | "queued"
  | "launched"
  | "error";

type CreatedTask = {
  executionId: string;
  prompt: string;
};

export function RealExecutionForm({
  bootstrap,
  apiBaseUrl,
  localLaunchEnabled
  ,cloudPairingEnabled = false
  ,pairedDeviceReady = false
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

  const launch = async (task: CreatedTask) => {
    setState("launching");
    const response = await fetch(publicPath("/api/local/launch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: task.prompt })
    });
    if (!response.ok) {
      throw new Error("无法打开 Codex，任务已创建，可直接重试打开。");
    }
    const result = (await response.json()) as { fallback?: string };
    setState(result.fallback === "manual_paste" ? "manual_paste" : "launched");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state === "creating" || state === "launching") {
      return;
    }
    setError(undefined);
    try {
      if (created) {
        await launch(created);
        return;
      }
      const data = new FormData(event.currentTarget);
      const feishuUrls = String(data.get("feishuUrls") ?? "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const requirements = String(data.get("requirements") ?? "");
      const phoneFilePath = String(data.get("phoneFilePath") ?? "");
      const robotName = String(data.get("robotName") ?? "");
      const baseUrl = apiBaseUrl ?? publicOrigin(window.location.origin);

      if (cloudPairingEnabled || pairedDeviceReady) {
        buildStandaloneCodexPrompt({
          feishuUrls,
          requirements,
          phoneFilePath,
          robotName
        });
        if (!pairedDeviceReady) {
          throw new Error("请先配对并保持 Mac 助手在线。");
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
        setCreated({ executionId: value.executionId, prompt: "" });
        setState("queued");
        return;
      }

      if (!localLaunchEnabled) {
        const standalonePrompt = buildStandaloneCodexPrompt({
          feishuUrls,
          requirements,
          phoneFilePath,
          robotName
        });
        await navigator.clipboard.writeText(standalonePrompt);
        setState("manual_paste");
        return;
      }

      buildCodexPrompt({
        executionId: "VALIDATE",
        agentToken: `execution_token:${"0".repeat(64)}`,
        apiBaseUrl: baseUrl,
        feishuUrls,
        requirements,
        phoneFilePath,
        robotName
      });
      if (!bootstrap) {
        throw new Error("本地执行会话未配置。");
      }

      setState("creating");
      const session = await fetch(publicPath("/api/dev/session"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bootstrap)
      });
      if (!session.ok) {
        throw new Error("无法建立本地会话。");
      }
      const inputHash = await hashInput({
        sourceCount: feishuUrls.length,
        requirements,
        phoneFilePath,
        robotName
      });
      const executionResponse = await fetch(publicPath("/api/executions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          configVersion: 1,
          mode: "real_codex",
          sourceCount: feishuUrls.length,
          inputHash
        })
      });
      const executionPayload = (await executionResponse.json().catch(() => ({}))) as {
        execution?: { id?: string };
        agentToken?: string;
      };
      if (
        !executionResponse.ok ||
        !executionPayload.execution?.id ||
        !executionPayload.agentToken
      ) {
        throw new Error("无法创建真实执行任务。");
      }
      const task = {
        executionId: executionPayload.execution.id,
        prompt: buildCodexPrompt({
          executionId: executionPayload.execution.id,
          agentToken: executionPayload.agentToken,
          apiBaseUrl: baseUrl,
          feishuUrls,
          requirements,
          phoneFilePath,
          robotName
        })
      };
      setCreated(task);
      await launch(task);
    } catch (cause) {
      setError(userFacingError(cause));
      setState("error");
    }
  };

  const busy = state === "creating" || state === "launching";
  const buttonLabel = cloudPairingEnabled || pairedDeviceReady
    ? state === "creating"
      ? "正在发送到 Mac"
      : "一键发送到 Mac Codex"
    : !localLaunchEnabled
    ? "复制任务提示词"
    : created
    ? state === "launching"
      ? "正在打开 Codex"
      : "重试打开 Codex"
    : state === "creating"
      ? "正在创建任务"
      : "一键配置并打开 Codex";

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
        <Button type="submit" appearance="primary" disabled={busy || (cloudPairingEnabled && !pairedDeviceReady)}>
          {buttonLabel}
        </Button>
      </form>
      <div aria-live="polite" className="real-execution-feedback">
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody role="alert">{error}</MessageBarBody>
          </MessageBar>
        ) : null}
        {state === "launched" ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <strong>任务已交给 Codex</strong>。请在 Codex 中检查提示词并点击发送。
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {state === "queued" ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <strong>任务已进入 Mac 队列</strong>。助手会自动打开 Codex、粘贴并发送任务。
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {state === "manual_paste" ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              {localLaunchEnabled
                ? "Codex 已打开，提示词已复制到剪贴板。请按 Command+V 粘贴，再点击发送。"
                : "提示词已复制。请在 Mac 上打开 Codex，按 Command+V 粘贴，再点击发送。"}
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

async function hashInput(input: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
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
