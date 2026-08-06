CREATE TYPE "DeviceTaskStatus" AS ENUM ('queued', 'claimed', 'codex_opened', 'prompt_sent', 'failed');
CREATE TYPE "ConfirmationDecisionValue" AS ENUM ('approved', 'rejected');
CREATE TYPE "ConfirmationDecisionSource" AS ENUM ('website', 'codex');

CREATE TABLE "DevicePairing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "browserTokenHash" TEXT NOT NULL,
    "deviceTokenHash" TEXT,
    "agentId" TEXT,
    "version" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DevicePairing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceTask" (
    "id" TEXT NOT NULL,
    "pairingId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "phoneFilePath" TEXT NOT NULL,
    "status" "DeviceTaskStatus" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "claimTokenHash" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeviceTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConfirmationDecision" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "action" "ConfirmationAction" NOT NULL,
    "decision" "ConfirmationDecisionValue" NOT NULL,
    "source" "ConfirmationDecisionSource" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConfirmationDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DevicePairing_codeHash_key" ON "DevicePairing"("codeHash");
CREATE UNIQUE INDEX "DevicePairing_browserTokenHash_key" ON "DevicePairing"("browserTokenHash");
CREATE UNIQUE INDEX "DevicePairing_deviceTokenHash_key" ON "DevicePairing"("deviceTokenHash");
CREATE INDEX "DevicePairing_workspaceId_createdAt_idx" ON "DevicePairing"("workspaceId", "createdAt");
CREATE INDEX "DevicePairing_lastSeenAt_idx" ON "DevicePairing"("lastSeenAt");
CREATE UNIQUE INDEX "DeviceTask_executionId_key" ON "DeviceTask"("executionId");
CREATE UNIQUE INDEX "DeviceTask_pairingId_requestId_key" ON "DeviceTask"("pairingId", "requestId");
CREATE INDEX "DeviceTask_pairingId_status_createdAt_idx" ON "DeviceTask"("pairingId", "status", "createdAt");
CREATE INDEX "DeviceTask_leaseExpiresAt_idx" ON "DeviceTask"("leaseExpiresAt");
CREATE UNIQUE INDEX "ConfirmationDecision_executionId_action_key" ON "ConfirmationDecision"("executionId", "action");
CREATE INDEX "ConfirmationDecision_executionId_decidedAt_idx" ON "ConfirmationDecision"("executionId", "decidedAt");

ALTER TABLE "DevicePairing" ADD CONSTRAINT "DevicePairing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevicePairing" ADD CONSTRAINT "DevicePairing_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevicePairing" ADD CONSTRAINT "DevicePairing_userId_workspaceId_fkey" FOREIGN KEY ("userId", "workspaceId") REFERENCES "WorkspaceMember"("userId", "workspaceId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "DeviceTask" ADD CONSTRAINT "DeviceTask_pairingId_fkey" FOREIGN KEY ("pairingId") REFERENCES "DevicePairing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceTask" ADD CONSTRAINT "DeviceTask_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConfirmationDecision" ADD CONSTRAINT "ConfirmationDecision_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
