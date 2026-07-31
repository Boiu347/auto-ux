import { createHash, randomBytes } from "node:crypto";

import {
  AgentCapabilityManifestSchema,
  ConfirmationActionSchema,
  ExecutionEventSchema,
  type ConfirmationAction,
  type AgentCapabilityManifest,
  type ExecutionEvent,
  type ExecutionPhase,
  type ExecutionStatus
} from "@app/contracts";
import {
  InvalidExecutionCursorError,
  PrismaExecutionRepository,
  prisma,
  type AppendStepEventResult,
  type ClaimExecutionAgentResult,
  type ConfirmationClaim,
  type ConfirmationRecord,
  type ExecutionAgentHeartbeat,
  type ExecutionRecord,
  type HeartbeatExecutionAgentResult,
  type PersistedStepEvent,
  type RepositoryScope
} from "@app/db";
import {
  consumeConfirmation as consumeDomainConfirmation,
  issueConfirmation as issueDomainConfirmation,
  transition,
  wasConfirmationGrantConsumed,
  type ConfirmationGrant
} from "@app/execution-core";
import { z } from "zod";

export type {
  ConfirmationRecord,
  ExecutionRecord,
  PersistedStepEvent
} from "@app/db";

const IdentifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const ConfirmationIdSchema = z
  .string()
  .regex(/^confirm:[a-f0-9]{16,64}$/);
const ConfirmationTokenSchema = z
  .string()
  .regex(/^confirm_token:[a-f0-9]{64}$/);

export const CreateExecutionRequestSchema = z
  .object({
    configVersion: z.number().int().positive()
  })
  .strict();

export const AppendExecutionEventRequestSchema = z
  .object({
    agentId: IdentifierSchema,
    sessionId: IdentifierSchema.optional(),
    event: ExecutionEventSchema,
    confirmation: z
      .object({
        confirmationId: ConfirmationIdSchema,
        token: ConfirmationTokenSchema,
        action: ConfirmationActionSchema,
        configVersion: z.number().int().positive()
      })
      .strict()
      .optional()
  })
  .strict();

export const CreateConfirmationRequestSchema = z
  .object({
    action: ConfirmationActionSchema,
    configVersion: z.number().int().positive(),
    agentId: IdentifierSchema
  })
  .strict();

export const ClaimExecutionRequestSchema = AgentCapabilityManifestSchema;

export const HeartbeatExecutionRequestSchema = z
  .object({
    agentId: IdentifierSchema,
    sessionId: IdentifierSchema
  })
  .strict();

export type ConfirmationProof = NonNullable<
  z.infer<typeof AppendExecutionEventRequestSchema>["confirmation"]
>;

export interface ExecutionDataStore {
  createExecution(input: {
    userId: string;
    workspaceId: string;
    configVersion: number;
  }): Promise<ExecutionRecord>;
  findExecution(executionId: string): Promise<ExecutionRecord | null>;
  findExecutionAgentHeartbeat(
    executionId: string
  ): Promise<ExecutionAgentHeartbeat | null>;
  claimExecutionAgent(input: {
    manifest: AgentCapabilityManifest;
    ttlSeconds: number;
  }): Promise<ClaimExecutionAgentResult>;
  heartbeatExecutionAgent(input: {
    executionId: string;
    agentId: string;
    sessionId: string;
    ttlSeconds: number;
  }): Promise<HeartbeatExecutionAgentResult>;
  appendEventForAgent(input: {
    agentId: string;
    sessionId?: string;
    event: ExecutionEvent;
    expectedState: { status: ExecutionStatus; phase: ExecutionPhase };
    nextState: { status: ExecutionStatus; phase: ExecutionPhase };
    confirmation?: ConfirmationClaim;
  }): Promise<AppendStepEventResult>;
  listEventsAfter(
    executionId: string,
    cursor?: string
  ): Promise<PersistedStepEvent[]>;
  createConfirmationForGate(input: {
    id: string;
    executionId: string;
    action: ConfirmationAction;
    configVersion: number;
    tokenHash: string;
    expiresAt: Date;
    agentId: string;
    expectedState: {
      status: "waiting_confirmation";
      phase: ExecutionPhase;
    };
  }): Promise<
    | { status: "created"; confirmation: ConfirmationRecord }
    | { status: "state_mismatch" }
    | { status: "lock_mismatch" }
  >;
  findConfirmation(input: ConfirmationClaim): Promise<ConfirmationRecord | null>;
}

