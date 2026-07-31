import {
  ExecutionPhaseSchema,
  ExecutionStatusSchema,
  type ConfirmationAction,
  type ExecutionPhase,
  type ExecutionStatus
} from "@app/contracts";

import {
  invalidateConfirmations,
  takeConfirmationGrant,
  type ConfirmationGrant
} from "./confirmation.js";

export interface TransitionEvent {
  phase: ExecutionPhase;
  status: ExecutionStatus;
  recovered?: boolean;
  confirmation?: ConfirmationGrant;
}

export interface ExecutionState {
  status: ExecutionStatus;
  phase: ExecutionPhase;
  executionId: string;
  configVersion: number;
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

const confirmationPhaseActions: Partial<Record<ExecutionPhase, ConfirmationAction>> = {
  publish_confirm: "publish",
  numbers_confirm: "import_numbers",
  dial_confirm: "start_dial"
};

const highRiskPhaseActions: Partial<Record<ExecutionPhase, ConfirmationAction>> = {
  ...confirmationPhaseActions,
  publish_verify: "publish"
};

/**
 * Converts a step event into the execution status visible to the control plane.
 * High-risk progress accepts only an opaque grant minted by a consumed matching token.
 */
export function transition(
  current: CurrentExecution,
  event: TransitionEvent
): ExecutionStatus {
  const phase = ExecutionPhaseSchema.parse(event.phase);
  const nextStatus = ExecutionStatusSchema.parse(event.status);
  const normalized = normalizeCurrent(current);

  if (
    phase === "publish_verify" &&
    !event.recovered &&
    !normalized.phase &&
    normalized.status !== "waiting_confirmation"
  ) {
    throw new Error("publish confirmation required");
  }

  const advancing = assertDocumentedPhaseOrder(normalized, phase);

  const recoveryAction =
    event.recovered && !advancing ? highRiskPhaseActions[phase] : undefined;
  if (recoveryAction) {
    const executionId = requireExecutionId(normalized);
    const configVersion = requireConfigVersion(normalized);
    invalidateConfirmations(
      recoveryAction,
      executionId,
      configVersion
    );
    return "waiting_confirmation";
  }

  if (!advancing && normalized.phase) {
    if (consumeSamePhaseConfirmation(normalized, event.confirmation)) {
      return nextStatus;
    }
  }

  if (advancing && normalized.phase) {
    assertAdvanceAllowed(normalized);
    if (phase in confirmationPhaseActions) {
      if (nextStatus !== "running" && nextStatus !== "waiting_confirmation") {
        throw new Error(`phase ${phase} confirmation gate cannot start as ${nextStatus}`);
      }
      return "waiting_confirmation";
    }
  }

  if (normalized.status === "unknown" || nextStatus === "unknown") {
    return "unknown";
  }

  return nextStatus;
}

function normalizeCurrent(current: CurrentExecution): {
  status: ExecutionStatus;
  phase?: ExecutionPhase;
  executionId?: string;
  configVersion?: number;
} {
  if (typeof current === "string") {
    return { status: ExecutionStatusSchema.parse(current) };
  }

  if (!current.executionId) {
    throw new Error("executionId is required for an in-progress execution");
  }
  if (!Number.isInteger(current.configVersion) || current.configVersion <= 0) {
    throw new Error("configVersion is required for an in-progress execution");
  }

  return {
    status: ExecutionStatusSchema.parse(current.status),
    phase: ExecutionPhaseSchema.parse(current.phase),
    executionId: current.executionId,
    configVersion: current.configVersion
  };
}

function assertDocumentedPhaseOrder(
  current: ReturnType<typeof normalizeCurrent>,
  nextPhase: ExecutionPhase
): boolean {
  if (!current.phase) {
    if (current.status !== "pending") {
      throw new Error("current phase is required after execution start");
    }
    if (nextPhase !== "source_parse") {
      throw new Error(`phase ${nextPhase} must follow source_parse`);
    }
    return true;
  }

  const currentIndex = phaseOrder.indexOf(current.phase);
  const nextIndex = phaseOrder.indexOf(nextPhase);
  if (nextPhase === current.phase) {
    return false;
  }
  if (nextIndex === currentIndex + 1) {
    return true;
  }

  throw new Error(`phase ${nextPhase} must follow ${current.phase}`);
}

function assertAdvanceAllowed(
  current: ReturnType<typeof normalizeCurrent>
): void {
  const action = current.phase && confirmationPhaseActions[current.phase];
  if (action && current.status === "waiting_confirmation") {
    throw new Error(`${action} confirmation grant required`);
  }

  if (current.status === "succeeded") {
    return;
  }

  throw new Error(`phase ${current.phase} must succeed before advancing`);
}

function consumeSamePhaseConfirmation(
  current: ReturnType<typeof normalizeCurrent>,
  grant: ConfirmationGrant | undefined
): boolean {
  if (!current.phase) {
    return false;
  }

  const action = highRiskPhaseActions[current.phase];
  if (!action || current.status !== "waiting_confirmation") {
    return false;
  }

  if (
    takeConfirmationGrant(
      grant,
      action,
      requireExecutionId(current),
      requireConfigVersion(current)
    )
  ) {
    return true;
  }

  throw new Error(`${action} confirmation grant required`);
}

function requireExecutionId(current: ReturnType<typeof normalizeCurrent>): string {
  if (!current.executionId) {
    throw new Error("executionId is required for an in-progress execution");
  }
  return current.executionId;
}

function requireConfigVersion(current: ReturnType<typeof normalizeCurrent>): number {
  if (!current.configVersion) {
    throw new Error("configVersion is required for an in-progress execution");
  }
  return current.configVersion;
}
