import {
  ExecutionEventSchema,
  ExecutionPhaseSchema,
  ExecutionStatusSchema,
  type ExecutionEvent,
  type ExecutionPhase,
  type ExecutionStatus
} from "@app/contracts";
import type { PrismaClient } from "@prisma/client";

export interface ExecutionRecord {
  id: string;
  userId: string;
  workspaceId: string;
  configVersion: number;
  status: ExecutionStatus;
  phase: ExecutionPhase;
  targetPolicy: "create_only";
  createdAt: Date;
  updatedAt: Date;
}

export interface RepositoryScope {
  userId: string;
  workspaceId: string;
}

export interface ExecutionRepository {
  create(input: {
    userId: string;
    workspaceId: string;
    configVersion: number;
  }): Promise<ExecutionRecord>;
  findByIdForUser(
    executionId: string,
    userId: string,
    workspaceId: string
  ): Promise<ExecutionRecord | null>;
  appendStepEvent(event: ExecutionEvent): Promise<void>;
  listStepEvents(executionId: string): Promise<ExecutionEvent[]>;
  acquireLock(executionId: string, agentId: string, ttlSeconds: number): Promise<boolean>;
}

export class PrismaExecutionRepository implements ExecutionRepository {
  constructor(
    private readonly client: PrismaClient,
    private readonly scope: RepositoryScope
  ) {}

  async create(input: {
    userId: string;
    workspaceId: string;
    configVersion: number;
  }): Promise<ExecutionRecord> {
    this.assertScope(input);

    const execution = await this.client.$transaction(async (transaction) => {
      await transaction.user.upsert({
        where: { id: input.userId },
        create: { id: input.userId },
        update: {}
      });
      await transaction.workspace.upsert({
        where: { id: input.workspaceId },
        create: { id: input.workspaceId },
        update: {}
      });

      return transaction.execution.create({
        data: {
          id: `execution_${crypto.randomUUID()}`,
          userId: input.userId,
          workspaceId: input.workspaceId,
          configVersion: input.configVersion,
          status: "pending",
          phase: "source_parse",
          targetPolicy: "create_only"
        }
      });
    });

    return this.toExecutionRecord(execution);
  }

  async findByIdForUser(
    executionId: string,
    userId: string,
    workspaceId: string
  ): Promise<ExecutionRecord | null> {
    if (!this.isScope(userId, workspaceId)) {
      return null;
    }

    const execution = await this.client.execution.findFirst({
      where: { id: executionId, userId, workspaceId }
    });

    return execution ? this.toExecutionRecord(execution) : null;
  }

  async appendStepEvent(event: ExecutionEvent): Promise<void> {
    const validatedEvent = ExecutionEventSchema.parse(event);

    await this.client.executionStep.create({
      data: {
        execution: {
          connect: {
            id_userId_workspaceId: {
              id: validatedEvent.executionId,
              userId: this.scope.userId,
              workspaceId: this.scope.workspaceId
            }
          }
        },
        stepId: validatedEvent.stepId,
        attempt: validatedEvent.attempt,
        status: validatedEvent.status,
        inputHash: validatedEvent.inputHash,
        evidence: validatedEvent.evidence,
        errorCode: validatedEvent.errorCode,
        nextAction: validatedEvent.nextAction,
        occurredAt: new Date(validatedEvent.occurredAt)
      }
    });
  }

  async listStepEvents(executionId: string): Promise<ExecutionEvent[]> {
    await this.requireExecution(executionId);

    const events = await this.client.executionStep.findMany({
      where: {
        executionId,
        execution: {
          userId: this.scope.userId,
          workspaceId: this.scope.workspaceId
        }
      },
      orderBy: [{ occurredAt: "asc" }, { attempt: "asc" }]
    });

    return events.map((event) =>
      ExecutionEventSchema.parse({
        executionId: event.executionId,
        stepId: event.stepId,
        attempt: event.attempt,
        status: event.status,
        occurredAt: event.occurredAt.toISOString(),
        inputHash: event.inputHash,
        evidence: event.evidence,
        errorCode: event.errorCode ?? undefined,
        nextAction: event.nextAction
      })
    );
  }

  async acquireLock(
    executionId: string,
    agentId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("ttlSeconds must be a positive integer");
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
    const result = await this.client.execution.updateMany({
      where: {
        id: executionId,
        userId: this.scope.userId,
        workspaceId: this.scope.workspaceId,
        OR: [
          { executionLockExpiresAt: null },
          { executionLockExpiresAt: { lte: now } },
          { executionLockAgentId: agentId }
        ]
      },
      data: {
        executionLockAgentId: agentId,
        executionLockExpiresAt: expiresAt
      }
    });

    return result.count === 1;
  }

  private async requireExecution(executionId: string): Promise<void> {
    const execution = await this.client.execution.findFirst({
      where: {
        id: executionId,
        userId: this.scope.userId,
        workspaceId: this.scope.workspaceId
      },
      select: { id: true }
    });

    if (!execution) {
      throw new Error("execution not found in repository scope");
    }
  }

  private assertScope(scope: RepositoryScope): void {
    if (!this.isScope(scope.userId, scope.workspaceId)) {
      throw new Error("input is outside the repository scope");
    }
  }

  private isScope(userId: string, workspaceId: string): boolean {
    return userId === this.scope.userId && workspaceId === this.scope.workspaceId;
  }

  private toExecutionRecord(execution: {
    id: string;
    userId: string;
    workspaceId: string;
    configVersion: number;
    status: string;
    phase: string;
    targetPolicy: string;
    createdAt: Date;
    updatedAt: Date;
  }): ExecutionRecord {
    return {
      ...execution,
      status: ExecutionStatusSchema.parse(execution.status),
      phase: ExecutionPhaseSchema.parse(execution.phase),
      targetPolicy: this.toCreateOnlyPolicy(execution.targetPolicy)
    };
  }

  private toCreateOnlyPolicy(targetPolicy: string): "create_only" {
    if (targetPolicy !== "create_only") {
      throw new Error("execution target policy must be create_only");
    }

    return targetPolicy;
  }
}
