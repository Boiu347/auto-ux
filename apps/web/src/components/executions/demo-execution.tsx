"use client";

import { Button, Card, CardHeader, MessageBar, MessageBarBody, Text } from "@fluentui/react-components";
import Link from "next/link";
import { useState } from "react";

export function DemoExecution({
  bootstrap
}: {
  bootstrap: {
    userId: string;
    workspaceId: string;
  };
}) {
  const [executionId, setExecutionId] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const loadDemo = async () => {
    if (loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const session = await fetch("/api/dev/session", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          userId: bootstrap.userId,
          workspaceId: bootstrap.workspaceId
        })
      });
      if (!session.ok) {
        throw new Error("session unavailable");
      }
      const response = await fetch("/api/dev/demo", { method: "POST" });
      const body = (await response.json()) as {
        execution?: { id?: unknown };
      };
      if (!response.ok || typeof body.execution?.id !== "string") {
        throw new Error("demo unavailable");
      }
      setExecutionId(body.execution.id);
    } catch {
      setError("演示任务尚未准备好，请检查本地启动日志。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="dashboard-panel demo-execution-card">
      <CardHeader
        header={<Text weight="semibold">本地纵向演示</Text>}
        description={<Text>只运行模拟器，不会访问真实飞书、百度云或电话。</Text>}
      />
      <Button type="button" appearance="primary" disabled={loading} onClick={loadDemo}>
        {loading ? "正在连接演示任务" : "创建演示任务"}
      </Button>
      {executionId ? (
        <Link href={`/executions/${encodeURIComponent(executionId)}`}>查看任务 {executionId}</Link>
      ) : null}
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody role="alert">{error}</MessageBarBody>
        </MessageBar>
      ) : null}
    </Card>
  );
}
