"use client";

import {
  Button,
  FluentProvider,
  Text,
  Title1,
  webLightTheme
} from "@fluentui/react-components";

import { ExecutionList } from "./executions/execution-list";
import {
  RealExecutionForm,
  type TaskFormValues
} from "./executions/real-execution-form";
import { MacPairingPanel } from "./devices/mac-pairing-panel";
import { useCallback, useEffect, useState } from "react";
import { publicPath } from "../lib/public-path";
import type { TaskHistoryItem } from "./executions/execution-list";

export function HomeDashboard({
  bootstrap,
  localLaunchEnabled,
  cloudPairingEnabled = false
}: {
  bootstrap?: {
    userId: string;
    workspaceId: string;
  };
  localLaunchEnabled: boolean;
  cloudPairingEnabled?: boolean;
}) {
  const [pairedDeviceReady, setPairedDeviceReady] = useState(false);
  const [accessReady, setAccessReady] = useState(false);
  const [auth, setAuth] = useState<
    | { status: "loading" | "unauthenticated" }
    | {
        status: "authenticated";
        name: string;
        avatarUrl: string | null;
        managedByProxy: boolean;
      }
  >(
    cloudPairingEnabled
      ? { status: "loading" }
      : {
          status: "authenticated",
          name: "本地开发",
          avatarUrl: null,
          managedByProxy: false
        }
  );
  const [workspace, setWorkspace] = useState<{
    loading: boolean;
    error?: string;
    draft: (TaskFormValues & { updatedAt: string }) | null;
    executions: TaskHistoryItem[];
  }>({ loading: true, draft: null, executions: [] });
  const [fillRequest, setFillRequest] = useState<{
    key: number;
    input: TaskFormValues;
  }>();
  const handleReadyChange = useCallback((ready: boolean) => setPairedDeviceReady(ready), []);
  useEffect(() => {
    if (!cloudPairingEnabled) return;
    const controller = new AbortController();
    void fetch(publicPath("/api/auth/session"), {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal
    })
      .then(async (response) => {
        if (response.status === 401) {
          setAuth({ status: "unauthenticated" });
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = (await response.json()) as {
          managedByProxy: boolean;
          user: { name: string; avatarUrl: string | null };
        };
        setAuth({
          status: "authenticated",
          managedByProxy: value.managedByProxy,
          ...value.user
        });
        setAccessReady(true);
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setAuth({ status: "unauthenticated" });
        }
      });
    return () => controller.abort();
  }, [cloudPairingEnabled]);

  useEffect(() => {
    if (cloudPairingEnabled || !bootstrap) return;
    const controller = new AbortController();
    void fetch(publicPath("/api/dev/session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bootstrap),
      signal: controller.signal
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setAccessReady(true);
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setWorkspace((current) => ({
            ...current,
            loading: false,
            error: "无法建立本地开发会话"
          }));
        }
      });
    return () => controller.abort();
  }, [bootstrap, cloudPairingEnabled]);

  const loadWorkspace = useCallback(async () => {
    setWorkspace((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const response = await fetch(publicPath("/api/task-workspace"), {
        headers: { accept: "application/json" }
      });
      if (response.status === 401) {
        setWorkspace({ loading: false, draft: null, executions: [] });
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const value = (await response.json()) as {
        draft: (TaskFormValues & { updatedAt: string }) | null;
        executions: TaskHistoryItem[];
      };
      setWorkspace({
        loading: false,
        draft: value.draft,
        executions: value.executions
      });
    } catch {
      setWorkspace((current) => ({
        ...current,
        loading: false,
        error: "无法读取跨设备历史记录"
      }));
    }
  }, []);

  useEffect(() => {
    if (auth.status === "authenticated" && accessReady) {
      const timer = window.setTimeout(() => void loadWorkspace(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [accessReady, auth.status, loadWorkspace]);

  useEffect(() => {
    if (pairedDeviceReady) {
      const timer = window.setTimeout(() => void loadWorkspace(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [loadWorkspace, pairedDeviceReady]);

  const logout = useCallback(async () => {
    await fetch(publicPath("/api/auth/session"), { method: "DELETE" });
    setPairedDeviceReady(false);
    setAccessReady(false);
    setWorkspace({ loading: false, draft: null, executions: [] });
    setAuth({ status: "unauthenticated" });
  }, []);

  return (
    <FluentProvider theme={webLightTheme} className="dashboard-provider">
      <main className="dashboard-shell home-shell">
        <header className="home-header">
          <div className="home-header-copy">
            <Text className="product-name">配置工作台</Text>
            <Title1 as="h1">百度云外呼一键配置</Title1>
            <Text className="home-lead">
              从资料整理到本机执行，把每一次配置收拢在一个清晰流程里。
            </Text>
          </div>
          <div className="home-header-actions">
            {auth.status === "authenticated" && cloudPairingEnabled ? (
              <div className="home-account">
                <Text weight="semibold">{auth.name}</Text>
                {!auth.managedByProxy ? (
                  <Button appearance="subtle" size="small" onClick={() => void logout()}>
                    退出
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="home-safety-note">
              <Text weight="semibold">本机安全边界</Text>
              <Text size={200}>原始资料与完整号码不会上传到网站</Text>
            </div>
          </div>
        </header>

        {auth.status !== "authenticated" ? (
          <section className="auth-gate" aria-live="polite">
            {auth.status === "loading" ? (
              <Text>正在确认登录状态</Text>
            ) : (
              <>
                <Title1 as="h2">使用飞书账号登录</Title1>
                <Text>登录后可在不同设备恢复草稿和最近任务。</Text>
                <a className="auth-login-link" href={publicPath("/api/auth/feishu/start")}>
                  飞书登录
                </a>
              </>
            )}
          </section>
        ) : (
          <section className="home-workspace" aria-label="发起配置工作区">
          <section className="home-primary" aria-label="主要任务">
            <RealExecutionForm
              key={
                fillRequest?.key ??
                workspace.draft?.updatedAt ??
                (workspace.loading ? "loading" : "empty")
              }
              bootstrap={bootstrap}
              localLaunchEnabled={localLaunchEnabled}
              cloudPairingEnabled={cloudPairingEnabled}
              pairedDeviceReady={pairedDeviceReady}
              initialDraft={workspace.draft}
              workspaceLoaded={!workspace.loading}
              fillRequest={fillRequest}
              onTaskCreated={loadWorkspace}
            />
          </section>

          <aside className="home-sidebar" aria-label="配置辅助信息">
            <section className="home-process" aria-labelledby="home-process-title">
              <Text className="home-section-label">操作流程</Text>
              <Title1 as="h2" id="home-process-title">
                三步开始配置
              </Title1>
              <ol>
                <li>
                  <strong>01 整理资料</strong>
                  <Text size={200}>填写飞书链接、补充要求与本地号码文件。</Text>
                </li>
                <li>
                  <strong>02 确认配置</strong>
                  <Text size={200}>Codex 会先生成草案，高风险动作仍需本人确认。</Text>
                </li>
                <li>
                  <strong>03 本机执行</strong>
                  <Text size={200}>任务在已配对的 Mac 上继续，并回传真实进度。</Text>
                </li>
              </ol>
            </section>

            {cloudPairingEnabled || accessReady ? (
              <MacPairingPanel onReadyChange={handleReadyChange} />
            ) : null}
            <ExecutionList
              executions={workspace.executions}
              loading={workspace.loading}
              error={workspace.error}
              onCopy={(input) =>
                setFillRequest((current) => ({
                  key: (current?.key ?? 0) + 1,
                  input
                }))
              }
            />
          </aside>
          </section>
        )}
      </main>
    </FluentProvider>
  );
}
