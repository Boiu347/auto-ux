"use client";

import {
  FluentProvider,
  Text,
  Title1,
  webLightTheme
} from "@fluentui/react-components";

import { ExecutionList } from "../components/executions/execution-list";
import { DevelopmentSessionForm } from "../components/auth/development-session-form";

export default function HomePage() {
  return (
    <FluentProvider theme={webLightTheme} className="dashboard-provider">
      <main className="dashboard-shell home-shell">
        <header className="home-header">
          <Text className="product-name">控制台</Text>
          <Title1 as="h1">百度云外呼一键配置</Title1>
          <Text>
            安全地准备、确认并跟踪每次外呼机器人配置。
          </Text>
        </header>
        {process.env.NODE_ENV !== "production" ? (
          <DevelopmentSessionForm />
        ) : null}
        <ExecutionList executions={[]} />
      </main>
    </FluentProvider>
  );
}
