import { describe, expect, it } from "vitest";

import {
  DeviceService,
  type DevicePairingRecord,
  type DeviceStore,
  type DeviceTaskRecord
} from "./device-service";

class MemoryDeviceStore implements DeviceStore {
  pairings: DevicePairingRecord[] = [];
  tasks: DeviceTaskRecord[] = [];
  activatedTokenHash: string | null = null;

  async createPairing(record: DevicePairingRecord): Promise<void> {
    this.pairings.push(record);
  }

  async findPairingByBrowserTokenHash(hash: string) {
    return this.pairings.find((pairing) => pairing.browserTokenHash === hash) ?? null;
  }

  async claimPairing(input: {
    codeHash: string;
    deviceTokenHash: string;
    agentId: string;
    version: string;
    now: Date;
  }) {
    const pairing = this.pairings.find((candidate) => candidate.codeHash === input.codeHash);
    if (!pairing) return { status: "not_found" as const };
    if (pairing.expiresAt <= input.now) return { status: "expired" as const };
    if (pairing.claimedAt) return { status: "already_claimed" as const };
    pairing.deviceTokenHash = input.deviceTokenHash;
    pairing.agentId = input.agentId;
    pairing.version = input.version;
    pairing.claimedAt = input.now;
    pairing.lastSeenAt = input.now;
    return { status: "claimed" as const, pairing };
  }

  async findPairingByDeviceTokenHash(hash: string) {
    return this.pairings.find((pairing) => pairing.deviceTokenHash === hash) ?? null;
  }

  async touchDevice(input: {
    pairingId: string;
    now: Date;
    version?: string;
  }): Promise<void> {
    const pairing = this.pairings.find((candidate) => candidate.id === input.pairingId);
    if (pairing) {
      pairing.lastSeenAt = input.now;
      if (input.version) pairing.version = input.version;
    }
  }

  async createTask(record: DeviceTaskRecord) {
    const duplicate = this.tasks.find(
      (task) => task.pairingId === record.pairingId && task.requestId === record.requestId
    );
    if (duplicate) return duplicate;
    this.tasks.push(record);
    return record;
  }

  async activateExecutionToken(input: { tokenHash: string }): Promise<void> {
    this.activatedTokenHash = input.tokenHash;
  }

  async claimNextTask(input: {
    pairingId: string;
    claimTokenHash: string;
    now: Date;
    leaseExpiresAt: Date;
  }) {
    const task = this.tasks.find(
      (candidate) =>
        candidate.pairingId === input.pairingId &&
        (candidate.status === "queued" ||
          (["claimed", "codex_opened", "waiting_permission"].includes(candidate.status) &&
            candidate.leaseExpiresAt !== null &&
            candidate.leaseExpiresAt <= input.now))
    );
    if (!task) return null;
    task.status = "claimed";
    task.claimTokenHash = input.claimTokenHash;
    task.leaseExpiresAt = input.leaseExpiresAt;
    task.attempt += 1;
    task.updatedAt = input.now;
    return task;
  }

  async updateTask(input: {
    pairingId: string;
    taskId: string;
    claimTokenHash: string;
    status: "codex_opened" | "waiting_permission" | "prompt_sent" | "failed";
    errorCode?: string;
    now: Date;
  }) {
    const task = this.tasks.find(
      (candidate) =>
        candidate.id === input.taskId &&
        candidate.pairingId === input.pairingId &&
        candidate.claimTokenHash === input.claimTokenHash
    );
    if (!task || !["claimed", "codex_opened", "waiting_permission"].includes(task.status)) return null;
    task.status = input.status;
    task.errorCode = input.errorCode ?? null;
    task.updatedAt = input.now;
    if (input.status === "prompt_sent" || input.status === "failed") {
      task.leaseExpiresAt = null;
    }
    return task;
  }
}

const now = new Date("2026-08-06T04:00:00.000Z");
const scope = { userId: "User_1", workspaceId: "Workspace_1" };

function service(store = new MemoryDeviceStore()) {
  let counter = 0;
  return {
    store,
    service: new DeviceService(store, {
      now: () => now,
      randomHex: (bytes) => (++counter).toString(16).padStart(bytes * 2, "0")
    })
  };
}

