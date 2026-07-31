import { HybridProgress } from "../../../components/executions/hybrid-progress";

export default async function ExecutionPage({
  params
}: {
  params: Promise<{ executionId: string }>;
}) {
  const { executionId } = await params;
  return <HybridProgress executionId={executionId} initialEvents={[]} />;
}
