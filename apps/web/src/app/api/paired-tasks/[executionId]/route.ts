import { prisma } from "@app/db";
import { NextResponse } from "next/server";

import type { CurrentUser } from "../../../../server/auth/current-user";
import { getRequestUser } from "../../../../server/auth/request-user";

const CODEX_ACK_TIMEOUT_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 2;

class DeliveryRetryConflictError extends Error {}

type Context = { params: Promise<{ executionId: string }> };
type StoredDelivery = {
  status: string;
  errorCode: string | null;
  updatedAt: Date;
  attempt: number;
  executionLockAgentId: string | null;
};
type Dependencies = {
  authenticate(request: Request): Promise<CurrentUser | null> | CurrentUser | null;
  find(scope: CurrentUser, executionId: string): Promise<StoredDelivery | null>;
  retry(
    scope: CurrentUser,
    executionId: string,
    sentBefore: Date
  ): Promise<StoredDelivery | null>;
  now?: () => Date;
};

export function createPairedTaskStatusHandlers(dependencies: Dependencies) {
  const now = dependencies.now ?? (() => new Date());

  return {
    GET: async (request: Request, context: Context): Promise<Response> => {
      const result = await loadDelivery(request, context, dependencies, now());
      if (result instanceof Response) return result;
      return NextResponse.json(serializeDelivery(result.task, result.currentTime));
    },
    POST: async (request: Request, context: Context): Promise<Response> => {
      const currentTime = now();
      const result = await loadDelivery(request, context, dependencies, currentTime);
      if (result instanceof Response) return result;
      const delivery = serializeDelivery(result.task, currentTime);
      if (delivery.status !== "ack_timeout" || !delivery.retryable) {
        return NextResponse.json({ code: "DELIVERY_RETRY_NOT_ALLOWED" }, { status: 409 });
      }
      const sentBefore = new Date(currentTime.getTime() - CODEX_ACK_TIMEOUT_MS);
      const retried = await dependencies.retry(result.scope, result.executionId, sentBefore);
      if (!retried) {
        return NextResponse.json({ code: "DELIVERY_RETRY_NOT_ALLOWED" }, { status: 409 });
      }
      return NextResponse.json(serializeDelivery(retried, currentTime));
    }
  };
}

async function loadDelivery(
  request: Request,
  context: Context,
  dependencies: Dependencies,
  currentTime: Date
): Promise<
  | { scope: CurrentUser; executionId: string; task: StoredDelivery; currentTime: Date }
  | Response
> {
  const scope = await dependencies.authenticate(request);
  if (!scope) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const { executionId } = await context.params;
  const task = await dependencies.find(scope, executionId);
  if (!task) return NextResponse.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
  return { scope, executionId, task, currentTime };
}

function serializeDelivery(task: StoredDelivery, currentTime: Date) {
  const acknowledged = task.executionLockAgentId !== null;
  const timedOut =
    task.status === "prompt_sent" &&
    currentTime.getTime() - task.updatedAt.getTime() >= CODEX_ACK_TIMEOUT_MS;
  const status = acknowledged
    ? "agent_started"
    : timedOut
      ? "ack_timeout"
      : task.status;
  const retryable = status === "ack_timeout" && task.attempt < MAX_DELIVERY_ATTEMPTS;
  return {
    status,
    errorCode: status === "ack_timeout" ? "CODEX_ACK_TIMEOUT" : task.errorCode,
    updatedAt: task.updatedAt.toISOString(),
    retryable
  };
}

async function findDelivery(
  scope: CurrentUser,
  executionId: string
): Promise<StoredDelivery | null> {
  const task = await prisma.deviceTask.findFirst({
    where: {
      executionId,
      pairing: { userId: scope.userId, workspaceId: scope.workspaceId }
    },
    select: {
      status: true,
      errorCode: true,
      updatedAt: true,
      attempt: true,
      execution: { select: { executionLockAgentId: true } }
    }
  });
  return task
    ? { ...task, executionLockAgentId: task.execution.executionLockAgentId }
    : null;
}

async function retryDelivery(
  scope: CurrentUser,
  executionId: string,
  sentBefore: Date
): Promise<StoredDelivery | null> {
  try {
    return await prisma.$transaction(async (transaction) => {
      const candidate = await transaction.deviceTask.findFirst({
        where: {
          executionId,
          status: "prompt_sent",
          attempt: { lt: MAX_DELIVERY_ATTEMPTS },
          updatedAt: { lte: sentBefore },
          pairing: { userId: scope.userId, workspaceId: scope.workspaceId },
          execution: { executionLockAgentId: null }
        },
        select: { id: true }
      });
      if (!candidate) return null;
      const updated = await transaction.deviceTask.updateMany({
        where: {
          id: candidate.id,
          status: "prompt_sent",
          attempt: { lt: MAX_DELIVERY_ATTEMPTS },
          updatedAt: { lte: sentBefore },
          execution: { executionLockAgentId: null }
        },
        data: {
          status: "queued",
          errorCode: null,
          claimTokenHash: null,
          leaseExpiresAt: null
        }
      });
      if (updated.count !== 1) return null;

      const invalidated = await transaction.execution.updateMany({
        where: { id: executionId, executionLockAgentId: null },
        data: { agentAccessTokenHash: null, agentAccessExpiresAt: null }
      });
      if (invalidated.count !== 1) throw new DeliveryRetryConflictError();

      const task = await transaction.deviceTask.findUnique({
        where: { id: candidate.id },
        select: {
          status: true,
          errorCode: true,
          updatedAt: true,
          attempt: true,
          execution: { select: { executionLockAgentId: true } }
        }
      });
      return task
        ? { ...task, executionLockAgentId: task.execution.executionLockAgentId }
        : null;
    });
  } catch (error) {
    if (error instanceof DeliveryRetryConflictError) return null;
    throw error;
  }
}

const handlers = createPairedTaskStatusHandlers({
  authenticate: getRequestUser,
  find: findDelivery,
  retry: retryDelivery
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const runtime = "nodejs";
