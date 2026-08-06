"use client";

import {
  FluentProvider,
  Text,
  Title1,
  webLightTheme
} from "@fluentui/react-components";

import { ExecutionList } from "./executions/execution-list";
import { RealExecutionForm } from "./executions/real-execution-form";
import { MacPairingPanel } from "./devices/mac-pairing-panel";
import { useCallback, useState } from "react";

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
  const handleReadyChange = useCallback((ready: boolean) => setPairedDeviceReady(ready), []);
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
          <div className="home-safety-note">
            <Text weight="semibold">本机安全边界</Text>
            <Text size={200}>原始资料与完整号码不会上传到网站</Text>
          </div>
        </header>

        <section className="home-workspace" aria-label="发起配置工作区">
          <section className="home-primary" aria-label="主要任务">
            <RealExecutionForm
              bootstrap={bootstrap}
              localLaunchEnabled={localLaunchEnabled}
              cloudPairingEnabled={cloudPairingEnabled}
              pairedDeviceReady={pairedDeviceReady}
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

            {cloudPairingEnabled ? (
              <MacPairingPanel onReadyChange={handleReadyChange} />
            ) : null}
            <ExecutionList executions={[]} />
          </aside>
        </section>
      </main>
    </FluentProvider>
  );
}
