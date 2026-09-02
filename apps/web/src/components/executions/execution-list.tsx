import {
  Button,
  Badge,
  Card,
  Text,
  Title2
} from "@fluentui/react-components";
import Link from "next/link";

import type { TaskFormValues } from "./real-execution-form";

export type TaskHistoryItem = {
  id: string;
  robotName: string;
  createdAt: string;
  updatedAt: string;
  phase: string;
  status: string;
  input: TaskFormValues | null;
};

export function ExecutionList({
  executions
  , loading = false
  , error
  , onCopy
}: {
  executions: TaskHistoryItem[];
  loading?: boolean;
  error?: string;
  onCopy?: (input: TaskFormValues) => void;
}) {
  return (
    <section
      className="execution-list-section"
      aria-labelledby="execution-list-heading"
    >
      <Title2 as="h2" id="execution-list-heading">
        最近任务
      </Title2>

      {loading ? (
        <div className="empty-list-panel" role="status" aria-live="polite">
          <Text weight="semibold">正在读取历史记录</Text>
          <Text>同账号的任务和草稿会在这里恢复。</Text>
        </div>
      ) : error ? (
        <div className="empty-list-panel" role="alert">
          <Text weight="semibold">历史记录暂不可用</Text>
          <Text>{error}</Text>
        </div>
      ) : executions.length === 0 ? (
        <div className="empty-list-panel">
          <Text weight="semibold">暂无历史任务</Text>
          <Text>任务创建后会按当前账号跨设备保存在这里。</Text>
        </div>
      ) : (
        <div className="execution-list">
          {executions.map((execution) => (
            <Card className="dashboard-panel execution-row" key={execution.id}>
              <div className="execution-row-copy">
                <Text weight="semibold">{execution.robotName}</Text>
                <div className="execution-row-meta">
                  <Badge appearance="tint" color={historyStatusColor(execution.status)}>
                    {historyStatusText(execution.status)}
                  </Badge>
                  <Text size={200}>{phaseText(execution.phase)}</Text>
                  <Text size={200}>{formatDate(execution.createdAt)}</Text>
                </div>
              </div>
              <div className="execution-row-actions">
                <Button
                  appearance="subtle"
                  size="small"
                  disabled={!execution.input}
                  title={execution.input ? undefined : "旧任务没有可复用的输入快照"}
                  onClick={() => execution.input && onCopy?.(execution.input)}
                >
                  复制为新任务
                </Button>
                <Link href={`/executions/${execution.id}`}>查看进度</Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function historyStatusColor(status: string): "brand" | "danger" | "warning" | "subtle" {
  if (status === "failed") return "danger";
  if (status === "waiting_confirmation") return "warning";
  if (status === "running") return "brand";
  return "subtle";
}

function historyStatusText(status: string): string {
  return {
    pending: "等待开始",
    running: "正在执行",
    waiting_confirmation: "等待确认",
    succeeded: "已完成",
    failed: "执行失败",
    rolled_back: "已回滚",
    unknown: "需要检查"
  }[status] ?? status;
}

function phaseText(phase: string): string {
  return {
    source_parse: "整理配置来源",
    draft_confirm: "确认配置草案",
    environment_preflight: "检查执行环境",
    robot_create: "创建机器人",
    field_configure: "写入机器人配置",
    voice_preflight: "检查语音能力",
    publish_confirm: "等待发布确认",
    publish_verify: "核验发布结果",
    numbers_confirm: "等待导号确认",
    dial_confirm: "等待拨号确认",
    call_verify: "核验通话结果",
    complete: "执行完成"
  }[phase] ?? phase;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
}
