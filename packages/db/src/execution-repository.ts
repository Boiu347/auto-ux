import {
  ConfirmationActionSchema,
  ExecutionEventSchema,
  ExecutionPhaseSchema,
  ExecutionStatusSchema,
  type ConfirmationAction,
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

export interface PersistedStepEvent {
  cursor: string;
  event: ExecutionEvent;
}

export interface ConfirmationRecord {
  id: string;
  executionId: string;
  userId: string;
  workspaceId: string;
  action: ConfirmationAction;
  configVersion: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export type AppendStepEventResult =
  | "appended"
  | "lock_mismatch"
  | "state_mismatch"
  | "confirmation_invalid";

export interface ConfirmationClaim {
  confirmationId: string;
  executionId: string;
  action: ConfirmationAction;
  configVersion: number;
  tokenHash: string;
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
  appendStepEventForAgent(input: {
    agentId: string;
    event: ExecutionEvent;
    expectedState: { status: ExecutionStatus; phase: ExecutionPhase };
    nextState: { status: ExecutionStatus; phase: ExecutionPhase };
    confirmation?: ConfirmationClaim;
  }): Promise<AppendStepEventResult>;
  listStepEvents(executionId: string): Promise<ExecutionEvent[]>;
  listStepEventsAfter(
    executionId: string,
    afterCursor?: string
  ): Promise<PersistedStepEvent[]>;
  acquireLock(executionId: string, agentId: string, ttlSeconds: number): Promise<boolean>;
  claimOperation(executionId: string, fingerprint: string): Promise<{ claimed: boolean; attempt?: number }>;
  completeOperation(executionId: string, fingerprint: string, attempt: number, status: "succeeded" | "failed"): Promise<void>;
  createConfirmation(input: {
    id: string;
    executionId: string;
    action: ConfirmationAction;
    configVersion: number;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ConfirmationRecord>;
  consumeConfirmation(input: {
    confirmationId: string;
    executionId: string;
    action: ConfirmationAction;
    configVersion: number;
    tokenHash: string;
  }): Promise<ConfirmationRecord | null>;
  findConfirmation(input: ConfirmationClaim): Promise<ConfirmationRecord | null>;
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
      await transaction.workspaceMember.upsert({
        where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
        create: { userId: input.userId, workspaceId: input.workspaceId },
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

  async appendStepEventForAgent(input: {
    agentId: string;
    event: ExecutionEvent;
    expectedState: { status: ExecutionStatus; phase: ExecutionPhase };
    nextState: { status: ExecutionStatus; phase: ExecutionPhase };
    confirmation?: ConfirmationClaim;
  }): Promise<AppendStepEventResult> {
    const event = ExecutionEventSchema.parse(input.event);
    const expectedStatus = ExecutionStatusSchema.parse(input.expectedState.status);
    const expectedPhase = ExecutionPhaseSchema.parse(input.expectedState.phase);
    const nextStatus = ExecutionStatusSchema.parse(input.nextState.status);
    const nextPhase = ExecutionPhaseSchema.parse(input.nextState.phase);

    return this.client.$transaction(async (transaction) => {
      const executions = await transaction.$queryRaw<
        Array<{ status: string; phase: string }>
      >`
        SELECT "status", "phase"
        FROM "Execution"
        WHERE "id" = ${event.executionId}
          AND "userId" = ${this.scope.userId}
          AND "workspaceId" = ${this.scope.workspaceId}
          AND "executionLockAgentId" = ${input.agentId}
          AND "executionLockExpiresAt" > CURRENT_TIMESTAMP
        FOR UPDATE`;
      const execution = executions[0];
      if (!execution) {
        return "lock_mismatch";
      }
      if (
        execution.status !== expectedStatus ||
        execution.phase !== expectedPhase
      ) {
        return "state_mismatch";
      }
      if (input.confirmation) {
        const action = ConfirmationActionSchema.parse(input.confirmation.action);
        const confirmations = await transaction.$queryRaw<
          ConfirmationDatabaseRow[]
        >`
          UPDATE "Confirmation"
          SET "consumedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${input.confirmation.confirmationId}
            AND "executionId" = ${input.confirmation.executionId}
            AND "userId" = ${this.scope.userId}
            AND "workspaceId" = ${this.scope.workspaceId}
            AND "action" = ${action}::"ConfirmationAction"
            AND "configVersion" = ${input.confirmation.configVersion}
            AND "tokenHash" = ${input.confirmation.tokenHash}
            AND "consumedAt" IS NULL
            AND "expiresAt" > CURRENT_TIMESTAMP
          RETURNING "id", "executionId", "userId", "workspaceId", "action",
                    "configVersion", "expiresAt", "consumedAt", "createdAt"`;
        if (confirmations.length !== 1) {
          return "confirmation_invalid";
        }
      }

      await transaction.executionStep.create({
        data: {
          executionId: event.executionId,
          stepId: event.stepId,
          attempt: event.attempt,
          status: event.status,
          inputHash: event.inputHash,
          evidence: event.evidence,
          errorCode: event.errorCode,
          nextAction: event.nextAction,
          occurredAt: new Date(event.occurredAt)
        }
      });
      await transaction.execution.update({
        where: { id: event.executionId },
        data: { status: nextStatus, phase: nextPhase }
      });
      return "appended";
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

    return events.map((event) => this.toExecutionEvent(event));
  }

  async listStepEventsAfter(
    executionId: string,
    afterCursor?: string
  ): Promise<PersistedStepEvent[]> {
    await this.requireExecution(executionId);
    const sequence = this.parseCursor(afterCursor);
    const events = await this.client.executionStep.findMany({
      where: {
        executionId,
        ...(sequence === undefined ? {} : { sequence: { gt: sequence } }),
        execution: {
          userId: this.scope.userId,
          workspaceId: this.scope.workspaceId
        }
      },
      orderBy: { sequence: "asc" }
    });

    return events.map((event) => ({
      cursor: event.sequence.toString(),
      event: this.toExecutionEvent(event)
    }));
  }

  async acquireLock(
    executionId: string,
    agentId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("ttlSeconds must be a positive integer");
    }

    const rows = await this.client.$queryRaw<{ id: string }[]>`
      UPDATE "Execution"
      SET "executionLockAgentId" = ${agentId},
          "executionLockExpiresAt" = CURRENT_TIMESTAMP + (${ttlSeconds} * INTERVAL '1 second')
      WHERE "id" = ${executionId}
        AND "userId" = ${this.scope.userId}
        AND "workspaceId" = ${this.scope.workspaceId}
        AND ("executionLockExpiresAt" IS NULL OR "executionLockExpiresAt" <= CURRENT_TIMESTAMP OR "executionLockAgentId" = ${agentId})
      RETURNING "id"`;
    return rows.length === 1;
  }

  async claimOperation(executionId: string, fingerprint: string): Promise<{ claimed: boolean; attempt?: number }> {
    await this.requireExecution(executionId);
    try {
      const operation = await this.client.$transaction(async (transaction) => {
        const latest = await transaction.executionOperation.aggregate({
          where: { executionId, fingerprint },
          _max: { attempt: true }
        });
        return transaction.executionOperation.create({
          data: { executionId, fingerprint, attempt: (latest._max.attempt ?? 0) + 1, status: "running" }
        });
      });
      return { claimed: true, attempt: operation.attempt };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        return { claimed: false };
      }
      throw error;
    }
  }

  async completeOperation(executionId: string, fingerprint: string, attempt: number, status: "succeeded" | "failed"): Promise<void> {
    await this.client.executionOperation.updateMany({
      where: { executionId, fingerprint, attempt, status: "running", execution: { userId: this.scope.userId, workspaceId: this.scope.workspaceId } },
      data: { status }
    });
  }

  async createConfirmation(input: {
    id: string;
    executionId: string;
    action: ConfirmationAction;
    configVersion: number;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ConfirmationRecord> {
    const action = ConfirmationActionSchema.parse(input.action);
    await this.requireExecution(input.executionId);
    const confirmation = await this.client.confirmation.create({
      data: {
        id: input.id,
        executionId: input.executionId,
        userId: this.scope.userId,
        workspaceId: this.scope.workspaceId,
        action,
        configVersion: input.configVersion,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt
      }
    });

    return this.toConfirmationRecord(confirmation);
  }

  async consumeConfirmation(input: {
    confirmationId: string;
    executionId: string;
    action: ConfirmationAction;
    configVersion: number;
    tokenHash: string;
  }): Promise<ConfirmationRecord | null> {
    const action = ConfirmationActionSchema.parse(input.action);
    const confirmations = await this.client.$queryRaw<ConfirmationDatabaseRow[]>`
      UPDATE "Confirmation"
      SET "consumedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.confirmationId}
        AND "executionId" = ${input.executionId}
        AND "userId" = ${this.scope.userId}
        AND "workspaceId" = ${this.scope.workspaceId}
        AND "action" = ${action}::"ConfirmationAction"
        AND "configVersion" = ${input.configVersion}
        AND "tokenHash" = ${input.tokenHash}
        AND "consumedAt" IS NULL
        AND "expiresAt" > CURRENT_TIMESTAMP
      RETURNING "id", "executionId", "userId", "workspaceId", "action",
                "configVersion", "expiresAt", "consumedAt", "createdAt"`;

    return confirmations[0]
      ? this.toConfirmationRecord(confirmations[0])
      : null;
  }

  async findConfirmation(
    input: ConfirmationClaim
  ): Promise<ConfirmationRecord | null> {
    const action = ConfirmationActionSchema.parse(input.action);
    const confirmations = await this.client.$queryRaw<ConfirmationDatabaseRow[]>`
      SELECT "id", "executionId", "userId", "workspaceId", "action",
             "configVersion", "expiresAt", "consumedAt", "createdAt"
      FROM "Confirmation"
      WHERE "id" = ${input.confirmationId}
        AND "executionId" = ${input.executionId}
        AND "userId" = ${this.scope.userId}
        AND "workspaceId" = ${this.scope.workspaceId}
        AND "action" = ${action}::"ConfirmationAction"
        AND "configVersion" = ${input.configVersion}
        AND "tokenHash" = ${input.tokenHash}
        AND "consumedAt" IS NULL
        AND "expiresAt" > CURRENT_TIMESTAMP`;
    return confirmations[0]
      ? this.toConfirmationRecord(confirmations[0])
      : null;
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

  private toExecutionEvent(event: {
    executionId: string;
    stepId: string;
    attempt: number;
    status: string;
    occurredAt: Date;
    inputHash: string;
    evidence: unknown;
    errorCode: string | null;
    nextAction: string;
  }): ExecutionEvent {
    return ExecutionEventSchema.parse({
      executionId: event.executionId,
      stepId: event.stepId,
      attempt: event.attempt,
      status: event.status,
      occurredAt: event.occurredAt.toISOString(),
      inputHash: event.inputHash,
      evidence: event.evidence,
      errorCode: event.errorCode ?? undefined,
      nextAction: event.nextAction
    });
  }

  private toConfirmationRecord(
    confirmation: ConfirmationDatabaseRow
  ): ConfirmationRecord {
    return {
      id: confirmation.id,
      executionId: confirmation.executionId,
      userId: confirmation.userId,
      workspaceId: confirmation.workspaceId,
      action: ConfirmationActionSchema.parse(confirmation.action),
      configVersion: confirmation.configVersion,
      expiresAt: confirmation.expiresAt,
      consumedAt: confirmation.consumedAt,
      createdAt: confirmation.createdAt
    };
  }

  private parseCursor(cursor: string | undefined): bigint | undefined {
    if (cursor === undefined) {
      return undefined;
    }
    if (!/^(0|[1-9]\d*)$/.test(cursor)) {
      throw new Error("cursor must be a non-negative integer");
    }
    return BigInt(cursor);
  }

  private toCreateOnlyPolicy(targetPolicy: string): "create_only" {
    if (targetPolicy !== "create_only") {
      throw new Error("execution target policy must be create_only");
    }

    return targetPolicy;
  }
}

interface ConfirmationDatabaseRow {
  id: string;
  executionId: string;
  userId: string;
  workspaceId: string;
  action: string;
  configVersion: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}
