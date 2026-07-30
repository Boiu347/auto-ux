import type { ExecutionEvent, ExecutionStatus } from "@app/contracts";
import {
  Badge,
  Card,
  CardHeader,
  Text,
  Title3
} from "@fluentui/react-components";

import type { ExecutionSummary } from "./hybrid-progress";

const statusLabels: Record<ExecutionStatus, string> = {
  pending: "等待开始",
  running: "正在执行",
  waiting_confirmation: "等待确认",
  succeeded: "已完成",
  failed: "执行失败",
  rolled_back: "已回滚",
  unknown: "未知"
};

export function CurrentActionCard({
  execution,
  event
}: {
  execution: ExecutionSummary;
  event?: ExecutionEvent;
}) {
  const status = event?.status ?? execution.status;

  return (
    <Card className="dashboard-panel current-action-card">
      <CardHeader
        header={<Title3 as="h2">当前动作</Title3>}
        description={
          <Badge appearance="tint" color={statusColor(status)}>
            {statusLabels[status]}
          </Badge>
        }
      />

      <dl className="fact-grid">
        <Fact label="当前步骤" value={event?.stepId ?? "暂无持久化事件"} />
        <Fact label="执行阶段" value={execution.phase} />
        <Fact label="当前目标" value={execution.targetPolicy} />
        <Fact label="配置版本" value={`配置版本 ${execution.configVersion}`} />
        <Fact
          label="Agent 心跳"
          value={
            execution.agentHeartbeatAt
              ? formatDate(execution.agentHeartbeatAt)
              : "无持久化记录"
          }
        />
        <Fact
          label="下一动作"
          value={event?.nextAction ?? "暂无持久化下一动作"}
        />
      </dl>

      {event?.errorCode ? (
        <div className="error-fact" role="alert">
          <Text weight="semibold">错误事实</Text>
          <code>{event.errorCode}</code>
        </div>
      ) : null}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function statusColor(
  status: ExecutionStatus
): "brand" | "danger" | "warning" | "informative" | "subtle" {
  if (status === "failed") {
    return "danger";
  }
  if (status === "waiting_confirmation") {
    return "warning";
  }
  if (status === "running") {
    return "brand";
  }
  if (status === "unknown") {
    return "informative";
  }
  return "subtle";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium"
      }).format(date);
}
