"use client";

import {
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Text
} from "@fluentui/react-components";
import { FormEvent, useState } from "react";

export function DevelopmentSessionForm() {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: data.get("userId"),
          workspaceId: data.get("workspaceId")
        })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      window.location.reload();
    } catch {
      setError("无法建立开发会话，请检查标识和 DEV_SESSION_SECRET。 ");
      setSubmitting(false);
    }
  };

  return (
    <Card className="dashboard-panel development-session-card">
      <CardHeader
        header={<Text weight="semibold">开发会话</Text>}
        description={<Text>仅用于本地开发，生产环境使用飞书 OAuth。</Text>}
      />
      <form onSubmit={submit} className="development-session-form">
        <Field label="用户 ID" required>
          <Input name="userId" required autoComplete="username" />
        </Field>
        <Field label="工作区 ID" required>
          <Input name="workspaceId" required autoComplete="organization" />
        </Field>
        <Button type="submit" appearance="primary" disabled={submitting}>
          {submitting ? "正在建立会话" : "建立开发会话"}
        </Button>
      </form>
      <div aria-live="polite">
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody role="alert">{error}</MessageBarBody>
          </MessageBar>
        ) : null}
      </div>
    </Card>
  );
}
