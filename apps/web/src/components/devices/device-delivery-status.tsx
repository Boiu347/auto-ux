"use client";

import { Button, MessageBar, MessageBarBody } from "@fluentui/react-components";
import { useCallback, useEffect, useState } from "react";

import { publicPath } from "../../lib/public-path";

type Delivery = {
  status: "queued" | "claimed" | "codex_opened" | "waiting_permission" | "prompt_sent" | "agent_started" | "ack_timeout" | "failed";
  errorCode: string | null;
  retryable: boolean;
};

const labels: Record<Delivery["status"], string> = {
  queued: "任务正在等待 Mac 助手接收",
  claimed: "Mac 助手正在准备任务",
  codex_opened: "Mac 助手已打开 Codex",
  waiting_permission: "旧版 Mac 助手正在等待辅助功能权限；请重新安装新版助手。",
  prompt_sent: "任务已通过 Codex 接口发送，等待 Codex 接管",
  agent_started: "Codex 已接管任务",
  ack_timeout: "Codex 未在 60 秒内确认接管",
  failed: "Mac 助手发送失败"
};

const errors: Record<string, string> = {
  PHONE_FILE_NOT_FOUND: "Mac 上找不到号码文件，请检查表单中的绝对路径。",
  CLIPBOARD_FAILED: "旧版助手无法写入剪贴板；重新安装新版后不再使用剪贴板。",
  CODEX_OPEN_FAILED: "无法在 Mac 上打开 Codex。",
  CODEX_CLI_NOT_FOUND: "未找到 Codex CLI，请升级或重新安装 Codex。",
  CODEX_APP_SERVER_TIMEOUT: "Codex 任务接口响应超时，未确认接管前可重试。",
  CODEX_APP_SERVER_FAILED: "Codex 任务接口拒绝了请求，请升级 Codex 后重试。",
  CODEX_SEND_FAILED: "无法通过 Codex 任务接口发送。",
  CODEX_ACK_TIMEOUT: "Codex 未在 60 秒内确认接管。"
};

export function DeviceDeliveryStatus({ executionId }: { executionId: string }) {
  const [delivery, setDelivery] = useState<Delivery>();
  const [retrying, setRetrying] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(publicPath(`/api/paired-tasks/${encodeURIComponent(executionId)}`), { cache: "no-store" });
      if (response.ok) setDelivery(await response.json());
    } catch {
      // The execution event stream remains authoritative if delivery polling is unavailable.
    }
  }, [executionId]);
  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      const response = await fetch(`/api/paired-tasks/${encodeURIComponent(executionId)}`, {
        method: "POST"
      });
      if (response.ok) setDelivery(await response.json());
      else await refresh();
    } finally {
      setRetrying(false);
    }
  }, [executionId, refresh]);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);
  if (!delivery) return null;
  const detail = delivery.status === "failed" && delivery.errorCode
    ? errors[delivery.errorCode] ?? `错误代码：${delivery.errorCode}`
    : labels[delivery.status];
  const intent = delivery.status === "agent_started"
    ? "success"
    : delivery.status === "failed" || delivery.status === "ack_timeout"
      ? "error"
      : "info";
  return (
    <MessageBar intent={intent}>
      <MessageBarBody>
        <strong>Mac 交付状态：</strong>{detail}
        {delivery.retryable ? (
          <Button size="small" type="button" disabled={retrying} onClick={() => void retry()}>
            重新发送
          </Button>
        ) : null}
      </MessageBarBody>
    </MessageBar>
  );
}
