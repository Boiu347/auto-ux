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

const CURRENT_AGENT_VERSION = "0.4.5";

const tokenValidation = [
  'token_value=${token#device_token:}',
  '[ "$token_value" != "$token" ] && [ "${#token_value}" -eq 64 ] || { echo "设备令牌无效。" >&2; exit 1; }',
  'case "$token_value" in *[!0-9a-f]*) echo "设备令牌无效。" >&2; exit 1;; esac'
].join("\n");

const installerRunner = [
  'installer="$temp/install-mac-agent.sh"',
  '/usr/bin/curl --fail --silent --show-error --location --retry 4 --retry-delay 2',
  '  --connect-timeout 10 --max-time 120 --header "Authorization: Bearer $token"',
  '  "$base/api/devices/assets/install-mac-agent.sh" -o "$installer"',
  '/bin/chmod 700 "$installer"',
  '/bin/bash "$installer" "$base"'
].join("\n");

export const initialInstallScript = [
  'set -eu',
  'umask 077',
  'base=$1',
  'code=$2',
  'temp=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/auto-ux-bootstrap.XXXXXX")',
  'trap \'/bin/rm -rf "$temp"\' EXIT HUP INT TERM',
  'host=$(/bin/hostname | /usr/bin/tr -cd "A-Za-z0-9_-" | /usr/bin/cut -c 1-40)',
  '[ -n "$host" ] || host=Codex',
  'agent_id="Mac_$host"',
  'request="$temp/pair.plist"',
  'request_json="$temp/pair.json"',
  'response="$temp/response.json"',
  '/usr/bin/plutil -create xml1 "$request"',
  '/usr/bin/plutil -insert code -string "$code" "$request"',
  '/usr/bin/plutil -insert agentId -string "$agent_id" "$request"',
  '/usr/bin/plutil -insert version -string bootstrap "$request"',
  '/usr/bin/plutil -convert json -o "$request_json" "$request"',
  'status=$(/usr/bin/curl --silent --show-error --connect-timeout 10 --max-time 30',
  '  -o "$response" -w "%{http_code}" -H "Content-Type: application/json"',
  '  --data-binary "@$request_json" "$base/api/devices/pair")',
  '[ "$status" = 200 ] || {',
  '  error=$(/usr/bin/plutil -extract code raw -expect string -o - "$response" 2>/dev/null || true)',
  '  echo "Mac 配对失败：${error:-HTTP_$status}。请回网站检查配对状态，禁止重复提交同一配对码。" >&2',
  '  exit 1',
  '}',
  'token=$(/usr/bin/plutil -extract deviceToken raw -expect string -o - "$response")',
  tokenValidation,
  'config_dir="$HOME/.config/auto-ux"',
  'config_plist="$temp/agent.plist"',
  'config="$config_dir/agent.json"',
  '/bin/mkdir -p "$config_dir"',
  '/bin/chmod 700 "$config_dir"',
  '/usr/bin/plutil -create xml1 "$config_plist"',
  '/usr/bin/plutil -insert apiBaseUrl -string "$base" "$config_plist"',
  '/usr/bin/plutil -insert deviceToken -string "$token" "$config_plist"',
  '/usr/bin/plutil -insert agentId -string "$agent_id" "$config_plist"',
  '/usr/bin/plutil -convert json -o "$config" "$config_plist"',
  '/bin/chmod 600 "$config"',
  installerRunner
].join("\n");

export const updateInstallScript = [
  'set -eu',
  'umask 077',
  'base=$1',
  'config="$HOME/.config/auto-ux/agent.json"',
  '[ -f "$config" ] || { echo "未找到 Mac 助手配对配置。" >&2; exit 1; }',
  'token=$(/usr/bin/plutil -extract deviceToken raw -expect string -o - "$config")',
  tokenValidation,
  'temp=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/auto-ux-upgrade.XXXXXX")',
  'trap \'/bin/rm -rf "$temp"\' EXIT HUP INT TERM',
  installerRunner
].join("\n");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellInstallCommand(script: string, ...args: string[]): string {
  return `/bin/sh -c ${shellQuote(script)} -- ${args.map(shellQuote).join(" ")}`;
}

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
    return shellInstallCommand(initialInstallScript, baseUrl, pairing.code);
  }, [baseUrl, pairing]);
  const updateCommand = useMemo(
    () => shellInstallCommand(updateInstallScript, baseUrl),
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
        description={<Text>只需配对一次，无需预装 Node.js。之后网站会通过 Codex 接口直接创建任务，不使用剪贴板或辅助功能权限。</Text>}
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
