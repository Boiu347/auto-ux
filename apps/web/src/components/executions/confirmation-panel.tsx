"use client";

import type {
  ConfirmationAction,
  ExecutionEvent,
  ExecutionPhase
} from "@app/contracts";
import {
  Button,
  Card,
  CardHeader,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  Title3
} from "@fluentui/react-components";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ExecutionSummary } from "./hybrid-progress";
import type {
  LocalAgentBridge,
  LocalAgentBridgeConnection,
  LocalAgentConfirmationDelivery
} from "./local-agent-bridge";

const confirmationByPhase: Partial<
  Record<
    ExecutionPhase,
    {
      action: ConfirmationAction;
      stepId: ExecutionEvent["stepId"];
      buttonLabel: string;
      title: string;
      detail: string;
    }
  >
> = {
  publish_confirm: {
    action: "publish",
    stepId: "publish.confirm",
    buttonLabel: "确认发布",
    title: "发布配置",
    detail: "确认后仅签发本次配置版本的发布凭据。"
  },
  numbers_confirm: {
    action: "import_numbers",
    stepId: "numbers.confirm",
    buttonLabel: "确认导入号码",
    title: "导入号码",
    detail: "确认后仅签发本次配置版本的号码导入凭据。"
  },
  dial_confirm: {
    action: "start_dial",
    stepId: "dial.confirm",
    buttonLabel: "确认开始外呼",
    title: "开始外呼",
    detail: "确认后仅签发本次配置版本的外呼启动凭据。"
  }
};

type Submission =
  | { state: "idle" }
  | { state: "issuing" }
  | { state: "delivering"; expiresAt: string }
  | { state: "delivery_error"; message: string; expiresAt: string }
  | { state: "acknowledged" }
  | { state: "refreshing"; message: string }
  | { state: "refresh_required"; message: string }
  | { state: "error"; message: string };

const disconnected: LocalAgentBridgeConnection = {
  connected: false,
  agentId: null
};

