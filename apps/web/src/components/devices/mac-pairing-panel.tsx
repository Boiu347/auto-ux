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

import { publicOrigin, publicPath } from "../../lib/public-path";

type PairingState =
  | { status: "loading" | "unpaired" }
  | { status: "waiting"; code: string; expiresAt: string }
  | { status: "paired"; online: boolean; agentId?: string; version?: string }
  | { status: "expired" }
  | { status: "error"; message: string };

const CURRENT_AGENT_VERSION = "0.4.2";

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
      const response = await fetch(publicPath("/api/pairings/current"), { cache: "no-store" });
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

  const ready = pairing.status === "paired"
    && pairing.online
    && pairing.version === CURRENT_AGENT_VERSION;
  useEffect(() => onReadyChange(ready), [onReadyChange, ready]);

  const baseUrl = origin ?? (typeof window === "undefined" ? "" : publicOrigin(window.location.origin));
  const installCommand = useMemo(() => {
    if (pairing.status !== "waiting") return "";
    return `curl -fsSL '${baseUrl}/downloads/install-mac-agent.sh' | bash -s -- '${baseUrl}' '${pairing.code}'`;
  }, [baseUrl, pairing]);
  const updateCommand = useMemo(
    () => `curl -fsSL '${baseUrl}/downloads/install-mac-agent.sh' | bash -s -- '${baseUrl}'`,
    [baseUrl]
  );
  const updateRequired = pairing.status === "paired" && pairing.version !== CURRENT_AGENT_VERSION;

  const createPairing = async () => {
    setPairing({ status: "loading" });
    try {
      const response = await fetch(publicPath("/api/pairings"), { method: "POST" });
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
        description={<Text>只需配对一次，之后网站会通过 Codex 接口直接创建任务，不使用剪贴板或辅助功能权限。</Text>}
      />
      {pairing.status === "paired" ? (
        <MessageBar intent={pairing.online && !updateRequired ? "success" : "warning"}>
          <MessageBarBody>
            <strong>{pairing.online ? "Mac 助手在线" : "Mac 助手离线"}</strong>
            {pairing.version ? ` · 版本 ${pairing.version}` : ""}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {updateRequired ? (
        <div className="pairing-instructions">
          <Text>助手需要升级到 {CURRENT_AGENT_VERSION}；升级会保留现有配对，不会申请辅助功能权限。</Text>
          <code className="install-command">{updateCommand}</code>
          <Button type="button" onClick={() => void navigator.clipboard.writeText(updateCommand)}>
            复制升级命令
          </Button>
        </div>
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
