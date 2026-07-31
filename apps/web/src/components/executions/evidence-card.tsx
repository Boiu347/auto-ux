import type { ExecutionEvent, ExecutionEvidence } from "@app/contracts";
import {
  Card,
  CardHeader,
  Text,
  Title3
} from "@fluentui/react-components";

export function EvidenceCard({
  event,
  lastCheckpoint
}: {
  event?: ExecutionEvent;
  lastCheckpoint?: ExecutionEvent;
}) {
  return (
    <Card className="dashboard-panel evidence-card">
      <CardHeader header={<Title3 as="h2">执行证据</Title3>} />

      {event ? (
        <div className="evidence-stack">
          <section aria-labelledby="current-evidence-heading">
            <Text
              as="h3"
              id="current-evidence-heading"
              weight="semibold"
              size={300}
            >
              当前证据
            </Text>
            <p className="evidence-summary">
              {formatEvidence(event.evidence)}
            </p>
          </section>

          <section aria-labelledby="last-checkpoint-heading">
            <Text
              as="h3"
              id="last-checkpoint-heading"
              weight="semibold"
              size={300}
            >
              最近检查点
            </Text>
            <p className="evidence-summary">
              {lastCheckpoint
                ? `${lastCheckpoint.evidence.kind === "checkpoint" ? `${lastCheckpoint.evidence.summary.phase} / ${lastCheckpoint.evidence.summary.status}` : formatEvidence(lastCheckpoint.evidence)}`
                : "暂无持久化检查点"}
            </p>
          </section>
        </div>
      ) : (
        <Text>暂无持久化证据</Text>
      )}
    </Card>
  );
}

export function formatEvidence(evidence: ExecutionEvidence): string {
  if (evidence.kind === "checkpoint") {
    return `${evidence.summary.phase} / ${evidence.summary.status}`;
  }
  if (evidence.kind === "field_readback") {
    return `${evidence.summary.field} / ${evidence.summary.result}`;
  }
  if (evidence.kind === "platform_record") {
    return evidence.summary.outcome;
  }

  const samples =
    evidence.summary.maskedSamples.length > 0
      ? `；脱敏样例 ${evidence.summary.maskedSamples.join("、")}`
      : "";
  return `总数 ${evidence.summary.total}，有效 ${evidence.summary.valid}，无效 ${evidence.summary.invalid}，重复 ${evidence.summary.duplicates}${samples}`;
}
