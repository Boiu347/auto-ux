import { createHash } from "node:crypto";

import { prisma, type AgentTokenScope } from "@app/db";

const AgentTokenPattern = /^execution_token:[a-f0-9]{64}$/;

export type ResolveAgentTokenScope = (
  tokenHash: string,
  executionId: string
) => Promise<AgentTokenScope | null>;

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
    return this.resolveScope(hashAgentToken(token), executionId);
  }
}

export function createExecutionAgentAuthenticator(): ExecutionAgentAuthenticator {
  return new ExecutionAgentAuthenticator(async (tokenHash, executionId) => {
    const execution = await prisma.execution.findFirst({
      where: {
        id: executionId,
        mode: "real_codex",
        agentAccessTokenHash: tokenHash,
        agentAccessExpiresAt: { gt: new Date() }
      },
      select: {
        userId: true,
        workspaceId: true,
        mode: true,
        agentAccessExpiresAt: true
      }
    });
    if (!execution?.agentAccessExpiresAt) {
      return null;
    }
    return {
      userId: execution.userId,
      workspaceId: execution.workspaceId,
      mode: execution.mode,
      tokenExpiresAt: execution.agentAccessExpiresAt
    };
  });
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
