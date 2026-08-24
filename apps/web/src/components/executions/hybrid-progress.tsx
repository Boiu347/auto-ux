"use client";

import type {
  ExecutionEvent,
  ExecutionPhase,
  ExecutionStatus
} from "@app/contracts";
import {
  Button,
  FluentProvider,
  MessageBar,
  MessageBarBody,
  Skeleton,
  SkeletonItem,
  Text,
  Title1,
  webDarkTheme,
  webLightTheme
} from "@fluentui/react-components";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { publicPath } from "../../lib/public-path";
import { ConfirmationPanel } from "./confirmation-panel";
import { DeviceDeliveryStatus } from "../devices/device-delivery-status";
import { CurrentActionCard } from "./current-action-card";
import { EvidenceCard } from "./evidence-card";
import {
  resolveLocalAgentBridge,
  type LocalAgentBridge
} from "./local-agent-bridge";

export interface ExecutionSummary {
  id: string;
  configVersion: number;
  status: ExecutionStatus;
  phase: ExecutionPhase;
  targetPolicy: "create_only";
  mode: "simulator" | "real_codex";
  updatedAt: string;
  agentId: string | null;
  agentHeartbeatAt: string | null;
}

export interface PersistedExecutionEvent {
  cursor: string;
  event: ExecutionEvent;
}

