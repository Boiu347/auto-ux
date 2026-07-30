import { createHash } from "node:crypto";

export type RetryDecision =
  | { allowed: true }
  | { allowed: false; reason: "retry_budget_exhausted" };

/**
 * Produces a stable, execution-scoped identity for a single attempted action.
 */
export function createActionFingerprint(
  executionId: string,
  stepId: string,
  inputHash: string
): string {
  return `sha256:${createHash("sha256")
    .update(`${executionId}:${stepId}:${inputHash}`)
    .digest("hex")}`;
}

/**
 * An execution may make two total attempts for the same failed action.
 */
export function canAttempt(previousAttempts: number): RetryDecision {
  if (!Number.isInteger(previousAttempts) || previousAttempts < 0) {
    throw new Error("previousAttempts must be a non-negative integer");
  }

  if (previousAttempts >= 2) {
    return { allowed: false, reason: "retry_budget_exhausted" };
  }

  return { allowed: true };
}
