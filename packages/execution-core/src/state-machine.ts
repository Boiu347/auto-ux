import {
  ExecutionPhaseSchema,
  ExecutionStatusSchema,
  type ExecutionPhase,
  type ExecutionStatus
} from "@app/contracts";

export interface TransitionEvent {
  phase: ExecutionPhase;
  status: ExecutionStatus;
  recovered?: boolean;
}

export interface ExecutionState {
  status: ExecutionStatus;
  phase: ExecutionPhase;
}

type CurrentExecution = ExecutionStatus | ExecutionState;

const phaseOrder: readonly ExecutionPhase[] = [
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
];

const confirmationPhaseActions: Partial<Record<ExecutionPhase, true>> = {
  publish_confirm: true,
  numbers_confirm: true,
  dial_confirm: true
};

const verificationConfirmationActions: Partial<Record<ExecutionPhase, string>> = {
  publish_verify: "publish"
};

const highRiskPhases = new Set<ExecutionPhase>([
  "publish_confirm",
  "publish_verify",
  "numbers_confirm",
  "dial_confirm"
]);

/**
 * Converts a step event into the execution status visible to the control plane.
 * A confirmation phase never advances without a fresh action-specific approval.
 */
export function transition(
  current: CurrentExecution,
  event: TransitionEvent
): ExecutionStatus {
  const phase = ExecutionPhaseSchema.parse(event.phase);
  const nextStatus = ExecutionStatusSchema.parse(event.status);
  const { status: currentStatus, phase: currentPhase } = normalizeCurrent(current);

  const requiredConfirmation = verificationConfirmationActions[phase];
  if (
    requiredConfirmation &&
    !event.recovered &&
    currentStatus !== "waiting_confirmation"
  ) {
    throw new Error(`${requiredConfirmation} confirmation required`);
  }

  assertDocumentedPhaseOrder(currentStatus, currentPhase, phase);

  if (currentStatus === "unknown" || nextStatus === "unknown") {
    return "unknown";
  }

  if (event.recovered && highRiskPhases.has(phase)) {
    return "waiting_confirmation";
  }

  if (phase in confirmationPhaseActions) {
    return "waiting_confirmation";
  }

  return nextStatus;
}

function normalizeCurrent(current: CurrentExecution): {
  status: ExecutionStatus;
  phase?: ExecutionPhase;
} {
  if (typeof current === "string") {
    return { status: ExecutionStatusSchema.parse(current) };
  }

  return {
    status: ExecutionStatusSchema.parse(current.status),
    phase: ExecutionPhaseSchema.parse(current.phase)
  };
}

function assertDocumentedPhaseOrder(
  currentStatus: ExecutionStatus,
  currentPhase: ExecutionPhase | undefined,
  nextPhase: ExecutionPhase
): void {
  if (!currentPhase) {
    if (currentStatus !== "pending") {
      throw new Error("current phase is required after execution start");
    }
    if (nextPhase !== "source_parse") {
      throw new Error(`phase ${nextPhase} must follow source_parse`);
    }
    return;
  }

  const currentIndex = phaseOrder.indexOf(currentPhase);
  const nextIndex = phaseOrder.indexOf(nextPhase);
  if (nextPhase === currentPhase || nextIndex === currentIndex + 1) {
    return;
  }

  throw new Error(`phase ${nextPhase} must follow ${currentPhase}`);
}
