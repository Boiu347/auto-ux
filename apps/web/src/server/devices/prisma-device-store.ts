import { prisma } from "@app/db";

import type {
  DevicePairingRecord,
  DeviceStore,
  DeviceTaskRecord
} from "./device-service";

export class PrismaDeviceStore implements DeviceStore {
  async createPairing(record: DevicePairingRecord): Promise<void> {
    await prisma.$transaction(async (transaction) => {
      await transaction.user.create({ data: { id: record.userId } });
      await transaction.workspace.create({ data: { id: record.workspaceId } });
      await transaction.workspaceMember.create({
        data: { userId: record.userId, workspaceId: record.workspaceId }
      });
      await transaction.devicePairing.create({ data: record });
    });
  }

  async findPairingByBrowserTokenHash(
    hash: string
  ): Promise<DevicePairingRecord | null> {
    return prisma.devicePairing.findUnique({ where: { browserTokenHash: hash } });
  }

  async claimPairing(input: {
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
  > {
    return prisma.$transaction(async (transaction) => {
      const pairing = await transaction.devicePairing.findUnique({
        where: { codeHash: input.codeHash }
      });
      if (!pairing) return { status: "not_found" as const };
      if (pairing.claimedAt) return { status: "already_claimed" as const };
      if (pairing.expiresAt <= input.now) return { status: "expired" as const };

      const claimed = await transaction.devicePairing.updateMany({
        where: {
          id: pairing.id,
          claimedAt: null,
          expiresAt: { gt: input.now }
        },
        data: {
          deviceTokenHash: input.deviceTokenHash,
          agentId: input.agentId,
          version: input.version,
          claimedAt: input.now,
          lastSeenAt: input.now
        }
      });
      if (claimed.count !== 1) {
        return { status: "already_claimed" as const };
      }
      await transaction.localAgent.upsert({
        where: { id: input.agentId },
        create: {
          id: input.agentId,
          workspaceId: pairing.workspaceId,
          version: input.version,
          capabilities: {
            contractVersion: "1",
            feishuCli: true,
            browser: true,
            delivery: "mac_helper"
          },
          lastHeartbeatAt: input.now
        },
        update: {
          version: input.version,
          lastHeartbeatAt: input.now
        }
      });
      return {
        status: "claimed" as const,
        pairing: (await transaction.devicePairing.findUniqueOrThrow({
          where: { id: pairing.id }
        })) satisfies DevicePairingRecord
      };
    });
  }

  async findPairingByDeviceTokenHash(
    hash: string
  ): Promise<DevicePairingRecord | null> {
    return prisma.devicePairing.findUnique({ where: { deviceTokenHash: hash } });
  }

  async touchDevice(pairingId: string, now: Date): Promise<void> {
    await prisma.$transaction(async (transaction) => {
      const pairing = await transaction.devicePairing.update({
        where: { id: pairingId },
        data: { lastSeenAt: now }
      });
      if (pairing.agentId) {
        await transaction.localAgent.updateMany({
          where: { id: pairing.agentId, workspaceId: pairing.workspaceId },
          data: { lastHeartbeatAt: now }
        });
      }
    });
  }

  async createTask(record: DeviceTaskRecord): Promise<DeviceTaskRecord> {
    return prisma.deviceTask.upsert({
      where: {
        pairingId_requestId: {
          pairingId: record.pairingId,
          requestId: record.requestId
        }
      },
      create: record,
      update: {}
    });
  }

  async activateExecutionToken(input: {
    executionId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await prisma.execution.update({
      where: { id: input.executionId },
      data: {
        agentAccessTokenHash: input.tokenHash,
        agentAccessExpiresAt: input.expiresAt
      }
    });
  }

  async claimNextTask(input: {
    pairingId: string;
    claimTokenHash: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<DeviceTaskRecord | null> {
    return prisma.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "DeviceTask"
        WHERE "pairingId" = ${input.pairingId}
          AND (
            "status" = 'queued'
            OR ("status" IN ('claimed', 'codex_opened', 'waiting_permission') AND "leaseExpiresAt" <= ${input.now})
          )
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      const candidate = candidates[0];
      if (!candidate) return null;
      return transaction.deviceTask.update({
        where: { id: candidate.id },
        data: {
          status: "claimed",
          attempt: { increment: 1 },
          claimTokenHash: input.claimTokenHash,
          leaseExpiresAt: input.leaseExpiresAt,
          errorCode: null,
          updatedAt: input.now
        }
      });
    });
  }

  async updateTask(input: {
    pairingId: string;
    taskId: string;
    claimTokenHash: string;
    status: "codex_opened" | "waiting_permission" | "prompt_sent" | "failed";
    errorCode?: string;
    now: Date;
  }): Promise<DeviceTaskRecord | null> {
    const updated = await prisma.deviceTask.updateMany({
      where: {
        id: input.taskId,
        pairingId: input.pairingId,
        claimTokenHash: input.claimTokenHash,
        status: { in: ["claimed", "codex_opened", "waiting_permission"] },
        leaseExpiresAt: { gt: input.now }
      },
      data: {
        status: input.status,
        errorCode: input.errorCode ?? null,
        leaseExpiresAt:
          input.status === "prompt_sent" || input.status === "failed"
            ? null
            : new Date(input.now.getTime() + 30_000),
        updatedAt: input.now
      }
    });
    if (updated.count !== 1) return null;
    return prisma.deviceTask.findUnique({ where: { id: input.taskId } });
  }
}
