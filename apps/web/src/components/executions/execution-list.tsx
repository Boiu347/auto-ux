import {
  Button,
  Card,
  CardHeader,
  Text,
  Title2
} from "@fluentui/react-components";
import Link from "next/link";

import type { ExecutionSummary } from "./hybrid-progress";

export function ExecutionList({
  executions
}: {
  executions: ExecutionSummary[];
}) {
  return (
    <section
      className="execution-list-section"
      aria-labelledby="execution-list-heading"
    >
      <Title2 as="h2" id="execution-list-heading">
        执行列表
      </Title2>

      {executions.length === 0 ? (
        <Card className="dashboard-panel empty-list-panel">
          <CardHeader header={<Text weight="semibold">暂无执行任务</Text>} />
          <Text>创建并确认配置草案后，才能在 Codex 中开始执行。</Text>
          <Button type="button" disabled>
            在 Codex 中开始执行
          </Button>
        </Card>
      ) : (
        <div className="execution-list">
          {executions.map((execution) => (
            <Card className="dashboard-panel execution-row" key={execution.id}>
              <CardHeader
                header={<Text weight="semibold">{execution.id}</Text>}
                description={
                  <Text>
                    {execution.phase} / {execution.status}
                  </Text>
                }
                action={
                  <Link href={`/executions/${execution.id}`}>查看执行</Link>
                }
              />
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
