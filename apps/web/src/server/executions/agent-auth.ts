import { createHash } from "node:crypto";

import { prisma, type AgentTokenScope } from "@app/db";

const AgentTokenPattern = /^execution_token:[a-f0-9]{64}$/;

export type ResolveAgentTokenScope = (
  tokenHash: string,
  executionId: string
) => Promise<AgentTokenScope | "expired" | null>;

export class ExecutionAgentAuthenticationError extends Error {
  constructor(readonly code: "AGENT_TOKEN_EXPIRED") {
    super(code);
  }
}

export class ExecutionAgentAuthenticator {
  constructor(private readonly resolveScope: ResolveAgentTokenScope) {}

  async authenticate(
    request: Request,
    executionId: string
  ): Promise<AgentTokenScope | null> {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return null;
    }
    const token = authorization.slice("Bearer ".length);
    if (!AgentTokenPattern.test(token)) {
      return null;
    }
    const result = await this.resolveScope(hashAgentToken(token), executionId);
    if (result === "expired") {
      throw new ExecutionAgentAuthenticationError("AGENT_TOKEN_EXPIRED");
    }
    return result;
  }
}

export function createExecutionAgentAuthenticator(): ExecutionAgentAuthenticator {
  return new ExecutionAgentAuthenticator(async (tokenHash, executionId) => {
    const now = new Date();
    const execution = await prisma.execution.findFirst({
      where: {
        id: executionId,
        mode: "real_codex",
        agentAccessTokenHash: tokenHash
      },
      select: {
        userId: true,
        workspaceId: true,
        mode: true,
        agentAccessExpiresAt: true
      }
    });
    if (!execution?.agentAccessExpiresAt) return null;
    if (execution.agentAccessExpiresAt <= now) return "expired";
    const renewedUntil = new Date(now.getTime() + 24 * 60 * 60_000);
    const renewed = await prisma.execution.updateMany({
      where: {
        id: executionId,
        agentAccessTokenHash: tokenHash,
        agentAccessExpiresAt: { gt: now }
      },
      data: { agentAccessExpiresAt: renewedUntil }
    });
    if (renewed.count !== 1) return "expired";
    return {
      userId: execution.userId,
      workspaceId: execution.workspaceId,
      mode: execution.mode,
      tokenExpiresAt: renewedUntil
    };
  });
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
