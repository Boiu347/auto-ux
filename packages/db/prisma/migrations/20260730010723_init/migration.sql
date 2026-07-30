-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalAgent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceReferenceHash" TEXT NOT NULL,
    "structuredConfig" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "targetPolicy" TEXT NOT NULL,
    "executionLockAgentId" TEXT,
    "executionLockExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionStep" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "errorCode" TEXT,
    "nextAction" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionOperation" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Confirmation" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Confirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RobotBinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "executionId" TEXT,
    "agentId" TEXT NOT NULL,
    "platformRobotRef" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RobotBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "executionId" TEXT,
    "action" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocalAgent_workspaceId_idx" ON "LocalAgent"("workspaceId");

-- CreateIndex
CREATE INDEX "ConfigDraft_workspaceId_idx" ON "ConfigDraft"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigDraft_userId_workspaceId_version_key" ON "ConfigDraft"("userId", "workspaceId", "version");

-- CreateIndex
CREATE INDEX "Execution_userId_workspaceId_createdAt_idx" ON "Execution"("userId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Execution_executionLockExpiresAt_idx" ON "Execution"("executionLockExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_id_userId_workspaceId_key" ON "Execution"("id", "userId", "workspaceId");

-- CreateIndex
CREATE INDEX "ExecutionStep_executionId_occurredAt_idx" ON "ExecutionStep"("executionId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionStep_executionId_stepId_attempt_key" ON "ExecutionStep"("executionId", "stepId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionOperation_executionId_fingerprint_key" ON "ExecutionOperation"("executionId", "fingerprint");

-- CreateIndex
CREATE INDEX "Confirmation_executionId_expiresAt_idx" ON "Confirmation"("executionId", "expiresAt");

-- CreateIndex
CREATE INDEX "Confirmation_userId_workspaceId_idx" ON "Confirmation"("userId", "workspaceId");

-- CreateIndex
CREATE INDEX "RobotBinding_agentId_idx" ON "RobotBinding"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "RobotBinding_workspaceId_platformRobotRef_key" ON "RobotBinding"("workspaceId", "platformRobotRef");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_executionId_createdAt_idx" ON "AuditEvent"("executionId", "createdAt");

-- AddForeignKey
ALTER TABLE "LocalAgent" ADD CONSTRAINT "LocalAgent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigDraft" ADD CONSTRAINT "ConfigDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigDraft" ADD CONSTRAINT "ConfigDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionStep" ADD CONSTRAINT "ExecutionStep_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionOperation" ADD CONSTRAINT "ExecutionOperation_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confirmation" ADD CONSTRAINT "Confirmation_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confirmation" ADD CONSTRAINT "Confirmation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confirmation" ADD CONSTRAINT "Confirmation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobotBinding" ADD CONSTRAINT "RobotBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobotBinding" ADD CONSTRAINT "RobotBinding_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobotBinding" ADD CONSTRAINT "RobotBinding_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "LocalAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
