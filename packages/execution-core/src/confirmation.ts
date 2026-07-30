import { randomUUID } from "node:crypto";

import {
  ConfirmationActionSchema,
  type ConfirmationAction
} from "@app/contracts";

declare const confirmationGrantBrand: unique symbol;

export interface ConfirmationToken {
  readonly id: string;
  readonly action: ConfirmationAction;
  readonly executionId: string;
  readonly configVersion: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

/** An opaque proof that a specific in-memory token was consumed successfully. */
export interface ConfirmationGrant {
  readonly [confirmationGrantBrand]: never;
}

export type ConfirmationConsumption =
  | { ok: true; grant: ConfirmationGrant }
  | {
      ok: false;
      reason:
        | "already_consumed"
        | "expired"
        | "invalidated"
        | "invalid_token"
        | "action_mismatch"
        | "execution_mismatch"
        | "config_version_mismatch";
    };

interface TokenRecord {
  action: ConfirmationAction;
  executionId: string;
  configVersion: number;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  invalidated: boolean;
}

interface GrantRecord {
  token: TokenRecord;
  used: boolean;
}

const tokenRecords = new WeakMap<object, TokenRecord>();
const grantRecords = new WeakMap<object, GrantRecord>();
const tokenRecordsByBinding = new Map<string, Set<TokenRecord>>();

/**
 * Issues an immutable, in-memory one-time confirmation bound to one action and execution.
 */
export function issueConfirmation(
  action: ConfirmationAction,
  executionId: string,
  configVersion: number,
  expiresAt: Date
): ConfirmationToken {
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

  const record: TokenRecord = {
    action: validatedAction,
    executionId,
    configVersion,
    issuedAt: Date.now(),
    expiresAt: expiresAt.getTime(),
    consumedAt: null,
    invalidated: false
  };
  const token = createToken(record);
  tokenRecords.set(token, record);
  addTokenRecord(record);
  return token;
}

/**
 * Consumes a token and returns an opaque, single-transition grant on success.
 */
export function consumeConfirmation(
  token: ConfirmationToken,
  action: ConfirmationAction,
  executionId: string,
  configVersion: number
): ConfirmationConsumption {
  const requestedAction = ConfirmationActionSchema.parse(action);
  const record = tokenRecords.get(token);

  if (!record) {
    return { ok: false, reason: "invalid_token" };
  }
  if (record.invalidated) {
    return { ok: false, reason: "invalidated" };
  }
  if (record.consumedAt !== null) {
    return { ok: false, reason: "already_consumed" };
  }
  if (record.action !== requestedAction) {
    return { ok: false, reason: "action_mismatch" };
  }
  if (record.executionId !== executionId) {
    return { ok: false, reason: "execution_mismatch" };
  }
  if (record.configVersion !== configVersion) {
    return { ok: false, reason: "config_version_mismatch" };
  }
  if (record.expiresAt <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  record.consumedAt = Date.now();
  const grant = Object.freeze({}) as ConfirmationGrant;
  grantRecords.set(grant, { token: record, used: false });
  return { ok: true, grant };
}

/** Internal state-machine boundary: validates and consumes a grant exactly once. */
export function takeConfirmationGrant(
  grant: ConfirmationGrant | undefined,
  action: ConfirmationAction,
  executionId: string,
  configVersion: number
): boolean {
  if (!grant || typeof grant !== "object") {
    return false;
  }

  const grantRecord = grantRecords.get(grant);
  if (!grantRecord || grantRecord.used || grantRecord.token.invalidated) {
    return false;
  }

  const token = grantRecord.token;
  if (
    token.action !== action ||
    token.executionId !== executionId ||
    token.configVersion !== configVersion
  ) {
    return false;
  }

  grantRecord.used = true;
  return true;
}

/** Invalidates all prior tokens and grants bound to a recovered high-risk action. */
export function invalidateConfirmations(
  action: ConfirmationAction,
  executionId: string,
  configVersion: number
): void {
  for (const record of tokenRecordsByBinding.get(bindingKey(action, executionId, configVersion)) ?? []) {
    record.invalidated = true;
  }
}

function createToken(record: TokenRecord): ConfirmationToken {
  const token = {} as ConfirmationToken;
  Object.defineProperties(token, {
    id: { enumerable: true, value: randomUUID() },
    action: { enumerable: true, value: record.action },
    executionId: { enumerable: true, value: record.executionId },
    configVersion: { enumerable: true, value: record.configVersion },
    issuedAt: { enumerable: true, get: () => new Date(record.issuedAt) },
    expiresAt: { enumerable: true, get: () => new Date(record.expiresAt) },
    consumedAt: {
      enumerable: true,
      get: () => (record.consumedAt === null ? null : new Date(record.consumedAt))
    }
  });
  return Object.freeze(token);
}

function addTokenRecord(record: TokenRecord): void {
  const key = bindingKey(record.action, record.executionId, record.configVersion);
  const records = tokenRecordsByBinding.get(key) ?? new Set<TokenRecord>();
  records.add(record);
  tokenRecordsByBinding.set(key, records);
}

function bindingKey(
  action: ConfirmationAction,
  executionId: string,
  configVersion: number
): string {
  return `${action}:${executionId}:${configVersion}`;
}
