"use client";

import {
  Button,
  Card,
  CardHeader,
  MessageBar,
  MessageBarBody,
  Text,
  Title2
} from "@fluentui/react-components";
import { useCallback, useEffect, useMemo, useState } from "react";

type PairingState =
  | { status: "loading" | "unpaired" }
  | { status: "waiting"; code: string; expiresAt: string }
  | { status: "paired"; online: boolean; agentId?: string; version?: string }
  | { status: "expired" }
  | { status: "error"; message: string };

export function MacPairingPanel({
  origin,
  onReadyChange
}: {
  origin?: string;
  onReadyChange: (ready: boolean) => void;
}) {
  const [pairing, setPairing] = useState<PairingState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/pairings/current", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取 Mac 配对状态。");
      const value = (await response.json()) as {
        status: "unpaired" | "waiting_for_mac" | "paired" | "expired";
        online?: boolean;
        agentId?: string;
        version?: string;
      };
      setPairing((current) => {
        if (value.status === "waiting_for_mac") {
          return current.status === "waiting" ? current : { status: "unpaired" };
        }
        if (value.status === "paired") {
          return {
            status: "paired",
            online: Boolean(value.online),
            agentId: value.agentId,
            version: value.version
          };
        }
        return { status: value.status };
      });
    } catch (cause) {
      setPairing({
        status: "error",
        message: cause instanceof Error ? cause.message : "无法读取 Mac 配对状态。"
      });
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const ready = pairing.status === "paired" && pairing.online;
  useEffect(() => onReadyChange(ready), [onReadyChange, ready]);

  const baseUrl = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  const installCommand = useMemo(() => {
    if (pairing.status !== "waiting") return "";
    return `curl -fsSL https://raw.githubusercontent.com/Boiu347/auto-ux/main/scripts/install-mac-agent.sh | bash -s -- '${baseUrl}' '${pairing.code}'`;
  }, [baseUrl, pairing]);

  const createPairing = async () => {
    setPairing({ status: "loading" });
    try {
      const response = await fetch("/api/pairings", { method: "POST" });
      const value = (await response.json().catch(() => ({}))) as {
        code?: string;
        expiresAt?: string;
      };
      if (!response.ok || !value.code || !value.expiresAt) {
        throw new Error("生成配对码失败，请重试。");
      }
      setPairing({ status: "waiting", code: value.code, expiresAt: value.expiresAt });
    } catch (cause) {
      setPairing({
        status: "error",
        message: cause instanceof Error ? cause.message : "生成配对码失败，请重试。"
      });
    }
  };

  return (
    <Card className="dashboard-panel mac-pairing-card">
      <CardHeader
        header={<Title2 as="h2">连接这台 Mac</Title2>}
        description={<Text>只需配对一次，之后网站会把任务自动发送给本机 Codex。</Text>}
      />
      {pairing.status === "paired" ? (
        <MessageBar intent={pairing.online ? "success" : "warning"}>
          <MessageBarBody>
            <strong>{pairing.online ? "Mac 助手在线" : "Mac 助手离线"}</strong>
            {pairing.version ? ` · 版本 ${pairing.version}` : ""}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {pairing.status === "waiting" ? (
        <div className="pairing-instructions">
          <Text>在需要执行任务的 Mac 终端粘贴下面这条命令：</Text>
          <strong className="pairing-code">{pairing.code}</strong>
          <code className="install-command">{installCommand}</code>
          <Button type="button" onClick={() => void navigator.clipboard.writeText(installCommand)}>
            复制安装命令
          </Button>
        </div>
      ) : null}
      {pairing.status === "error" ? (
        <MessageBar intent="error"><MessageBarBody>{pairing.message}</MessageBarBody></MessageBar>
      ) : null}
      {pairing.status === "unpaired" || pairing.status === "expired" || pairing.status === "error" ? (
        <Button type="button" appearance="primary" onClick={() => void createPairing()}>
          生成 Mac 配对码
        </Button>
      ) : null}
    </Card>
  );
}
