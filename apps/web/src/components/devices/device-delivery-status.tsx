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
  waiting_permission: "等待同事在 Mac 上允许辅助功能；设置页面已自动打开，授权后会自动继续。",
  prompt_sent: "Mac 已尝试发送，等待 Codex 接管",
  agent_started: "Codex 已接管任务",
  ack_timeout: "Codex 未在 60 秒内确认接管",
  failed: "Mac 助手发送失败"
};

const errors: Record<string, string> = {
  PHONE_FILE_NOT_FOUND: "Mac 上找不到号码文件，请检查表单中的绝对路径。",
  CLIPBOARD_FAILED: "无法写入 Mac 剪贴板。",
  CODEX_OPEN_FAILED: "无法在 Mac 上打开 Codex。",
  CODEX_SEND_FAILED: "无法自动粘贴并发送，请检查辅助功能权限。",
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
