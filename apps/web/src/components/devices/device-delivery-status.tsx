"use client";

import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { useCallback, useEffect, useState } from "react";

type Delivery = {
  status: "queued" | "claimed" | "codex_opened" | "waiting_permission" | "prompt_sent" | "failed";
  errorCode: string | null;
};

const labels: Record<Delivery["status"], string> = {
  queued: "任务正在等待 Mac 助手接收",
  claimed: "Mac 助手正在准备任务",
  codex_opened: "Mac 助手已打开 Codex",
  waiting_permission: "等待同事在 Mac 上允许辅助功能；设置页面已自动打开，授权后会自动继续。",
  prompt_sent: "任务已经自动发送给 Codex",
  failed: "Mac 助手发送失败"
};

const errors: Record<string, string> = {
  PHONE_FILE_NOT_FOUND: "Mac 上找不到号码文件，请检查表单中的绝对路径。",
  CLIPBOARD_FAILED: "无法写入 Mac 剪贴板。",
  CODEX_OPEN_FAILED: "无法在 Mac 上打开 Codex。",
  CODEX_SEND_FAILED: "无法自动粘贴并发送，请检查辅助功能权限。"
};

export function DeviceDeliveryStatus({ executionId }: { executionId: string }) {
  const [delivery, setDelivery] = useState<Delivery>();
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/paired-tasks/${encodeURIComponent(executionId)}`, { cache: "no-store" });
      if (response.ok) setDelivery(await response.json());
    } catch {
      // The execution event stream remains authoritative if delivery polling is unavailable.
    }
  }, [executionId]);
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
  return (
    <MessageBar intent={delivery.status === "failed" ? "error" : delivery.status === "prompt_sent" ? "success" : "info"}>
      <MessageBarBody><strong>Mac 交付状态：</strong>{detail}</MessageBarBody>
    </MessageBar>
  );
}