type ExecutionServiceErrorCode =
  | "EXECUTION_NOT_FOUND"
  | "EXECUTION_LOCK_MISMATCH"
  | "EXECUTION_STATE_CONFLICT"
  | "INVALID_CURSOR"
  | "INVALID_EXECUTION_TRANSITION"
  | "CONFIRMATION_ACTION_MISMATCH"
  | "CONFIRMATION_CONFIG_MISMATCH"
  | "CONFIRMATION_INVALID"
  | "EXECUTION_LOCKED"
  | "DUPLICATE_PLUGIN_SESSION";

export class ExecutionServiceError extends Error {
  constructor(
    readonly code: ExecutionServiceErrorCode,
    readonly status: number
  ) {
    super(code);
  }
}

export class ExecutionService {
  constructor(
    private readonly store: ExecutionDataStore,
    private readonly now: () => Date = () => new Date(),
    private readonly randomHex: (bytes: number) => string = (bytes) =>
      randomBytes(bytes).toString("hex")
  ) {}

  async createExecution(
    scope: RepositoryScope,
    configVersion: number
  ): Promise<ExecutionRecord> {
    return this.store.createExecution({ ...scope, configVersion });
  }

  async getExecution(executionId: string): Promise<{
    execution: ExecutionRecord & {
      agentId: string | null;
      agentHeartbeatAt: Date | null;
    };
    events: PersistedStepEvent[];
  }> {
    const execution = await this.requireExecution(executionId);
    const [events, heartbeat] = await Promise.all([
      this.store.listEventsAfter(executionId),
      this.store.findExecutionAgentHeartbeat(executionId)
    ]);
    return {
      execution: {
        ...execution,
        agentId: heartbeat?.agentId ?? null,
        agentHeartbeatAt: heartbeat?.lastHeartbeatAt ?? null
      },
      events
    };
  }

  async claimExecution(manifest: AgentCapabilityManifest): Promise<{
    pluginSessionCount: 1;
    configVersion: number;
    events: ExecutionEvent[];
  }> {
    const validated = AgentCapabilityManifestSchema.parse(manifest);
    const execution = await this.requireExecution(validated.executionId);
    const claim = await this.store.claimExecutionAgent({
      manifest: validated,
      ttlSeconds: 60
    });
    this.requireSuccessfulClaim(claim);
    const events = await this.store.listEventsAfter(execution.id);
    return {
      pluginSessionCount: 1,
      configVersion: execution.configVersion,
      events: events.map(({ event }) => event)
    };
  }

  async heartbeatExecution(
    executionId: string,
    agentId: string,
    sessionId: string
  ): Promise<void> {
    await this.requireExecution(executionId);
    const result = await this.store.heartbeatExecutionAgent({
      executionId,
      agentId,
      sessionId,
      ttlSeconds: 60
    });
    if (result !== "renewed") {
      throw new ExecutionServiceError("EXECUTION_LOCK_MISMATCH", 409);
    }
  }

  async appendEvent(
    agentId: string,
    event: ExecutionEvent,
    confirmation?: ConfirmationProof,
    sessionId?: string
  ): Promise<void> {
    const validatedEvent = ExecutionEventSchema.parse(event);
    const execution = await this.requireExecution(validatedEvent.executionId);
    const phase = phaseForStep(validatedEvent.stepId);
    const preparedConfirmation = confirmation
      ? await this.preparePersistedConfirmation(execution, confirmation)
      : undefined;
    let nextStatus: ExecutionStatus;
    try {
      nextStatus = transition(
        {
          status: execution.status,
          phase: execution.phase,
          executionId: execution.id,
          configVersion: execution.configVersion
        },
        {
          phase,
          status: validatedEvent.status,
          confirmation: preparedConfirmation?.grant
        }
      );
    } catch {
      throw new ExecutionServiceError("INVALID_EXECUTION_TRANSITION", 409);
    }
    if (
      preparedConfirmation &&
      !wasConfirmationGrantConsumed(preparedConfirmation.grant)
    ) {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }

    const result = await this.store.appendEventForAgent({
      agentId,
      sessionId,
      event: validatedEvent,
      expectedState: {
        status: execution.status,
        phase: execution.phase
      },
      nextState: { status: nextStatus, phase },
      confirmation: preparedConfirmation?.claim
    });
    if (result === "lock_mismatch") {
      throw new ExecutionServiceError("EXECUTION_LOCK_MISMATCH", 409);
    }
    if (result === "state_mismatch") {
      throw new ExecutionServiceError("EXECUTION_STATE_CONFLICT", 409);
    }
    if (result === "confirmation_invalid") {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }
  }

