import { randomUUID } from "node:crypto";

import {
  ConfirmationActionSchema,
  type ConfirmationAction
} from "@app/contracts";

export interface ConfirmationToken {
  readonly id: string;
  readonly action: ConfirmationAction;
  readonly executionId: string;
  readonly configVersion: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  consumedAt: Date | null;
}

export type ConfirmationConsumption =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "already_consumed"
        | "expired"
        | "action_mismatch"
        | "execution_mismatch"
        | "config_version_mismatch";
    };

/**
 * Issues an in-memory one-time confirmation bound to one action and execution.
 */
export function issueConfirmation(
  action: ConfirmationAction,
  executionId: string,
  configVersion: number,
  expiresAt: Date
): ConfirmationToken {
  const issuedAt = new Date();
  const validatedAction = ConfirmationActionSchema.parse(action);

  if (!executionId) {
    throw new Error("executionId is required");
  }
  if (!Number.isInteger(configVersion) || configVersion <= 0) {
    throw new Error("configVersion must be a positive integer");
  }
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("expiresAt must be a valid date");
  }

  return {
    id: randomUUID(),
    action: validatedAction,
    executionId,
    configVersion,
    issuedAt,
    expiresAt: new Date(expiresAt),
    consumedAt: null
  };
}

/**
 * Atomically consumes the in-memory token after all binding and expiry checks.
 */
export function consumeConfirmation(
  token: ConfirmationToken,
  action: ConfirmationAction,
  executionId: string,
  configVersion: number
): ConfirmationConsumption {
  const requestedAction = ConfirmationActionSchema.parse(action);

  if (token.consumedAt) {
    return { ok: false, reason: "already_consumed" };
  }
  if (token.action !== requestedAction) {
    return { ok: false, reason: "action_mismatch" };
  }
  if (token.executionId !== executionId) {
    return { ok: false, reason: "execution_mismatch" };
  }
  if (token.configVersion !== configVersion) {
    return { ok: false, reason: "config_version_mismatch" };
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  token.consumedAt = new Date();
  return { ok: true };
}
