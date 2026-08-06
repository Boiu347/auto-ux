import { createHash, randomBytes } from "node:crypto";

export type DevicePairingRecord = {
  id: string;
  userId: string;
  workspaceId: string;
  codeHash: string;
  browserTokenHash: string;
  deviceTokenHash: string | null;
  agentId: string | null;
  version: string | null;
  expiresAt: Date;
  claimedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

export type DeviceTaskStatus =
  | "queued"
  | "claimed"
  | "codex_opened"
  | "prompt_sent"
  | "failed";

export type DeviceTaskRecord = {
  id: string;
  pairingId: string;
  requestId: string;
  executionId: string;
  prompt: string;
  phoneFilePath: string;
  status: DeviceTaskStatus;
  attempt: number;
  claimTokenHash: string | null;
  leaseExpiresAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface DeviceStore {
  createPairing(record: DevicePairingRecord): Promise<void>;
  findPairingByBrowserTokenHash(hash: string): Promise<DevicePairingRecord | null>;
  claimPairing(input: {
    codeHash: string;
    deviceTokenHash: string;
    agentId: string;
    version: string;
    now: Date;
  }): Promise<
    | { status: "claimed"; pairing: DevicePairingRecord }
    | { status: "not_found" }
    | { status: "expired" }
    | { status: "already_claimed" }
  >;
  findPairingByDeviceTokenHash(hash: string): Promise<DevicePairingRecord | null>;
  touchDevice(pairingId: string, now: Date): Promise<void>;
  createTask(record: DeviceTaskRecord): Promise<DeviceTaskRecord>;
  activateExecutionToken(input: {
    executionId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
  claimNextTask(input: {
    pairingId: string;
    claimTokenHash: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<DeviceTaskRecord | null>;
  updateTask(input: {
    pairingId: string;
    taskId: string;
    claimTokenHash: string;
    status: "codex_opened" | "prompt_sent" | "failed";
    errorCode?: string;
    now: Date;
  }): Promise<DeviceTaskRecord | null>;
}

type DeviceServiceOptions = {
  now?: () => Date;
  randomHex?: (bytes: number) => string;
};

const BrowserTokenPattern = /^browser_token:[a-f0-9]{64}$/;
const DeviceTokenPattern = /^device_token:[a-f0-9]{64}$/;
const ClaimTokenPattern = /^task_claim:[a-f0-9]{64}$/;
const AgentIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RequestIdPattern = /^request_[a-f0-9]{16,64}$/;
const ExecutionIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const ExecutionTokenPlaceholder = "__AUTO_UX_EXECUTION_TOKEN__";

export class DeviceService {
  private readonly now: () => Date;
  private readonly randomHex: (bytes: number) => string;

  constructor(
    private readonly store: DeviceStore,
    options: DeviceServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomHex =
      options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
  }

  async createPairing(): Promise<{
    pairingId: string;
    code: string;
    browserToken: string;
    expiresAt: string;
  }> {
    const createdAt = this.now();
    const code = this.randomHex(4).toUpperCase();
    const browserToken = `browser_token:${this.randomHex(32)}`;
    const record: DevicePairingRecord = {
      id: `Pairing_${this.randomHex(8)}`,
      userId: `User_${this.randomHex(8)}`,
      workspaceId: `Workspace_${this.randomHex(8)}`,
      codeHash: hashSecret(code),
      browserTokenHash: hashSecret(browserToken),
      deviceTokenHash: null,
      agentId: null,
      version: null,
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
      claimedAt: null,
      lastSeenAt: null,
      createdAt
    };
    await this.store.createPairing(record);
    return {
      pairingId: record.id,
      code,
      browserToken,
      expiresAt: record.expiresAt.toISOString()
    };
  }

  async getBrowserPairing(browserToken: string): Promise<{
    pairingId: string;
    status: "waiting_for_mac" | "paired" | "expired";
    agentId: string | null;
    version: string | null;
    online: boolean;
    lastSeenAt: string | null;
  } | null> {
    if (!BrowserTokenPattern.test(browserToken)) return null;
    const pairing = await this.store.findPairingByBrowserTokenHash(
      hashSecret(browserToken)
    );
    if (!pairing) return null;
    const now = this.now();
    const status = pairing.claimedAt
      ? "paired"
      : pairing.expiresAt <= now
        ? "expired"
        : "waiting_for_mac";
    return {
      pairingId: pairing.id,
      status,
      agentId: pairing.agentId,
      version: pairing.version,
      online:
        Boolean(pairing.claimedAt && pairing.lastSeenAt) &&
        now.getTime() - pairing.lastSeenAt!.getTime() <= 15_000,
      lastSeenAt: pairing.lastSeenAt?.toISOString() ?? null
    };
  }

  async getBrowserScope(browserToken: string): Promise<{
    pairingId: string;
    userId: string;
    workspaceId: string;
    agentId: string;
  }> {
    const pairing = await this.requireBrowserPairing(browserToken);
    if (!pairing.claimedAt || !pairing.agentId) throw new Error("DEVICE_NOT_PAIRED");
    return {
      pairingId: pairing.id,
      userId: pairing.userId,
      workspaceId: pairing.workspaceId,
      agentId: pairing.agentId
    };
  }

  async claimPairing(input: {
    code: string;
    agentId: string;
    version: string;
  }): Promise<{
    pairingId: string;
    deviceToken: string;
    agentId: string;
  }> {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(code) || !AgentIdPattern.test(input.agentId)) {
      throw new Error("INVALID_PAIRING_REQUEST");
    }
    if (!VersionPattern.test(input.version)) {
      throw new Error("INVALID_PAIRING_REQUEST");
    }
    const deviceToken = `device_token:${this.randomHex(32)}`;
    const result = await this.store.claimPairing({
      codeHash: hashSecret(code),
      deviceTokenHash: hashSecret(deviceToken),
      agentId: input.agentId,
      version: input.version,
      now: this.now()
    });
    if (result.status === "not_found") throw new Error("PAIRING_NOT_FOUND");
    if (result.status === "expired") throw new Error("PAIRING_EXPIRED");
    if (result.status === "already_claimed") {
      throw new Error("PAIRING_ALREADY_CLAIMED");
    }
    if (result.status !== "claimed") throw new Error("PAIRING_NOT_FOUND");
    return { pairingId: result.pairing.id, deviceToken, agentId: input.agentId };
  }

  async enqueueTask(
    browserToken: string,
    input: {
      requestId: string;
      executionId: string;
      prompt: string;
      phoneFilePath: string;
    }
  ): Promise<DeviceTaskRecord> {
    const pairing = await this.requireBrowserPairing(browserToken);
    if (!pairing.claimedAt) throw new Error("DEVICE_NOT_PAIRED");
    if (
      !RequestIdPattern.test(input.requestId) ||
      !ExecutionIdPattern.test(input.executionId) ||
      !input.prompt ||
      Buffer.byteLength(input.prompt, "utf8") > 32 * 1024 ||
      !input.phoneFilePath.startsWith("/") ||
      /[\r\n\0]/.test(input.phoneFilePath)
    ) {
      throw new Error("INVALID_TASK");
    }
    const timestamp = this.now();
    return this.store.createTask({
      id: `Task_${this.randomHex(8)}`,
      pairingId: pairing.id,
      requestId: input.requestId,
      executionId: input.executionId,
      prompt: input.prompt,
      phoneFilePath: input.phoneFilePath,
      status: "queued",
      attempt: 0,
      claimTokenHash: null,
      leaseExpiresAt: null,
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  async claimNextTask(deviceToken: string): Promise<(
    DeviceTaskRecord & { claimToken: string }
  ) | null> {
    const pairing = await this.requireDevicePairing(deviceToken);
    const now = this.now();
    await this.store.touchDevice(pairing.id, now);
    const claimToken = `task_claim:${this.randomHex(32)}`;
    const task = await this.store.claimNextTask({
      pairingId: pairing.id,
      claimTokenHash: hashSecret(claimToken),
      now,
      leaseExpiresAt: new Date(now.getTime() + 30_000)
    });
    if (!task) return null;
    if (!task.prompt.includes(ExecutionTokenPlaceholder)) {
      return { ...task, claimToken };
    }
    const executionToken = `execution_token:${this.randomHex(32)}`;
    await this.store.activateExecutionToken({
      executionId: task.executionId,
      tokenHash: hashSecret(executionToken),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000)
    });
    return {
      ...task,
      prompt: task.prompt.replace(ExecutionTokenPlaceholder, executionToken),
      claimToken
    };
  }

  async updateTask(
    deviceToken: string,
    taskId: string,
    input: {
      claimToken: string;
      status: "codex_opened" | "prompt_sent" | "failed";
      errorCode?: string;
    }
  ): Promise<DeviceTaskRecord> {
    const pairing = await this.requireDevicePairing(deviceToken);
    if (!ClaimTokenPattern.test(input.claimToken)) {
      throw new Error("TASK_CLAIM_MISMATCH");
    }
    if (
      input.status === "failed" &&
      (!input.errorCode || !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.errorCode))
    ) {
      throw new Error("INVALID_TASK_RESULT");
    }
    const updated = await this.store.updateTask({
      pairingId: pairing.id,
      taskId,
      claimTokenHash: hashSecret(input.claimToken),
      status: input.status,
      errorCode: input.errorCode,
      now: this.now()
    });
    if (!updated) throw new Error("TASK_CLAIM_MISMATCH");
    return updated;
  }

  private async requireBrowserPairing(token: string): Promise<DevicePairingRecord> {
    if (!BrowserTokenPattern.test(token)) throw new Error("UNAUTHENTICATED");
    const pairing = await this.store.findPairingByBrowserTokenHash(hashSecret(token));
    if (!pairing) throw new Error("UNAUTHENTICATED");
    return pairing;
  }

  private async requireDevicePairing(token: string): Promise<DevicePairingRecord> {
    if (!DeviceTokenPattern.test(token)) throw new Error("UNAUTHENTICATED");
    const pairing = await this.store.findPairingByDeviceTokenHash(hashSecret(token));
    if (!pairing?.claimedAt) throw new Error("UNAUTHENTICATED");
    return pairing;
  }
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
