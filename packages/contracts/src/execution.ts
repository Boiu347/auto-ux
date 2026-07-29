import { z } from "zod";

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

export const ConfirmationActionSchema = z.enum([
  "publish",
  "import_numbers",
  "start_dial"
]);

export const ExecutionPacketSchema = z.object({
  executionId: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  configVersion: z.number().int().positive(),
  currentStep: z.string().min(1),
  targetPolicy: z.literal("create_only"),
  approvedActions: z.array(z.string().min(1)),
  blockedActions: z.array(ConfirmationActionSchema)
});

export const ExecutionEventSchema = z.object({
  executionId: z.string().min(1),
  stepId: z.string().min(1),
  attempt: z.number().int().positive(),
  status: ExecutionStatusSchema,
  occurredAt: z.string().datetime(),
  inputHash: z.string().min(1),
  evidence: z.object({
    kind: z.string().min(1),
    summary: z.string().min(1)
  }),
  errorCode: z.string().min(1).optional(),
  nextAction: z.string().min(1)
});

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export type ExecutionPhase = z.infer<typeof ExecutionPhaseSchema>;
export type ExecutionPacket = z.infer<typeof ExecutionPacketSchema>;
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export type ConfirmationAction = z.infer<typeof ConfirmationActionSchema>;
