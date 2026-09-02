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

const CURRENT_AGENT_VERSION = "0.4.4";

const installerRunner = [
  'async function runInstaller(base,token){',
  'const response=await fetch(base+"/api/devices/assets/install-mac-agent.sh",',
  '{headers:{authorization:"Bearer "+token}});',
  'if(!response.ok)throw new Error("INSTALLER_HTTP_"+response.status);',
  'const child=spawn("/bin/bash",["-s","--",base],{stdio:["pipe","inherit","inherit"]});',
  'child.stdin.end(await response.text());',
  'const status=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve)});',
  'if(status!==0)process.exit(status??1);',
  '}'
].join("");

export const initialInstallProgram = [
  'import fs from "node:fs";import os from "node:os";import path from "node:path";',
  'import{spawn}from "node:child_process";',
  installerRunner,
  'const[base,code]=process.argv.slice(1);',
  'const host=os.hostname().replace(/[^A-Za-z0-9_-]/g,"_").slice(0,40)||"Codex";',
  'const agentId="Mac_"+host;',
  'const response=await fetch(base+"/api/devices/pair",{method:"POST",',
  'headers:{"content-type":"application/json"},',
  'body:JSON.stringify({code,agentId,version:"0.4.4"})});',
  'const payload=await response.json().catch(()=>({}));',
  'if(!response.ok||!/^device_token:[a-f0-9]{64}$/.test(payload.deviceToken))',
  'throw new Error(payload.code||"PAIRING_FAILED");',
  'const configPath=path.join(os.homedir(),".config","auto-ux","agent.json");',
  'fs.mkdirSync(path.dirname(configPath),{recursive:true,mode:0o700});',
  'fs.writeFileSync(configPath,JSON.stringify({apiBaseUrl:base,deviceToken:payload.deviceToken,agentId},null,2)+"\\n",{mode:0o600});',
  'fs.chmodSync(configPath,0o600);',
  'await runInstaller(base,payload.deviceToken);'
].join("");

export const updateInstallProgram = [
  'import fs from "node:fs";import os from "node:os";import path from "node:path";',
  'import{spawn}from "node:child_process";',
  installerRunner,
  'const[base]=process.argv.slice(1);',
  'const configPath=path.join(os.homedir(),".config","auto-ux","agent.json");',
  'const config=JSON.parse(fs.readFileSync(configPath,"utf8"));',
  'if(!/^device_token:[a-f0-9]{64}$/.test(config.deviceToken))throw new Error("DEVICE_TOKEN_INVALID");',
  'await runInstaller(base,config.deviceToken);'
].join("");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nodeInstallCommand(program: string, ...args: string[]): string {
  return `node --input-type=module -e ${shellQuote(program)} ${args.map(shellQuote).join(" ")}`;
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
    return nodeInstallCommand(initialInstallProgram, baseUrl, pairing.code);
  }, [baseUrl, pairing]);
  const updateCommand = useMemo(
    () => nodeInstallCommand(updateInstallProgram, baseUrl),
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