  async issueCreatorConfirmation(
    executionId: string,
    action: ConfirmationAction,
    configVersion: number,
    agentId: string
  ): Promise<{
    action: ConfirmationAction;
    executionId: string;
    configVersion: number;
    confirmationId: string;
    token: string;
    expiresAt: string;
  }> {
    const execution = await this.requireExecution(executionId);
    if (execution.configVersion !== configVersion) {
      throw new ExecutionServiceError("CONFIRMATION_CONFIG_MISMATCH", 409);
    }
    if (confirmationActionForPhase(execution.phase) !== action) {
      throw new ExecutionServiceError("CONFIRMATION_ACTION_MISMATCH", 409);
    }
    if (execution.status !== "waiting_confirmation") {
      throw new ExecutionServiceError("CONFIRMATION_ACTION_MISMATCH", 409);
    }
    const heartbeat = await this.store.findExecutionAgentHeartbeat(executionId);
    if (!heartbeat || heartbeat.agentId !== agentId) {
      throw new ExecutionServiceError("EXECUTION_LOCK_MISMATCH", 409);
    }

    const confirmationId = `confirm:${this.randomHex(16)}`;
    const token = `confirm_token:${this.randomHex(32)}`;
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000);
    const issued = await this.store.createConfirmationForGate({
      id: confirmationId,
      executionId,
      action,
      configVersion,
      tokenHash: hashToken(token),
      expiresAt,
      agentId,
      expectedState: {
        status: "waiting_confirmation",
        phase: execution.phase
      }
    });
    if (issued.status === "lock_mismatch") {
      throw new ExecutionServiceError("EXECUTION_LOCK_MISMATCH", 409);
    }
    if (issued.status === "state_mismatch") {
      throw new ExecutionServiceError("CONFIRMATION_ACTION_MISMATCH", 409);
    }
    return {
      action,
      executionId,
      configVersion,
      confirmationId,
      token,
      expiresAt: expiresAt.toISOString()
    };
  }

  async createEventStream(
    executionId: string,
    cursor?: string
  ): Promise<Response> {
    await this.requireExecution(executionId);
    let events: PersistedStepEvent[];
    try {
      events = await this.store.listEventsAfter(executionId, cursor);
    } catch (error) {
      if (isInvalidCursorError(error)) {
        throw new ExecutionServiceError("INVALID_CURSOR", 400);
      }
      throw error;
    }
    const encoder = new TextEncoder();
    const store = this.store;
    let lastCursor = events.at(-1)?.cursor ?? cursor;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const persisted of events) {
          enqueueEvent(controller, encoder, persisted);
        }
        const poll = async () => {
          try {
            const persistedEvents = await store.listEventsAfter(
              executionId,
              lastCursor
            );
            for (const persisted of persistedEvents) {
              enqueueEvent(controller, encoder, persisted);
              lastCursor = persisted.cursor;
            }
          } catch (error) {
            closed = true;
            if (heartbeat) {
              clearInterval(heartbeat);
            }
            if (pollTimer) {
              clearTimeout(pollTimer);
            }
            controller.error(error);
          } finally {
            if (!closed) {
              pollTimer = setTimeout(poll, 1_000);
            }
          }
        };
        pollTimer = setTimeout(poll, 1_000);
        heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 15_000);
      },
      cancel() {
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        if (pollTimer) {
          clearTimeout(pollTimer);
        }
      }
    });

    return new Response(body, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      }
    });
  }

  private async requireExecution(executionId: string): Promise<ExecutionRecord> {
    const execution = await this.store.findExecution(executionId);
    if (!execution) {
      throw new ExecutionServiceError("EXECUTION_NOT_FOUND", 404);
    }
    return execution;
  }

  private requireSuccessfulClaim(result: ClaimExecutionAgentResult): void {
    if (result === "claimed") {
      return;
    }
    if (result === "not_found" || result === "agent_scope_mismatch") {
      throw new ExecutionServiceError("EXECUTION_NOT_FOUND", 404);
    }
    if (result === "session_mismatch") {
      throw new ExecutionServiceError("DUPLICATE_PLUGIN_SESSION", 409);
    }
    throw new ExecutionServiceError("EXECUTION_LOCKED", 409);
  }

  private async preparePersistedConfirmation(
    execution: ExecutionRecord,
    proof: ConfirmationProof
  ): Promise<{ grant: ConfirmationGrant; claim: ConfirmationClaim }> {
    if (execution.status !== "waiting_confirmation") {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }
    const expectedAction = confirmationActionForPhase(execution.phase);
    if (!expectedAction || proof.action !== expectedAction) {
      throw new ExecutionServiceError("CONFIRMATION_ACTION_MISMATCH", 409);
    }
    if (proof.configVersion !== execution.configVersion) {
      throw new ExecutionServiceError("CONFIRMATION_CONFIG_MISMATCH", 409);
    }

    const claim: ConfirmationClaim = {
      confirmationId: proof.confirmationId,
      executionId: execution.id,
      action: proof.action,
      configVersion: proof.configVersion,
      tokenHash: hashToken(proof.token)
    };
    const persisted = await this.store.findConfirmation(claim);
    if (!persisted) {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }

    const token = issueDomainConfirmation(
      persisted.action,
      persisted.executionId,
      persisted.configVersion,
      persisted.expiresAt
    );
    const consumption = consumeDomainConfirmation(
      token,
      persisted.action,
      persisted.executionId,
      persisted.configVersion
    );
    if (!consumption.ok) {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }
    return { grant: consumption.grant, claim };
  }
}

function enqueueEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  persisted: PersistedStepEvent
): void {
  controller.enqueue(
    encoder.encode(
      `id: ${persisted.cursor}\nevent: execution-step\ndata: ${JSON.stringify(
        persisted.event
      )}\n\n`
    )
  );
}

export function createExecutionService(
  scope: RepositoryScope
): ExecutionService {
  return new ExecutionService(
    new PrismaExecutionDataStore(
      new PrismaExecutionRepository(prisma, scope),
      scope
    )
  );
}

class PrismaExecutionDataStore implements ExecutionDataStore {
  constructor(
    private readonly repository: PrismaExecutionRepository,
    private readonly scope: RepositoryScope
  ) {}

  createExecution(input: {
    userId: string;
    workspaceId: string;
    configVersion: number;
  }): Promise<ExecutionRecord> {
    return this.repository.create(input);
  }

  findExecution(executionId: string): Promise<ExecutionRecord | null> {
    return this.repository.findByIdForUser(
      executionId,
      this.scope.userId,
      this.scope.workspaceId
    );
  }

  findExecutionAgentHeartbeat(
    executionId: string
  ): Promise<ExecutionAgentHeartbeat | null> {
    return this.repository.findExecutionAgentHeartbeat(executionId);
  }

  claimExecutionAgent(input: {
    manifest: AgentCapabilityManifest;
    ttlSeconds: number;
  }): Promise<ClaimExecutionAgentResult> {
    return this.repository.claimExecutionAgent(input);
  }

  heartbeatExecutionAgent(input: {
    executionId: string;
    agentId: string;
    sessionId: string;
    ttlSeconds: number;
  }): Promise<HeartbeatExecutionAgentResult> {
    return this.repository.heartbeatExecutionAgent(input);
  }

  appendEventForAgent(input: {
    agentId: string;
    sessionId?: string;
    event: ExecutionEvent;
    expectedState: { status: ExecutionStatus; phase: ExecutionPhase };
    nextState: { status: ExecutionStatus; phase: ExecutionPhase };
    confirmation?: ConfirmationClaim;
  }): Promise<AppendStepEventResult> {
    return this.repository.appendStepEventForAgent(input);
  }

