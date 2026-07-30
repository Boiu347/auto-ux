CREATE TYPE "ExecutionStatus" AS ENUM ('pending','running','waiting_confirmation','succeeded','failed','rolled_back','unknown');
CREATE TYPE "ExecutionPhase" AS ENUM ('source_parse','draft_confirm','environment_preflight','robot_create','field_configure','voice_preflight','publish_confirm','publish_verify','numbers_confirm','dial_confirm','call_verify','complete');
CREATE TYPE "TargetPolicy" AS ENUM ('create_only');
CREATE TYPE "OperationStatus" AS ENUM ('running','succeeded','failed');
CREATE TYPE "ConfirmationAction" AS ENUM ('publish','import_numbers','start_dial');

CREATE TABLE "WorkspaceMember" ("userId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("userId", "workspaceId"));
INSERT INTO "WorkspaceMember" ("userId", "workspaceId") SELECT DISTINCT "userId", "workspaceId" FROM "Execution" ON CONFLICT DO NOTHING;

ALTER TABLE "Execution" ALTER COLUMN "status" TYPE "ExecutionStatus" USING "status"::"ExecutionStatus";
ALTER TABLE "Execution" ALTER COLUMN "phase" TYPE "ExecutionPhase" USING "phase"::"ExecutionPhase";
ALTER TABLE "Execution" ALTER COLUMN "targetPolicy" TYPE "TargetPolicy" USING "targetPolicy"::"TargetPolicy";
ALTER TABLE "ExecutionOperation" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ExecutionOperation" ALTER COLUMN "status" TYPE "OperationStatus" USING "status"::"OperationStatus";
ALTER TABLE "Confirmation" ALTER COLUMN "action" TYPE "ConfirmationAction" USING "action"::"ConfirmationAction";

DROP INDEX "ExecutionOperation_executionId_fingerprint_key";
CREATE UNIQUE INDEX "Execution_id_workspaceId_key" ON "Execution"("id", "workspaceId");
CREATE UNIQUE INDEX "ExecutionOperation_executionId_fingerprint_attempt_key" ON "ExecutionOperation"("executionId", "fingerprint", "attempt");
CREATE UNIQUE INDEX "ExecutionOperation_active_fingerprint_key" ON "ExecutionOperation"("executionId", "fingerprint") WHERE "status" IN ('running','succeeded');
CREATE UNIQUE INDEX "LocalAgent_id_workspaceId_key" ON "LocalAgent"("id", "workspaceId");

ALTER TABLE "Execution" ADD CONSTRAINT "Execution_member_fkey" FOREIGN KEY ("userId", "workspaceId") REFERENCES "WorkspaceMember"("userId", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "Confirmation" ADD CONSTRAINT "Confirmation_member_fkey" FOREIGN KEY ("userId", "workspaceId") REFERENCES "WorkspaceMember"("userId", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "Confirmation" ADD CONSTRAINT "Confirmation_execution_scope_fkey" FOREIGN KEY ("executionId", "userId", "workspaceId") REFERENCES "Execution"("id", "userId", "workspaceId") ON DELETE CASCADE;
ALTER TABLE "RobotBinding" ADD CONSTRAINT "RobotBinding_agent_scope_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "LocalAgent"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "RobotBinding" ADD CONSTRAINT "RobotBinding_execution_scope_fkey" FOREIGN KEY ("executionId", "workspaceId") REFERENCES "Execution"("id", "workspaceId") ON DELETE SET NULL;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_member_fkey" FOREIGN KEY ("actorUserId", "workspaceId") REFERENCES "WorkspaceMember"("userId", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_execution_scope_fkey" FOREIGN KEY ("executionId", "actorUserId", "workspaceId") REFERENCES "Execution"("id", "userId", "workspaceId") ON DELETE SET NULL;
