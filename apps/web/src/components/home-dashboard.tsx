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
          <Text className="product-name">控制台</Text>
          <Title1 as="h1">百度云外呼一键配置</Title1>
          <Text>安全地准备、确认并跟踪每次外呼机器人配置。</Text>
        </header>
        {cloudPairingEnabled ? (
          <MacPairingPanel onReadyChange={handleReadyChange} />
        ) : null}
        <RealExecutionForm
          bootstrap={bootstrap}
          localLaunchEnabled={localLaunchEnabled}
          cloudPairingEnabled={cloudPairingEnabled}
          pairedDeviceReady={pairedDeviceReady}
        />
        <ExecutionList executions={[]} />
      </main>
    </FluentProvider>
  );
}
