"use client";

import type {
  ConfirmationAction,
  ExecutionEvent,
  ExecutionPhase
} from "@app/contracts";
import {
  Button,
  Card,
  CardHeader,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  Title3
} from "@fluentui/react-components";
import { useState } from "react";

import type { ExecutionSummary } from "./hybrid-progress";

const confirmationByPhase: Partial<
  Record<
    ExecutionPhase,
    {
      action: ConfirmationAction;
      stepId: ExecutionEvent["stepId"];
      buttonLabel: string;
      title: string;
      detail: string;
    }
  >
> = {
  publish_confirm: {
    action: "publish",
    stepId: "publish.confirm",
    buttonLabel: "确认发布",
    title: "发布配置",
    detail: "确认后仅签发本次配置版本的发布凭据。"
  },
  numbers_confirm: {
    action: "import_numbers",
    stepId: "numbers.confirm",
    buttonLabel: "确认导入号码",
    title: "导入号码",
    detail: "确认后仅签发本次配置版本的号码导入凭据。"
  },
  dial_confirm: {
    action: "start_dial",
    stepId: "dial.confirm",
    buttonLabel: "确认开始外呼",
    title: "开始外呼",
    detail: "确认后仅签发本次配置版本的外呼启动凭据。"
  }
};

export function ConfirmationPanel({
  execution,
  event
}: {
  execution: ExecutionSummary;
  event?: ExecutionEvent;
}) {
  const [submission, setSubmission] = useState<
    | { state: "idle" }
    | { state: "submitting" }
    | { state: "issued"; expiresAt?: string }
    | { state: "error"; message: string }
  >({ state: "idle" });
  const gate = confirmationByPhase[execution.phase];
  const matchesPersistedGate =
    execution.status === "waiting_confirmation" &&
    event?.status === "waiting_confirmation" &&
    event.stepId === gate?.stepId;

  if (!gate || !matchesPersistedGate) {
    return (
      <Card className="dashboard-panel confirmation-panel">
        <CardHeader header={<Title3 as="h2">下一确认门</Title3>} />
        <Text>无匹配的待确认动作</Text>
      </Card>
    );
  }

  const submit = async () => {
    setSubmission({ state: "submitting" });
    try {
      const response = await fetch(
        `/api/executions/${encodeURIComponent(execution.id)}/confirmations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: gate.action,
            configVersion: execution.configVersion
          })
        }
      );
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        confirmation?: { expiresAt?: string };
      };
      if (!response.ok) {
        setSubmission({
          state: "error",
          message: confirmationError(response.status, payload.code)
        });
        return;
      }
      setSubmission({
        state: "issued",
        expiresAt: payload.confirmation?.expiresAt
      });
    } catch {
      setSubmission({
        state: "error",
        message: "确认请求失败。执行状态未变更，请检查连接后重试。"
      });
    }
  };

  return (
    <Card className="dashboard-panel confirmation-panel">
      <CardHeader
        header={<Title3 as="h2">下一确认门</Title3>}
        description={<Text weight="semibold">{gate.title}</Text>}
      />
      <Text>{gate.detail}</Text>
      <Button
        appearance="primary"
        disabled={submission.state !== "idle"}
        onClick={submit}
      >
        {submission.state === "submitting" ? "正在提交确认" : gate.buttonLabel}
      </Button>
      <div aria-live="polite" aria-atomic="true">
        {submission.state === "issued" ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>确认凭据已签发</MessageBarTitle>
              等待本地代理消费凭据，界面不会提前标记动作成功。
              {submission.expiresAt
                ? ` 凭据到期时间：${submission.expiresAt}`
                : ""}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {submission.state === "error" ? (
          <MessageBar intent="error">
            <MessageBarBody role="alert">
              <MessageBarTitle>确认未生效</MessageBarTitle>
              {submission.message}
            </MessageBarBody>
          </MessageBar>
        ) : null}
      </div>
    </Card>
  );
}

function confirmationError(status: number, code?: string): string {
  if (
    status === 409 ||
    status === 410 ||
    code === "CONFIRMATION_INVALID" ||
    code === "CONFIRMATION_CONFIG_MISMATCH" ||
    code === "CONFIRMATION_ACTION_MISMATCH"
  ) {
    return `确认已失效或执行状态已变化。服务端返回：${code ?? status}`;
  }
  return `确认请求失败。服务端返回：${code ?? status}`;
}