describe("DeviceService", () => {
  it("creates a single-use pairing and binds the current browser", async () => {
    const fixture = service();
    const created = await fixture.service.createPairing(scope);

    expect(created.code).toMatch(/^[A-F0-9]{8}$/);
    expect(created.browserToken).toMatch(/^browser_token:[a-f0-9]{64}$/);
    expect(created.expiresAt).toBe("2026-08-06T04:10:00.000Z");
    expect(await fixture.service.getBrowserPairing(created.browserToken, scope)).toMatchObject({
      status: "waiting_for_mac",
      online: false
    });
  });

  it("claims a pairing once and never returns the stored device token", async () => {
    const fixture = service();
    const created = await fixture.service.createPairing(scope);
    const claimed = await fixture.service.claimPairing({
      code: created.code,
      agentId: "MacAgent_1",
      version: "0.1.0"
    });

    expect(claimed.deviceToken).toMatch(/^device_token:[a-f0-9]{64}$/);
    expect(await fixture.service.getBrowserPairing(created.browserToken, scope)).toMatchObject({
      status: "paired",
      agentId: "MacAgent_1",
      online: true
    });
    await expect(
      fixture.service.claimPairing({
        code: created.code,
        agentId: "MacAgent_2",
        version: "0.1.0"
      })
    ).rejects.toThrow("PAIRING_ALREADY_CLAIMED");
  });

  it("does not expose a pairing to a different signed-in account", async () => {
    const fixture = service();
    const created = await fixture.service.createPairing(scope);
    const otherScope = { userId: "User_2", workspaceId: "Workspace_1" };

    await expect(
      fixture.service.getBrowserPairing(created.browserToken, otherScope)
    ).resolves.toBeNull();
    await expect(
      fixture.service.getBrowserScope(created.browserToken, otherScope)
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it("updates the paired Agent version from an authenticated poll", async () => {
    const fixture = service();
    const created = await fixture.service.createPairing(scope);
    const claimed = await fixture.service.claimPairing({
      code: created.code,
      agentId: "MacAgent_1",
      version: "0.1.0"
    });

    await expect(fixture.service.claimNextTask(claimed.deviceToken, "0.4.3"))
      .resolves.toBeNull();
    expect(await fixture.service.getBrowserPairing(created.browserToken, scope)).toMatchObject({
      version: "0.4.3",
      online: true
    });
    await expect(fixture.service.claimNextTask(claimed.deviceToken, "bad version"))
      .rejects.toThrow("INVALID_AGENT_VERSION");
  });

  it("queues idempotently and leases a task to the paired Mac", async () => {
    const fixture = service();
    const created = await fixture.service.createPairing(scope);
    const claimed = await fixture.service.claimPairing({
      code: created.code,
      agentId: "MacAgent_1",
      version: "0.1.0"
    });
    const first = await fixture.service.enqueueTask(created.browserToken, {
      requestId: "request_1234567890abcdef",
      executionId: "Execution_1",
      prompt: "Use the skill",
      phoneFilePath: "/Users/demo/phones.xlsx"
    });
    const duplicate = await fixture.service.enqueueTask(created.browserToken, {
      requestId: "request_1234567890abcdef",
      executionId: "Execution_2",
      prompt: "Must not replace the first prompt",
      phoneFilePath: "/Users/demo/other.xlsx"
    });

    expect(duplicate.id).toBe(first.id);
    const leased = await fixture.service.claimNextTask(claimed.deviceToken);
    expect(leased).toMatchObject({
      id: first.id,
      executionId: "Execution_1",
      prompt: "Use the skill",
      phoneFilePath: "/Users/demo/phones.xlsx",
      attempt: 1
    });
    expect(leased?.claimToken).toMatch(/^task_claim:[a-f0-9]{64}$/);
    expect(await fixture.service.claimNextTask(claimed.deviceToken)).toBeNull();
  });

  it("accepts a terminal task result only with the active claim token", async () => {
    const fixture = service();
    const created = await fixture.service.createPairing(scope);
    const claimed = await fixture.service.claimPairing({
      code: created.code,
      agentId: "MacAgent_1",
      version: "0.1.0"
    });
    await fixture.service.enqueueTask(created.browserToken, {
      requestId: "request_1234567890abcdef",
      executionId: "Execution_1",
      prompt: "Use the skill",
      phoneFilePath: "/Users/demo/phones.xlsx"
    });
    const task = await fixture.service.claimNextTask(claimed.deviceToken);

    await expect(
      fixture.service.updateTask(claimed.deviceToken, task!.id, {
        claimToken: `task_claim:${"f".repeat(64)}`,
        status: "prompt_sent"
      })
    ).rejects.toThrow("TASK_CLAIM_MISMATCH");
    expect(
      await fixture.service.updateTask(claimed.deviceToken, task!.id, {
        claimToken: task!.claimToken,
        status: "prompt_sent"
      })
    ).toMatchObject({ status: "prompt_sent" });
  });

  it("keeps the execution bearer out of storage and signs it only when claimed", async () => {
    const fixture = service();
    const created = await fixture.service.createPairing(scope);
    const claimed = await fixture.service.claimPairing({
      code: created.code,
      agentId: "MacAgent_1",
      version: "0.1.0"
    });
    await fixture.service.enqueueTask(created.browserToken, {
      requestId: "request_1234567890abcdef",
      executionId: "Execution_1",
      prompt: "token=__AUTO_UX_EXECUTION_TOKEN__",
      phoneFilePath: "/Users/demo/phones.xlsx"
    });

    const task = await fixture.service.claimNextTask(claimed.deviceToken);

    expect(fixture.store.tasks[0]?.prompt).toBe("token=__AUTO_UX_EXECUTION_TOKEN__");
    expect(task?.prompt).toMatch(/^token=execution_token:[a-f0-9]{64}$/);
    expect(fixture.store.activatedTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