export function ConfirmationPanel({
  execution,
  event,
  bridge,
  refreshSummary
}: {
  execution: ExecutionSummary;
  event?: ExecutionEvent;
  bridge: LocalAgentBridge | null;
  refreshSummary: () => Promise<ExecutionSummary | undefined>;
}) {
  const [submission, setSubmission] = useState<Submission>({ state: "idle" });
  const bridgeSnapshot = useSyncExternalStore(
    bridge ? bridge.subscribe.bind(bridge) : subscribeDisconnected,
    () => serializeConnection(bridge?.getConnection() ?? disconnected),
    () => serializeConnection(disconnected)
  );
  const connection = deserializeConnection(bridgeSnapshot);
  const issuedGrant = useRef<LocalAgentConfirmationDelivery | undefined>(
    undefined
  );
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const gate = confirmationByPhase[execution.phase];
  const matchesPersistedGate =
    execution.status === "waiting_confirmation" &&
    event?.status === "waiting_confirmation" &&
    event.stepId === gate?.stepId;
  const bridgeMatchesExecution =
    connection.connected &&
    Boolean(execution.agentId) &&
    connection.agentId === execution.agentId;

  const clearIssuedGrant = () => {
    issuedGrant.current = undefined;
    if (expiryTimer.current) {
      clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      busy.current = false;
      clearIssuedGrant();
    };
  }, []);

  const stillWaitingForGate = (summary: ExecutionSummary): boolean =>
    Boolean(gate) &&
    summary.id === execution.id &&
    summary.configVersion === execution.configVersion &&
    summary.phase === execution.phase &&
    summary.status === "waiting_confirmation" &&
    event?.status === "waiting_confirmation" &&
    event.stepId === gate?.stepId;

  const refreshAfterConflict = async (message: string) => {
    setSubmission({ state: "refreshing", message });
    try {
      const summary = await refreshSummary();
      if (!mounted.current) {
        return;
      }
      if (summary && stillWaitingForGate(summary)) {
        setSubmission({ state: "error", message: `${message} 状态已刷新，可重试。` });
      } else if (!summary) {
        setSubmission({ state: "refresh_required", message });
      }
    } catch {
      if (mounted.current) {
        setSubmission({
          state: "refresh_required",
          message: `${message} 无法刷新执行状态。`
        });
      }
    } finally {
      busy.current = false;
    }
  };

  const scheduleExpiry = (grant: LocalAgentConfirmationDelivery) => {
    const delay = millisecondsUntil(grant.expiresAt);
    expiryTimer.current = setTimeout(() => {
      if (millisecondsUntil(grant.expiresAt) > 0) {
        scheduleExpiry(grant);
        return;
      }
      if (!mounted.current || issuedGrant.current !== grant) {
        return;
      }
      clearIssuedGrant();
      busy.current = false;
      void refreshAfterConflict("确认凭据已过期。");
    }, Math.min(delay, 2_147_483_647));
  };

  const deliver = async (grant: LocalAgentConfirmationDelivery) => {
    if (!bridge || !bridgeMatchesExecution) {
      setSubmission({
        state: "delivery_error",
        message: "本地代理桥未连接，凭据尚未交付。",
        expiresAt: grant.expiresAt
      });
      return;
    }
    setSubmission({ state: "delivering", expiresAt: grant.expiresAt });
    try {
      const acknowledgement = await bridge.deliverConfirmation(grant);
      if (
        !mounted.current ||
        issuedGrant.current !== grant ||
        acknowledgement.acknowledged !== true
      ) {
        return;
      }
      clearIssuedGrant();
      setSubmission({ state: "acknowledged" });
    } catch {
      if (mounted.current && issuedGrant.current === grant) {
        setSubmission({
          state: "delivery_error",
          message: "凭据交付失败，尚未由本地代理确认接收。",
          expiresAt: grant.expiresAt
        });
      }
    }
  };

  const submit = async () => {
    if (busy.current || !gate || !matchesPersistedGate) {
      return;
    }
    if (submission.state === "refresh_required") {
      busy.current = true;
      await refreshAfterConflict(submission.message);
      return;
    }
    if (!bridgeMatchesExecution) {
      return;
    }
    busy.current = true;
    const existing = issuedGrant.current;
    if (existing) {
      await deliver(existing);
      busy.current = false;
      return;
    }

    setSubmission({ state: "issuing" });
    try {
      const response = await fetch(
        `/api/executions/${encodeURIComponent(execution.id)}/confirmations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: gate.action,
            configVersion: execution.configVersion
          })
        }
      );
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        confirmation?: unknown;
      };
      if (!response.ok) {
        if (response.status === 409 || response.status === 410) {
          await refreshAfterConflict(
            confirmationError(response.status, payload.code)
          );
        } else if (mounted.current) {
          setSubmission({
            state: "error",
            message: confirmationError(response.status, payload.code)
          });
        }
        return;
      }
      const grant = parseIssuedConfirmation(
        payload.confirmation,
        execution,
        gate.action
      );
      if (!grant) {
        setSubmission({
          state: "error",
          message: "服务端返回的确认凭据与当前执行不匹配。"
        });
        return;
      }
      issuedGrant.current = grant;
      scheduleExpiry(grant);
      await deliver(grant);
    } catch {
      if (mounted.current) {
        setSubmission({
          state: "error",
          message: "确认请求失败。执行状态未变更，请检查连接后重试。"
        });
      }
    } finally {
      busy.current = false;
    }
  };

  if (!gate || !matchesPersistedGate) {
    return (
      <Card className="dashboard-panel confirmation-panel">
        <CardHeader header={<Title3 as="h2">下一确认门</Title3>} />
        <Text>无匹配的待确认动作</Text>
      </Card>
    );
  }

  const inProgress =
    submission.state === "issuing" ||
    submission.state === "delivering" ||
    submission.state === "refreshing";
  const buttonLabel =
    submission.state === "delivery_error"
      ? "重试交付确认"
      : submission.state === "refresh_required"
        ? "刷新执行状态"
        : submission.state === "issuing"
          ? "正在签发确认"
          : submission.state === "delivering"
            ? "正在交付确认"
            : submission.state === "refreshing"
              ? "正在刷新状态"
              : gate.buttonLabel;

  return (
    <Card className="dashboard-panel confirmation-panel">
      <CardHeader
        header={<Title3 as="h2">下一确认门</Title3>}
        description={<Text weight="semibold">{gate.title}</Text>}
      />
      <Text>{gate.detail}</Text>
      {!bridgeMatchesExecution ? (
        <Text role="status">本地代理桥未连接</Text>
      ) : null}
      <Button
        appearance="primary"
        disabled={
          !bridgeMatchesExecution ||
          inProgress ||
          submission.state === "acknowledged"
        }
        onClick={submit}
      >
        {buttonLabel}
      </Button>
      <div aria-live="polite" aria-atomic="true">
        {submission.state === "acknowledged" ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>本地代理已确认接收</MessageBarTitle>
              等待本地代理提交持久化执行事件，界面不会提前标记动作成功。
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {submission.state === "delivering" ? (
          <MessageBar intent="info">
            <MessageBarBody>
              凭据已签发，正在交付给当前执行的本地代理。
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {"message" in submission ? (
          <MessageBar intent="error">
            <MessageBarBody role="alert">
              <MessageBarTitle>确认未生效</MessageBarTitle>
              {submission.message}
            </MessageBarBody>
          </MessageBar>
        ) : null}
      </div>
    </Card>
  );
}

function subscribeDisconnected(): () => void {
  return () => undefined;
}

function serializeConnection(connection: LocalAgentBridgeConnection): string {
  return `${connection.connected ? "1" : "0"}:${connection.agentId ?? ""}`;
}

function deserializeConnection(value: string): LocalAgentBridgeConnection {
  const separator = value.indexOf(":");
  const agentId = value.slice(separator + 1);
  return {
    connected: value.slice(0, separator) === "1",
    agentId: agentId || null
  };
}

function millisecondsUntil(expiresAt: string): number {
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

function parseIssuedConfirmation(
  value: unknown,
  execution: ExecutionSummary,
  action: ConfirmationAction
): LocalAgentConfirmationDelivery | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<LocalAgentConfirmationDelivery>;
  const expiresAt =
    typeof candidate.expiresAt === "string"
      ? new Date(candidate.expiresAt).getTime()
      : Number.NaN;
  if (
    candidate.action !== action ||
    candidate.executionId !== execution.id ||
    candidate.configVersion !== execution.configVersion ||
    typeof candidate.confirmationId !== "string" ||
    !/^confirm:[a-f0-9]{16,64}$/.test(candidate.confirmationId) ||
    typeof candidate.token !== "string" ||
    !/^confirm_token:[a-f0-9]{64}$/.test(candidate.token) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    return null;
  }
  return candidate as LocalAgentConfirmationDelivery;
}

function confirmationError(status: number, code?: string): string {
  if (
    status === 409 ||
    status === 410 ||
    code === "CONFIRMATION_INVALID" ||
    code === "CONFIRMATION_CONFIG_MISMATCH" ||
    code === "CONFIRMATION_ACTION_MISMATCH"
  ) {
    return `确认已失效或执行状态已变化。服务端返回：${code ?? status}`;
  }
  return `确认请求失败。服务端返回：${code ?? status}`;
}
