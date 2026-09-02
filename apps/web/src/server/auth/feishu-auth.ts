import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { prisma } from "@app/db";
import { z } from "zod";

import type { AuthenticatedUser } from "./session";

const tokenResponseSchema = z.object({
  code: z.number().int(),
  access_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  token_type: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional()
});

const userInfoResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z.object({
    name: z.string().min(1).max(256),
    avatar_url: z.string().max(2_048).optional(),
    open_id: z.string().min(1).max(256),
    union_id: z.string().min(1).max(256),
    tenant_key: z.string().min(1).max(256)
  }).optional()
});

export type FeishuIdentity = {
  name: string;
  avatarUrl: string | null;
  openId: string;
  unionId: string;
  tenantKey: string;
};

export interface FeishuAuthStore {
  createLoginState(stateHash: string, expiresAt: Date): Promise<void>;
  consumeLoginState(stateHash: string, now: Date): Promise<boolean>;
  resolveIdentity(identity: FeishuIdentity): Promise<AuthenticatedUser>;
}

export class PrismaFeishuAuthStore implements FeishuAuthStore {
  async createLoginState(stateHash: string, expiresAt: Date): Promise<void> {
    await prisma.$transaction([
      prisma.oAuthLoginState.deleteMany({
        where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } }
      }),
      prisma.oAuthLoginState.create({ data: { stateHash, expiresAt } })
    ]);
  }

  async consumeLoginState(stateHash: string, now: Date): Promise<boolean> {
    const consumed = await prisma.oAuthLoginState.updateMany({
      where: { stateHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now }
    });
    return consumed.count === 1;
  }

  async resolveIdentity(identity: FeishuIdentity): Promise<AuthenticatedUser> {
    return prisma.$transaction(async (transaction) => {
      const workspace = await transaction.workspace.upsert({
        where: { feishuTenantKey: identity.tenantKey },
        create: {
          id: `Workspace_${randomUUID().replaceAll("-", "")}`,
          feishuTenantKey: identity.tenantKey
        },
        update: {}
      });
      const user = await transaction.user.upsert({
        where: {
          feishuTenantKey_feishuUnionId: {
            feishuTenantKey: identity.tenantKey,
            feishuUnionId: identity.unionId
          }
        },
        create: {
          id: `User_${randomUUID().replaceAll("-", "")}`,
          feishuTenantKey: identity.tenantKey,
          feishuUnionId: identity.unionId,
          feishuOpenId: identity.openId,
          feishuName: identity.name,
          feishuAvatarUrl: identity.avatarUrl
        },
        update: {
          feishuOpenId: identity.openId,
          feishuName: identity.name,
          feishuAvatarUrl: identity.avatarUrl
        }
      });
      await transaction.workspaceMember.upsert({
        where: {
          userId_workspaceId: { userId: user.id, workspaceId: workspace.id }
        },
        create: { userId: user.id, workspaceId: workspace.id },
        update: {}
      });
      return {
        userId: user.id,
        workspaceId: workspace.id,
        name: identity.name,
        avatarUrl: identity.avatarUrl
      };
    });
  }
}

export type FeishuAuthConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  sessionSecret: string;
};

export function readFeishuAuthConfig(): FeishuAuthConfig {
  const config = {
    appId: process.env.FEISHU_APP_ID?.trim() ?? "",
    appSecret: process.env.FEISHU_APP_SECRET?.trim() ?? "",
    redirectUri: process.env.FEISHU_OAUTH_REDIRECT_URI?.trim() ?? "",
    sessionSecret: process.env.AUTH_SESSION_SECRET ?? ""
  };
  if (
    !/^cli_[A-Za-z0-9]+$/.test(config.appId) ||
    !config.appSecret ||
    config.sessionSecret.length < 32
  ) {
    throw new Error("FEISHU_AUTH_NOT_CONFIGURED");
  }
  let redirect: URL;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new Error("FEISHU_AUTH_NOT_CONFIGURED");
  }
  if (
    !["http:", "https:"].includes(redirect.protocol) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  ) {
    throw new Error("FEISHU_AUTH_NOT_CONFIGURED");
  }
  return config;
}

export function createAuthorizationRequest(
  config: FeishuAuthConfig,
  now = new Date()
): {
  authorizationUrl: string;
  state: string;
  stateHash: string;
  codeVerifier: string;
  expiresAt: Date;
} {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const authorizationUrl = new URL(
    "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
  );
  authorizationUrl.search = new URLSearchParams({
    client_id: config.appId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  }).toString();
  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    stateHash: hashState(state),
    codeVerifier,
    expiresAt
  };
}

export function statesMatch(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export async function exchangeCodeForIdentity(
  config: FeishuAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImplementation: typeof fetch = fetch
): Promise<FeishuIdentity> {
  const tokenResponse = await fetchImplementation(
    "https://accounts.feishu.cn/oauth/v3/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier
      }),
      signal: AbortSignal.timeout(10_000)
    }
  );
  const tokenResult = tokenResponseSchema.safeParse(await tokenResponse.json());
  if (
    !tokenResponse.ok ||
    !tokenResult.success ||
    tokenResult.data.code !== 0 ||
    !tokenResult.data.access_token
  ) {
    throw new Error("FEISHU_TOKEN_EXCHANGE_FAILED");
  }

  const userResponse = await fetchImplementation(
    "https://open.feishu.cn/open-apis/authen/v1/user_info",
    {
      headers: {
        authorization: `Bearer ${tokenResult.data.access_token}`,
        "content-type": "application/json; charset=utf-8"
      },
      signal: AbortSignal.timeout(10_000)
    }
  );
  const userResult = userInfoResponseSchema.safeParse(await userResponse.json());
  if (
    !userResponse.ok ||
    !userResult.success ||
    userResult.data.code !== 0 ||
    !userResult.data.data
  ) {
    throw new Error("FEISHU_USER_INFO_FAILED");
  }
  return {
    name: userResult.data.data.name,
    avatarUrl: userResult.data.data.avatar_url ?? null,
    openId: userResult.data.data.open_id,
    unionId: userResult.data.data.union_id,
    tenantKey: userResult.data.data.tenant_key
  };
}
