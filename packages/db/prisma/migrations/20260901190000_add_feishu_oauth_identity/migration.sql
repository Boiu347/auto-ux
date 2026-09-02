ALTER TABLE "User"
ADD COLUMN "feishuTenantKey" TEXT,
ADD COLUMN "feishuUnionId" TEXT,
ADD COLUMN "feishuOpenId" TEXT,
ADD COLUMN "feishuName" TEXT,
ADD COLUMN "feishuAvatarUrl" TEXT;

ALTER TABLE "Workspace"
ADD COLUMN "feishuTenantKey" TEXT;

CREATE UNIQUE INDEX "User_feishuTenantKey_feishuUnionId_key"
ON "User"("feishuTenantKey", "feishuUnionId");

CREATE UNIQUE INDEX "User_feishuTenantKey_feishuOpenId_key"
ON "User"("feishuTenantKey", "feishuOpenId");

CREATE UNIQUE INDEX "Workspace_feishuTenantKey_key"
ON "Workspace"("feishuTenantKey");

CREATE TABLE "OAuthLoginState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthLoginState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OAuthLoginState_stateHash_key"
ON "OAuthLoginState"("stateHash");

CREATE INDEX "OAuthLoginState_expiresAt_idx"
ON "OAuthLoginState"("expiresAt");
