"use client";

import {
  FluentProvider,
  Text,
  Title1,
  webLightTheme
} from "@fluentui/react-components";

import { DevelopmentSessionForm } from "./auth/development-session-form";
import { DemoExecution } from "./executions/demo-execution";
import { ExecutionList } from "./executions/execution-list";

export function HomeDashboard({
  developmentSessionEnabled,
  demoBootstrap
}: {
  developmentSessionEnabled: boolean;
  demoBootstrap?: {
    userId: string;
    workspaceId: string;
  };
}) {
  return (
    <FluentProvider theme={webLightTheme} className="dashboard-provider">
      <main className="dashboard-shell home-shell">
        <header className="home-header">
          <Text className="product-name">控制台</Text>
          <Title1 as="h1">百度云外呼一键配置</Title1>
          <Text>安全地准备、确认并跟踪每次外呼机器人配置。</Text>
        </header>
        {developmentSessionEnabled ? <DevelopmentSessionForm /> : null}
        {demoBootstrap ? <DemoExecution bootstrap={demoBootstrap} /> : null}
        <ExecutionList executions={[]} />
      </main>
    </FluentProvider>
  );
}
