import { PrismaClient } from "@prisma/client";
import type { ExecutionEvent } from "@app/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaExecutionRepository } from "./execution-repository.js";

const prisma = new PrismaClient();
const repository = new PrismaExecutionRepository(prisma, {
  userId: "U-1",
  workspaceId: "W-1"
});

const event: ExecutionEvent = {
  executionId: "placeholder",
  stepId: "environment.preflight",
  attempt: 1,
  status: "running",
  occurredAt: "2026-07-30T00:00:00.000Z",
  inputHash: "sha256:abcdef",
  evidence: {
    kind: "checkpoint",
    summary: { phase: "environment_preflight", status: "running" },
    reference: { kind: "checkpoint", id: "checkpoint:0123456789abcdef" }
  },
  nextAction: "retry_preflight"
};

describe("PrismaExecutionRepository", () => {
  beforeEach(async () => {
    await prisma.executionStep.deleteMany();
    await prisma.executionOperation.deleteMany();
    await prisma.confirmation.deleteMany();
    await prisma.robotBinding.deleteMany();
    await prisma.auditEvent.deleteMany();
    await prisma.execution.deleteMany();
    await prisma.configDraft.deleteMany();
    await prisma.localAgent.deleteMany();
    await prisma.workspaceMember.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("does not return an execution to a different user", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });

    await expect(
      repository.findByIdForUser(execution.id, "U-2", "W-1")
    ).resolves.toBeNull();
  });

  it("does not let a differently scoped repository access an execution", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const otherRepository = new PrismaExecutionRepository(prisma, {
      userId: "U-2",
      workspaceId: "W-1"
    });
    const executionEvent = { ...event, executionId: execution.id };

    await expect(otherRepository.appendStepEvent(executionEvent)).rejects.toThrow();
    await expect(otherRepository.listStepEvents(execution.id)).rejects.toThrow();
    await expect(otherRepository.acquireLock(execution.id, "agent-2", 60)).resolves.toBe(false);
  });

  it("rejects a duplicate execution step event", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const executionEvent = { ...event, executionId: execution.id };

    await repository.appendStepEvent(executionEvent);

    await expect(repository.appendStepEvent(executionEvent)).rejects.toThrow();
  });

  it("allows only one unexpired agent lock", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });

    await expect(repository.acquireLock(execution.id, "agent-1", 60)).resolves.toBe(true);
    await expect(repository.acquireLock(execution.id, "agent-2", 60)).resolves.toBe(false);
  });

  it("allows exactly one winner under concurrent lock contention", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        repository.acquireLock(execution.id, `agent-${index}`, 60)
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not claim a running or succeeded operation twice", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });

    const firstClaim = await repository.claimOperation(execution.id, "fingerprint-1");
    await expect(repository.claimOperation(execution.id, "fingerprint-1")).resolves.toEqual({
      claimed: false
    });
    await repository.completeOperation(execution.id, "fingerprint-1", firstClaim.attempt!, "succeeded");
    await expect(repository.claimOperation(execution.id, "fingerprint-1")).resolves.toEqual({
      claimed: false
    });
  });

  it("allows a failed operation to be claimed as a new attempt", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });

    const firstClaim = await repository.claimOperation(execution.id, "fingerprint-1");
    await repository.completeOperation(execution.id, "fingerprint-1", firstClaim.attempt!, "failed");

    await expect(repository.claimOperation(execution.id, "fingerprint-1")).resolves.toEqual({
      claimed: true,
      attempt: 2
    });
  });

  it("allows the same operation fingerprint in a different execution", async () => {
    const firstExecution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const secondExecution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 2
    });

    await expect(repository.claimOperation(firstExecution.id, "fingerprint-1")).resolves.toEqual({
      claimed: true,
      attempt: 1
    });
    await expect(repository.claimOperation(secondExecution.id, "fingerprint-1")).resolves.toEqual({
      claimed: true,
      attempt: 1
    });
  });

  it("rejects tenant-inconsistent execution relations in PostgreSQL", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    await prisma.user.create({ data: { id: "U-2" } });
    await prisma.workspace.create({ data: { id: "W-2" } });
    await prisma.workspaceMember.create({
      data: { userId: "U-2", workspaceId: "W-2" }
    });
    await prisma.localAgent.create({
      data: {
        id: "agent-W-2",
        workspaceId: "W-2",
        version: "1.0.0",
        capabilities: {}
      }
    });

    await expect(
      prisma.execution.create({
        data: {
          id: "execution_cross_tenant",
          userId: "U-2",
          workspaceId: "W-1",
          configVersion: 1,
          status: "pending",
          phase: "source_parse",
          targetPolicy: "create_only"
        }
      })
    ).rejects.toThrow();
    await expect(
      prisma.confirmation.create({
        data: {
          id: "confirmation_cross_tenant",
          executionId: execution.id,
          userId: "U-2",
          workspaceId: "W-1",
          action: "publish",
          configVersion: 1,
          tokenHash: "sha256:abcdef",
          expiresAt: new Date("2026-07-30T01:00:00.000Z")
        }
      })
    ).rejects.toThrow();
    await expect(
      prisma.robotBinding.create({
        data: {
          workspaceId: "W-1",
          executionId: execution.id,
          agentId: "agent-W-2",
          platformRobotRef: "robot:0123456789abcdef",
          displayName: "robot"
        }
      })
    ).rejects.toThrow();
    await expect(
      prisma.auditEvent.create({
        data: {
          workspaceId: "W-1",
          actorUserId: "U-2",
          executionId: execution.id,
          action: "configure",
          facts: {}
        }
      })
    ).rejects.toThrow();
  });

  it("rejects invalid durable policy values through the raw client", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const claim = await repository.claimOperation(execution.id, "fingerprint-1");

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Execution" SET "targetPolicy" = 'mutate_existing'`
      )
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "Execution" SET "status" = 'not_a_status'`)
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "Execution" SET "phase" = 'not_a_phase'`)
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "ExecutionOperation" SET "status" = 'not_an_operation_status'`
      )
    ).rejects.toThrow();
    expect(claim.claimed).toBe(true);
  });

  it("constrains step status, next action, and audit action in PostgreSQL", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    await repository.appendStepEvent({ ...event, executionId: execution.id });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "ExecutionStep" SET "status" = 'not_a_status'`)
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "ExecutionStep" SET "nextAction" = 'guess_success'`)
    ).rejects.toThrow();
    await prisma.auditEvent.create({
      data: {
        workspaceId: "W-1",
        actorUserId: "U-1",
        executionId: execution.id,
        action: "configure",
        facts: {}
      }
    });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "action" = 'not_an_audit_action'`)
    ).rejects.toThrow();
  });

  it("preserves unknown step outcomes and accepts the documented audit actions", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    await repository.appendStepEvent({
      ...event,
      executionId: execution.id,
      status: "unknown",
      nextAction: "wait_for_user"
    });

    for (const action of ["configure", "publish", "import_numbers", "start_dial"] as const) {
      await prisma.auditEvent.create({
        data: {
          workspaceId: "W-1",
          actorUserId: "U-1",
          executionId: execution.id,
          action,
          facts: {}
        }
      });
    }

    await expect(repository.listStepEvents(execution.id)).resolves.toMatchObject([
      { status: "unknown", nextAction: "wait_for_user" }
    ]);
    await expect(prisma.auditEvent.count()).resolves.toBe(4);
  });

  it("rejects raw phone and source fields at the repository boundary", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });

    await expect(
      repository.appendStepEvent({
        ...event,
        executionId: execution.id,
        evidence: {
          ...event.evidence,
          rawPhone: "13800138000",
          rawSource: "untrusted upload"
        }
      } as unknown as ExecutionEvent)
    ).rejects.toThrow();
  });
});
