import { createHash, randomBytes } from "node:crypto";

import {
  AgentCapabilityManifestSchema,
  ConfirmationActionSchema,
  ExecutionEventSchema,
  ExecutionModeSchema,
  LocalConfirmationProofSchema,
  type ConfirmationAction,
  type AgentCapabilityManifest,
  type ExecutionEvent,
  type ExecutionMode,
  type LocalConfirmationProof,
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
import { hashAgentToken } from "./agent-auth";

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

const InputHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const CreateExecutionRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      configVersion: z.number().int().positive(),
      mode: z.literal("real_codex"),
      sourceCount: z.number().int().positive(),
      inputHash: InputHashSchema
    })
    .strict(),
  z
    .object({
      configVersion: z.number().int().positive(),
      mode: z.literal("simulator").optional()
    })
    .strict()
]);

export type CreateExecutionRequest = z.infer<
  typeof CreateExecutionRequestSchema
>;

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
      .optional(),
    localConfirmation: LocalConfirmationProofSchema.optional()
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
    mode?: ExecutionMode;
    agentAccessTokenHash?: string;
    agentAccessExpiresAt?: Date;
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
  findApprovedConfirmationDecision(input: {
    executionId: string;
    action: ConfirmationAction;
  }): Promise<{ decidedAt: Date } | null>;
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
    request: CreateExecutionRequest | number
  ): Promise<{
    execution: ExecutionRecord;
    agentToken?: string;
    tokenExpiresAt?: string;
  }> {
    const input: CreateExecutionRequest =
      typeof request === "number"
        ? { configVersion: request, mode: "simulator" }
        : request;
    const mode = ExecutionModeSchema.parse(input.mode ?? "simulator");
    if (mode === "simulator") {
      return {
        execution: await this.store.createExecution({
          ...scope,
          configVersion: input.configVersion,
          mode
        })
      };
    }

    const agentToken = `execution_token:${this.randomHex(32)}`;
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60_000);
    const execution = await this.store.createExecution({
      ...scope,
      configVersion: input.configVersion,
      mode,
      agentAccessTokenHash: hashAgentToken(agentToken),
      agentAccessExpiresAt: expiresAt
    });
    return {
      execution,
      agentToken,
      tokenExpiresAt: expiresAt.toISOString()
    };
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
    sessionId?: string,
    localConfirmation?: LocalConfirmationProof
  ): Promise<void> {
    const validatedEvent = ExecutionEventSchema.parse(event);
    const execution = await this.requireExecution(validatedEvent.executionId);
    const phase = phaseForStep(validatedEvent.stepId);
    const expectedAction = confirmationActionForPhase(execution.phase);
    let preparedConfirmation:
      | { grant: ConfirmationGrant; claim?: ConfirmationClaim }
      | undefined;
    if (execution.mode === "real_codex") {
      if (confirmation) {
        throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
      }
      if (expectedAction && execution.status === "waiting_confirmation") {
        if (!localConfirmation) {
          throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
        }
        preparedConfirmation = await this.prepareLocalConfirmation(
          execution,
          localConfirmation
        );
      } else if (localConfirmation) {
        throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
      }
    } else {
      if (localConfirmation) {
        throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
      }
      preparedConfirmation = confirmation
        ? await this.preparePersistedConfirmation(execution, confirmation)
        : undefined;
    }
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

  private async prepareLocalConfirmation(
    execution: ExecutionRecord,
    proof: LocalConfirmationProof
  ): Promise<{ grant: ConfirmationGrant }> {
    const validated = LocalConfirmationProofSchema.parse(proof);
    const expectedAction = confirmationActionForPhase(execution.phase);
    if (!expectedAction || validated.action !== expectedAction) {
      throw new ExecutionServiceError("CONFIRMATION_ACTION_MISMATCH", 409);
    }
    const confirmedAt = new Date(validated.confirmedAt);
    if (confirmedAt.getTime() > this.now().getTime()) {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }
    const events = await this.store.listEventsAfter(execution.id);
    const waitingEvent = events
      .filter(
        ({ event }) =>
          event.status === "waiting_confirmation" &&
          phaseForStep(event.stepId) === execution.phase
      )
      .at(-1);
    const gateOpenedAt = waitingEvent
      ? new Date(waitingEvent.event.occurredAt)
      : execution.updatedAt;
    if (confirmedAt.getTime() < gateOpenedAt.getTime()) {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }
    const decision = await this.store.findApprovedConfirmationDecision({
      executionId: execution.id,
      action: validated.action
    });
    if (!decision || confirmedAt.getTime() !== decision.decidedAt.getTime()) {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }

    const token = issueDomainConfirmation(
      validated.action,
      execution.id,
      execution.configVersion,
      new Date(Date.now() + 60_000)
    );
    const consumption = consumeDomainConfirmation(
      token,
      validated.action,
      execution.id,
      execution.configVersion
    );
    if (!consumption.ok) {
      throw new ExecutionServiceError("CONFIRMATION_INVALID", 409);
    }
    return { grant: consumption.grant };
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
    mode?: ExecutionMode;
    agentAccessTokenHash?: string;
    agentAccessExpiresAt?: Date;
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
    return this.repository.createConfirmationForGate(input);
  }

  findConfirmation(
    input: ConfirmationClaim
  ): Promise<ConfirmationRecord | null> {
    return this.repository.findConfirmation(input);
  }

  async findApprovedConfirmationDecision(input: {
    executionId: string;
    action: ConfirmationAction;
  }): Promise<{ decidedAt: Date } | null> {
    return prisma.confirmationDecision.findFirst({
      where: {
        executionId: input.executionId,
        action: input.action,
        decision: "approved",
        execution: {
          userId: this.scope.userId,
          workspaceId: this.scope.workspaceId
        }
      },
      select: { decidedAt: true }
    });
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