  listEventsAfter(
    executionId: string,
    cursor?: string
  ): Promise<PersistedStepEvent[]> {
    return this.repository.listStepEventsAfter(executionId, cursor);
  }

  async createConfirmationForGate(input: {
    id: string;
    executionId: string;
    action: ConfirmationAction;
    configVersion: number;
    tokenHash: string;
    expiresAt: Date;
    agentId: string;
    expectedState: {
      status: "waiting_confirmation";
      phase: ExecutionPhase;
    };
  }): Promise<
    | { status: "created"; confirmation: ConfirmationRecord }
    | { status: "state_mismatch" }
    | { status: "lock_mismatch" }
  > {
    return prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<
        Array<{
          status: string;
          phase: string;
          configVersion: number;
          executionLockAgentId: string | null;
          lockActive: boolean;
        }>
      >`
        SELECT "status", "phase", "configVersion", "executionLockAgentId",
               ("executionLockExpiresAt" > CURRENT_TIMESTAMP) AS "lockActive"
        FROM "Execution"
        WHERE "id" = ${input.executionId}
          AND "userId" = ${this.scope.userId}
          AND "workspaceId" = ${this.scope.workspaceId}
        FOR UPDATE`;
      const execution = rows[0];
      if (
        !execution ||
        execution.status !== input.expectedState.status ||
        execution.phase !== input.expectedState.phase ||
        execution.configVersion !== input.configVersion
      ) {
        return { status: "state_mismatch" } as const;
      }
      if (
        !execution.lockActive ||
        execution.executionLockAgentId !== input.agentId
      ) {
        return { status: "lock_mismatch" } as const;
      }

      await transaction.$executeRaw`
        UPDATE "Confirmation"
        SET "consumedAt" = CURRENT_TIMESTAMP
        WHERE "executionId" = ${input.executionId}
          AND "userId" = ${this.scope.userId}
          AND "workspaceId" = ${this.scope.workspaceId}
          AND "action" = ${input.action}::"ConfirmationAction"
          AND "configVersion" = ${input.configVersion}
          AND "consumedAt" IS NULL
          AND "expiresAt" > CURRENT_TIMESTAMP`;
      const confirmation = await transaction.confirmation.create({
        data: {
          id: input.id,
          executionId: input.executionId,
          userId: this.scope.userId,
          workspaceId: this.scope.workspaceId,
          action: input.action,
          configVersion: input.configVersion,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt
        }
      });
      return {
        status: "created",
        confirmation: {
          id: confirmation.id,
          executionId: confirmation.executionId,
          userId: confirmation.userId,
          workspaceId: confirmation.workspaceId,
          action: confirmation.action,
          configVersion: confirmation.configVersion,
          expiresAt: confirmation.expiresAt,
          consumedAt: confirmation.consumedAt,
          createdAt: confirmation.createdAt
        }
      } as const;
    });
  }

  findConfirmation(
    input: ConfirmationClaim
  ): Promise<ConfirmationRecord | null> {
    return this.repository.findConfirmation(input);
  }
}

const stepPhases: Record<ExecutionEvent["stepId"], ExecutionPhase> = {
  "source.parse": "source_parse",
  "draft.confirm": "draft_confirm",
  "environment.preflight": "environment_preflight",
  "robot.create": "robot_create",
  "field.configure": "field_configure",
  "voice.preflight": "voice_preflight",
  "publish.confirm": "publish_confirm",
  "publish.verify": "publish_verify",
  "numbers.confirm": "numbers_confirm",
  "dial.confirm": "dial_confirm",
  "dial.verify": "call_verify",
  complete: "complete"
};

function phaseForStep(stepId: ExecutionEvent["stepId"]): ExecutionPhase {
  return stepPhases[stepId];
}

function confirmationActionForPhase(
  phase: ExecutionPhase
): ConfirmationAction | undefined {
  return confirmationActionsByPhase[phase];
}

const confirmationActionsByPhase: Partial<
  Record<ExecutionPhase, ConfirmationAction>
> = {
  publish_confirm: "publish",
  publish_verify: "publish",
  numbers_confirm: "import_numbers",
  dial_confirm: "start_dial"
};

function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function isInvalidCursorError(error: unknown): boolean {
  return (
    error instanceof InvalidExecutionCursorError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "INVALID_CURSOR")
  );
}
