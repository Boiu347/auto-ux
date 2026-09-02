CREATE TABLE "TaskDraft" (
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "feishuUrls" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "requirements" TEXT NOT NULL DEFAULT '',
    "phoneFilePath" TEXT NOT NULL DEFAULT '',
    "robotName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskDraft_pkey" PRIMARY KEY ("userId", "workspaceId")
);

ALTER TABLE "DeviceTask"
ADD COLUMN "feishuUrls" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN "requirements" TEXT NOT NULL DEFAULT '',
ADD COLUMN "robotName" TEXT NOT NULL DEFAULT '';

CREATE INDEX "TaskDraft_workspaceId_updatedAt_idx"
ON "TaskDraft"("workspaceId", "updatedAt");

ALTER TABLE "TaskDraft"
ADD CONSTRAINT "TaskDraft_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskDraft"
ADD CONSTRAINT "TaskDraft_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
