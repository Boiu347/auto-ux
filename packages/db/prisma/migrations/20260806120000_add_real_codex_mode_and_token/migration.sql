CREATE TYPE "ExecutionMode" AS ENUM ('simulator', 'real_codex');

ALTER TABLE "Execution"
  ADD COLUMN "mode" "ExecutionMode" NOT NULL DEFAULT 'simulator',
  ADD COLUMN "agentAccessTokenHash" TEXT,
  ADD COLUMN "agentAccessExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Execution_agentAccessTokenHash_key"
  ON "Execution"("agentAccessTokenHash");

CREATE INDEX "Execution_agentAccessExpiresAt_idx"
  ON "Execution"("agentAccessExpiresAt");
