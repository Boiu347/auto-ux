import { z } from "zod";

const confirmationActions = [
  "publish",
  "import_numbers",
  "start_dial"
] as const;

const executionSteps = [
  "source.parse",
  "draft.confirm",
  "environment.preflight",
  "robot.create",
  "field.configure",
  "voice.preflight",
  "publish.confirm",
  "publish.verify",
  "numbers.confirm",
  "dial.confirm",
  "dial.verify",
  "complete"
] as const;

const IdentifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{3,64}$/);
const OpaqueReferenceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,31}:[a-f0-9]{16,64}$/);

export const ExecutionStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_confirmation",
  "succeeded",
  "failed",
  "rolled_back",
  "unknown"
]);

export const ExecutionPhaseSchema = z.enum([
  "source_parse",
  "draft_confirm",
  "environment_preflight",
  "robot_create",
  "field_configure",
  "voice_preflight",
  "publish_confirm",
  "publish_verify",
  "numbers_confirm",
  "dial_confirm",
  "call_verify",
  "complete"
]);

export const ConfirmationActionSchema = z.enum(confirmationActions);

const LowRiskActionSchema = z.enum(["configure"]);
const ExecutionStepSchema = z.enum(executionSteps);

export const ActionConfirmationSchema = z
  .object({
    action: ConfirmationActionSchema,
    executionId: IdentifierSchema,
    configVersion: z.number().int().positive(),
    confirmationId: OpaqueReferenceIdSchema
  })
  .strict();

const BlockedActionsSchema = z
  .array(ConfirmationActionSchema)
  .min(1)
  .superRefine((actions, context) => {
    if (new Set(actions).size !== actions.length) {
      context.addIssue({
        code: "custom",
        message: "blockedActions must not contain duplicates"
      });
    }
  });

export const ExecutionPacketSchema = z
  .object({
    executionId: IdentifierSchema,
    userId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    configVersion: z.number().int().positive(),
    currentStep: ExecutionStepSchema,
    targetPolicy: z.literal("create_only"),
    approvedActions: z.array(LowRiskActionSchema).min(1).max(1),
    blockedActions: BlockedActionsSchema,
    confirmation: ActionConfirmationSchema.optional()
  })
  .strict()
  .superRefine((packet, context) => {
    const expectedBlockedActions = confirmationActions.filter(
      (action) => action !== packet.confirmation?.action
    );
    const blockedActionsMatch =
      packet.blockedActions.length === expectedBlockedActions.length &&
      expectedBlockedActions.every((action) => packet.blockedActions.includes(action));

    if (!blockedActionsMatch) {
      context.addIssue({
        code: "custom",
        message: "blockedActions must include every action without a confirmation"
      });
    }

    if (
      packet.confirmation &&
      (packet.confirmation.executionId !== packet.executionId ||
        packet.confirmation.configVersion !== packet.configVersion)
    ) {
      context.addIssue({
        code: "custom",
        message: "confirmation must be bound to this execution and config version"
      });
    }
  });

const EvidenceReferenceSchema = z
  .object({
    kind: z.enum(["platform_record", "field_readback", "phone_batch", "checkpoint"]),
    id: OpaqueReferenceIdSchema
  })
  .strict();

const MaskedPhoneSchema = z.string().regex(/^\d{3}\*{4}\d{4}$/);

export const ExecutionEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("platform_record"),
      summary: z.object({ outcome: z.enum(["unavailable", "recorded", "ringing", "connected", "no_answer", "busy", "failed"]) }).strict(),
      reference: EvidenceReferenceSchema.extend({ kind: z.literal("platform_record") })
    })
    .strict(),
  z
    .object({
      kind: z.literal("field_readback"),
      summary: z
        .object({
          field: z.enum(["robot_binding", "configuration", "voice", "publish_state"]),
          result: z.enum(["matched", "mismatched"])
        })
        .strict(),
      reference: EvidenceReferenceSchema.extend({ kind: z.literal("field_readback") })
    })
    .strict(),
  z
    .object({
      kind: z.literal("phone_batch"),
      summary: z
        .object({
          total: z.number().int().nonnegative(),
          valid: z.number().int().nonnegative(),
          invalid: z.number().int().nonnegative(),
          duplicates: z.number().int().nonnegative(),
          maskedSamples: z.array(MaskedPhoneSchema).max(3)
        })
        .strict(),
      reference: EvidenceReferenceSchema.extend({ kind: z.literal("phone_batch") })
    })
    .strict(),
  z
    .object({
      kind: z.literal("checkpoint"),
      summary: z
        .object({
          phase: ExecutionPhaseSchema,
          status: ExecutionStatusSchema
        })
        .strict(),
      reference: EvidenceReferenceSchema.extend({ kind: z.literal("checkpoint") })
    })
    .strict()
]);

const ErrorCodeSchema = z.enum([
  "CALL_RECORD_UNAVAILABLE",
  "LOGIN_EXPIRED",
  "TARGET_MISMATCH",
  "PAGE_INCOMPATIBLE",
  "PUBLISH_NOT_VERIFIED",
  "PHONE_PARSE_INVALID"
]);

const NextActionSchema = z.enum([
  "wait_for_user",
  "retry_preflight",
  "rebind_page",
  "reauthenticate",
  "inspect_call_record",
  "stop"
]);

export const ExecutionEventSchema = z
  .object({
    executionId: IdentifierSchema,
    stepId: ExecutionStepSchema,
    attempt: z.number().int().positive(),
    status: ExecutionStatusSchema,
    occurredAt: z.string().datetime(),
    inputHash: HashSchema,
    evidence: ExecutionEvidenceSchema,
    errorCode: ErrorCodeSchema.optional(),
    nextAction: NextActionSchema
  })
  .strict();

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export type ExecutionPhase = z.infer<typeof ExecutionPhaseSchema>;
export type ExecutionPacket = z.infer<typeof ExecutionPacketSchema>;
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export type ConfirmationAction = z.infer<typeof ConfirmationActionSchema>;
export type ActionConfirmation = z.infer<typeof ActionConfirmationSchema>;
export type ExecutionEvidence = z.infer<typeof ExecutionEvidenceSchema>;
