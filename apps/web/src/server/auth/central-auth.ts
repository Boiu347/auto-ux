import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { prisma } from "@app/db";
import { z } from "zod";

import type { AuthenticatedUser } from "./session";

const claimsSchema = z.object({
  kind: z.literal("authz-assertion"),
  aud: z.literal("wowdata-project.v1"),
  project_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  open_id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  exp: z.number().int().positive()
});

export type CentralAuthIdentity = {
  openId: string;
  name: string;
  projectId: string;
};

export function readCentralAuthIdentity(
  request: Request,
  secret = process.env.AUTHZ_ASSERTION_SECRET,
  projectId = process.env.AUTHZ_PROJECT_ID ?? "auto-ux",
  now = new Date()
): CentralAuthIdentity | null {
  const raw = request.headers.get("x-wowdata-assertion");
  if (!raw || !secret || secret.length < 32) return null;
  const [payload, suppliedSignature, extra] = raw.split(".");
  if (
    !payload ||
    !suppliedSignature ||
    extra ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[a-f0-9]{64}$/i.test(suppliedSignature)
  ) {
    return null;
  }
  const expected = Buffer.from(
    createHmac("sha256", secret).update(payload).digest("hex"),
    "hex"
  );
  const supplied = Buffer.from(suppliedSignature, "hex");
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return null;
  }
  try {
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    );
    if (
      claims.project_id !== projectId ||
      claims.exp <= Math.floor(now.getTime() / 1_000)
    ) {
      return null;
    }
    return {
      openId: claims.open_id,
      name: claims.name?.trim() || "飞书用户",
      projectId: claims.project_id
    };
  } catch {
    return null;
  }
}

export async function resolveCentralAuthIdentity(
  identity: CentralAuthIdentity,
  pairedBrowserToken?: string | null
): Promise<AuthenticatedUser> {
  const tenantKey = "wowdata-central";
  const workspaceIdentity = `${identity.projectId}:${identity.openId}`;
  const workspaceTenantKey = `${tenantKey}:${createHash("sha256")
    .update(workspaceIdentity)
    .digest("hex")}`;
  const userId = stableIdentifier("User", identity.openId);
  const workspaceId = stableIdentifier("Workspace", workspaceIdentity);
  return prisma.$transaction(async (transaction) => {
    const existingUser = await transaction.user.findUnique({
      where: {
        feishuTenantKey_feishuOpenId: {
          feishuTenantKey: tenantKey,
          feishuOpenId: identity.openId
        }
      }
    });
    const existingWorkspace = await transaction.workspace.findUnique({
      where: { feishuTenantKey: workspaceTenantKey }
    });

    // The old site used the browser pairing token as its identity. On the first
    // central-login request only, bind that untouched legacy scope in place so
    // its device token and execution history remain valid after the upgrade.
    if (
      !existingUser &&
      !existingWorkspace &&
      pairedBrowserToken &&
      /^browser_token:[a-f0-9]{64}$/.test(pairedBrowserToken)
    ) {
      const pairing = await transaction.devicePairing.findUnique({
        where: {
          browserTokenHash: createHash("sha256")
            .update(pairedBrowserToken)
            .digest("hex")
        },
        include: { user: true, workspace: true }
      });
      if (
        pairing?.claimedAt &&
        !pairing.user.feishuTenantKey &&
        !pairing.user.feishuUnionId &&
        !pairing.user.feishuOpenId &&
        !pairing.workspace.feishuTenantKey
      ) {
        const [user, workspace] = await Promise.all([
          transaction.user.update({
            where: { id: pairing.userId },
            data: {
              feishuTenantKey: tenantKey,
              feishuOpenId: identity.openId,
              feishuName: identity.name
            }
          }),
          transaction.workspace.update({
            where: { id: pairing.workspaceId },
            data: { feishuTenantKey: workspaceTenantKey }
          })
        ]);
        return {
          userId: user.id,
          workspaceId: workspace.id,
          name: identity.name,
          avatarUrl: null
        };
      }
    }

    const workspace = existingWorkspace ?? await transaction.workspace.upsert({
      where: { id: workspaceId },
      create: { id: workspaceId, feishuTenantKey: workspaceTenantKey },
      update: {}
    });
    const user = existingUser
      ? await transaction.user.update({
          where: { id: existingUser.id },
          data: { feishuName: identity.name }
        })
      : await transaction.user.upsert({
          where: { id: userId },
          create: {
            id: userId,
            feishuTenantKey: tenantKey,
            feishuOpenId: identity.openId,
            feishuName: identity.name
          },
          update: { feishuName: identity.name }
        });
    await transaction.workspaceMember.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      create: { userId: user.id, workspaceId: workspace.id },
      update: {}
    });
    return {
      userId: user.id,
      workspaceId: workspace.id,
      name: identity.name,
      avatarUrl: null
    };
  });
}

function stableIdentifier(prefix: "User" | "Workspace", value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