type InitialEvent = PersistedExecutionEvent | ExecutionEvent;
type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export function HybridProgress({
  executionId,
  execution: initialExecution,
  initialEvents = [],
  loading = false,
  loadError,
  localAgentBridge
}: {
  executionId?: string;
  execution?: ExecutionSummary;
  initialEvents?: InitialEvent[];
  loading?: boolean;
  loadError?: string;
  localAgentBridge?: LocalAgentBridge | null;
}) {
  const [execution, setExecution] = useState(initialExecution);
  const [events, setEvents] = useState(() => normalizeEvents(initialEvents));
  const [requestState, setRequestState] = useState<
    "idle" | "loading" | "error"
  >(initialExecution || !executionId ? "idle" : "loading");
  const [requestError, setRequestError] = useState<string | undefined>();
  const [connection, setConnection] =
    useState<ConnectionState>("connecting");
  const [isDark, setIsDark] = useState(false);
  const latestCursor = useRef(lastPersistedCursor(normalizeEvents(initialEvents)));
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  const refreshSequence = useRef(0);
  const mounted = useRef(false);
  const seenEvents = useRef(
    new Set(normalizeEvents(initialEvents).map(persistedEventKey))
  );
  const bridge =
    execution?.mode === "real_codex"
      ? null
      : localAgentBridge === undefined
      ? resolveLocalAgentBridge()
      : localAgentBridge;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshSequence.current += 1;
      refreshController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const query =
      typeof window === "undefined"
        ? undefined
        : window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) {
      return;
    }
    const updateTheme = () => setIsDark(query.matches);
    updateTheme();
    query.addEventListener?.("change", updateTheme);
    return () => query.removeEventListener?.("change", updateTheme);
  }, []);

  const refreshSummary = useCallback(
    async (showLoading = false): Promise<ExecutionSummary | undefined> => {
      const id = initialExecution?.id ?? executionId;
      if (!id) {
        return undefined;
      }
      const sequence = refreshSequence.current + 1;
      refreshSequence.current = sequence;
      refreshController.current?.abort();
      const controller = new AbortController();
      refreshController.current = controller;
      if (showLoading) {
        setRequestState("loading");
        setRequestError(undefined);
      }
      try {
        const response = await fetch(
          publicPath(`/api/executions/${encodeURIComponent(id)}`),
          {
            signal: controller.signal,
            headers: { accept: "application/json" }
          }
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as {
          execution: ExecutionSummary;
          events: PersistedExecutionEvent[];
        };
        if (!mounted.current || sequence !== refreshSequence.current) {
          return undefined;
        }
        const normalized = normalizeEvents(payload.events);
        setExecution(payload.execution);
        setEvents((current) => mergeEvents(current, normalized));
        for (const persisted of normalized) {
          seenEvents.current.add(persistedEventKey(persisted));
        }
        const cursor = lastPersistedCursor(normalized);
        if (cursor) {
          latestCursor.current = cursor;
        }
        setRequestState("idle");
        setRequestError(undefined);
        return payload.execution;
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return undefined;
        }
        if (showLoading && mounted.current) {
          setRequestError("无法读取执行记录");
          setRequestState("error");
        }
        throw error;
      }
    },
    [executionId, initialExecution?.id]
  );

  useEffect(() => {
    if (initialExecution || !executionId) {
      return;
    }
    const timer = setTimeout(() => {
      void refreshSummary(true).catch(() => undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [executionId, initialExecution, refreshSummary]);

  useEffect(() => {
    const id = execution?.id ?? executionId;
    if (
      !id ||
      loading ||
      loadError ||
      requestState !== "idle" ||
      typeof EventSource === "undefined"
    ) {
      return;
    }

    let disposed = false;
    let source: EventSource | undefined;

    const connect = () => {
      if (disposed) {
        return;
      }
      const query = latestCursor.current
        ? `?cursor=${encodeURIComponent(latestCursor.current)}`
        : "";
      source = new EventSource(
        publicPath(`/api/executions/${encodeURIComponent(id)}/events${query}`)
      );
      setConnection(latestCursor.current ? "reconnecting" : "connecting");
      source.onopen = () => setConnection("connected");
      source.addEventListener("execution-step", (message) => {
        const event = message as MessageEvent<string>;
        try {
          const parsed = JSON.parse(event.data) as ExecutionEvent;
          const cursor = event.lastEventId || undefined;
          const persisted = { cursor, event: parsed };
          const key = persistedEventKey(persisted);
          if (seenEvents.current.has(key)) {
            return;
          }
          seenEvents.current.add(key);
          if (cursor) {
            latestCursor.current = cursor;
          }
          setEvents((current) => appendUnique(current, persisted));
          setConnection("connected");
          void refreshSummary().catch(() => undefined);
        } catch {
          setConnection("disconnected");
        }
      });
      source.onerror = () => {
        source?.close();
        setConnection("reconnecting");
        reconnectTimer.current = setTimeout(connect, 1_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [
    execution?.id,
    executionId,
    loadError,
    loading,
    refreshSummary,
    requestState
  ]);

  const currentEvent = events.at(-1)?.event;
  const lastCheckpoint = [...events]
    .reverse()
    .find(({ event }) => event.evidence.kind === "checkpoint")?.event;
  const effectiveLoading = loading || requestState === "loading";
  const effectiveError = loadError ?? requestError;
  const providerTheme = isDark ? webDarkTheme : webLightTheme;

  if (effectiveLoading) {
    return (
      <FluentProvider theme={providerTheme} className="dashboard-provider">
        <main className="dashboard-shell">
          <div role="status" aria-live="polite" className="loading-state">
            <Text weight="semibold">正在加载执行记录</Text>
            <Skeleton aria-label="正在加载执行摘要">
              <SkeletonItem size={32} />
              <SkeletonItem size={96} />
              <SkeletonItem size={96} />
            </Skeleton>
          </div>
        </main>
      </FluentProvider>
    );
  }

  if (effectiveError || !execution) {
    return (
      <FluentProvider theme={providerTheme} className="dashboard-provider">
        <main className="dashboard-shell">
          <MessageBar intent="error">
            <MessageBarBody role="alert">
              {effectiveError ?? "缺少持久化执行摘要"}
            </MessageBarBody>
          </MessageBar>
        </main>
      </FluentProvider>
    );
  }

  return (
    <FluentProvider theme={providerTheme} className="dashboard-provider">
      <main className="dashboard-shell">
        <header className="dashboard-header">
          <div>
            <Text className="product-name">执行控制台</Text>
            <Title1 as="h1">{execution.id}</Title1>
          </div>
          <ConnectionStatus state={connection} />
        </header>

        <div className="dashboard-layout">
          <PhaseRail events={events.map(({ event }) => event)} />
          <section className="dashboard-content" aria-label="当前执行详情">
            {execution.mode === "real_codex" ? (
              <DeviceDeliveryStatus executionId={execution.id} />
            ) : null}
            {events.length === 0 ? (
              <div className="empty-events">
                <Text weight="semibold">暂无持久化执行事件</Text>
                <Text>等待本地代理写入第一条可验证事件。</Text>
              </div>
            ) : null}
            <CurrentActionCard execution={execution} event={currentEvent} />
            <EvidenceCard
              event={currentEvent}
              lastCheckpoint={lastCheckpoint}
            />
            {execution.mode === "real_codex" ? (
              <RemoteConfirmationPanel execution={execution} event={currentEvent} />
            ) : (
              <ConfirmationPanel
                key={`${execution.id}:${execution.configVersion}:${execution.phase}:${execution.status}`}
                execution={execution}
                event={currentEvent}
                bridge={bridge}
                refreshSummary={refreshSummary}
              />
            )}
          </section>
        </div>
      </main>
    </FluentProvider>
  );
}

const remoteConfirmationByPhase: Partial<Record<ExecutionPhase, {
  action: "publish" | "import_numbers" | "start_dial";
  approve: string;
  reject: string;
}>> = {
  publish_confirm: { action: "publish", approve: "确认发布", reject: "拒绝发布" },
  numbers_confirm: { action: "import_numbers", approve: "确认导入号码", reject: "拒绝导入号码" },
  dial_confirm: { action: "start_dial", approve: "确认开始外呼", reject: "拒绝开始外呼" }
};

function RemoteConfirmationPanel({
  execution,
  event
}: {
  execution: ExecutionSummary;
  event?: ExecutionEvent;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ action: string; message: string }>();
  const waiting =
    execution.status === "waiting_confirmation" &&
    event?.status === "waiting_confirmation";
  const current = remoteConfirmationByPhase[execution.phase];
  useEffect(() => {
    if (!waiting || !current) return;
    let disposed = false;
    void fetch(publicPath(`/api/executions/${encodeURIComponent(execution.id)}/decision?action=${current.action}`))
      .then(async (response) => response.status === 204 ? null : response.json())
      .then((value: { decision?: string } | null) => {
        if (!disposed && value?.decision) {
          setResult({
            action: current.action,
            message: value.decision === "approved" ? "已确认，正在通知 Codex" : "已拒绝，正在通知 Codex 停止"
          });
        }
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [current, execution.id, waiting]);
  const decide = async (decision: "approved" | "rejected") => {
    if (!current || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch(publicPath(`/api/executions/${encodeURIComponent(execution.id)}/decision`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: current.action, decision })
      });
      const value = (await response.json().catch(() => ({}))) as { decision?: string; code?: string };
      if (!response.ok) throw new Error(value.code ?? "确认提交失败");
      setResult({
        action: current.action,
        message: value.decision === "approved" ? "已确认，正在通知 Codex" : "已拒绝，正在通知 Codex 停止"
      });
    } catch (cause) {
      setResult({
        action: current.action,
        message: cause instanceof Error ? cause.message : "确认提交失败"
      });
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="dashboard-panel real-confirmation-notice" aria-live="polite">
      <Text as="h2" weight="semibold" size={500}>下一确认门</Text>
      <Text>{waiting && current ? `${current.approve}？也可以在 Codex 中确认，先提交的一端生效。` : "当前无需确认"}</Text>
      {waiting && current && result?.action !== current.action ? (
        <div className="confirmation-actions">
          <Button appearance="primary" disabled={submitting} onClick={() => void decide("approved")}>{current.approve}</Button>
          <Button disabled={submitting} onClick={() => void decide("rejected")}>{current.reject}</Button>
        </div>
      ) : null}
      {result?.action === current?.action ? <MessageBar><MessageBarBody>{result?.message}</MessageBarBody></MessageBar> : null}
      <Text size={200}>发布、号码导入和开始外呼仍需分别确认，单次确认不会跨步骤复用。</Text>
    </section>
  );
}

function ConnectionStatus({ state }: { state: ConnectionState }) {
  const label: Record<ConnectionState, string> = {
    connecting: "正在连接事件流",
    connected: "事件流已连接",
    reconnecting: "正在重新连接",
    disconnected: "事件流已断开"
  };
  return (
    <div
      className={`connection-status connection-${state}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {label[state]}
    </div>
  );
}

const phases: Array<{
  stepId: ExecutionEvent["stepId"];
  label: string;
}> = [
  { stepId: "source.parse", label: "解析配置来源" },
  { stepId: "draft.confirm", label: "确认配置草案" },
  { stepId: "environment.preflight", label: "环境预检" },
  { stepId: "robot.create", label: "创建外呼机器人" },
  { stepId: "field.configure", label: "写入机器人配置" },
  { stepId: "voice.preflight", label: "检查语音能力" },
  { stepId: "publish.confirm", label: "确认发布配置" },
  { stepId: "publish.verify", label: "核验发布结果" },
  { stepId: "numbers.confirm", label: "确认导入号码" },
  { stepId: "dial.confirm", label: "确认启动外呼" },
  { stepId: "dial.verify", label: "核验外呼结果" },
  { stepId: "complete", label: "记录执行完成" }
];

function PhaseRail({ events }: { events: ExecutionEvent[] }) {
  const latestByStep = useMemo(() => {
    const map = new Map<ExecutionEvent["stepId"], ExecutionEvent>();
    for (const event of events) {
      map.set(event.stepId, event);
    }
    return map;
  }, [events]);

  return (
    <nav className="phase-rail" aria-label="执行阶段">
      <Text as="h2" weight="semibold" size={400}>
        阶段
      </Text>
      <ol>
        {phases.map((phase) => {
          const event = latestByStep.get(phase.stepId);
          return (
            <li
              key={phase.stepId}
              className={event ? `phase-${event.status}` : "phase-unobserved"}
            >
              <span>{phase.label}</span>
              <small>{event ? statusText(event.status) : "无记录"}</small>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function statusText(status: ExecutionStatus): string {
  return {
    pending: "等待开始",
    running: "执行中",
    waiting_confirmation: "等待确认",
    succeeded: "已验证",
    failed: "失败",
    rolled_back: "已回滚",
    unknown: "未知"
  }[status];
}

function normalizeEvents(initialEvents: InitialEvent[]) {
  const normalized = initialEvents.map((item) =>
    "event" in item ? { cursor: item.cursor, event: item.event } : { event: item }
  );
  return normalized.reduce<
    Array<{ cursor?: string; event: ExecutionEvent }>
  >(appendUnique, []);
}

function appendUnique(
  current: Array<{ cursor?: string; event: ExecutionEvent }>,
  candidate: { cursor?: string; event: ExecutionEvent }
) {
  const duplicate = current.some((item) => {
    if (candidate.cursor && item.cursor) {
      return candidate.cursor === item.cursor;
    }
    return eventKey(candidate.event) === eventKey(item.event);
  });
  return duplicate ? current : [...current, candidate];
}

function mergeEvents(
  current: Array<{ cursor?: string; event: ExecutionEvent }>,
  candidates: Array<{ cursor?: string; event: ExecutionEvent }>
) {
  return candidates.reduce(appendUnique, current);
}

function persistedEventKey(event: {
  cursor?: string;
  event: ExecutionEvent;
}): string {
  return event.cursor ? `cursor:${event.cursor}` : `event:${eventKey(event.event)}`;
}

function eventKey(event: ExecutionEvent): string {
  return [
    event.executionId,
    event.stepId,
    event.attempt,
    event.occurredAt
  ].join(":");
}

function lastPersistedCursor(
  events: Array<{ cursor?: string; event: ExecutionEvent }>
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.cursor) {
      return events[index].cursor;
    }
  }
  return undefined;
}
