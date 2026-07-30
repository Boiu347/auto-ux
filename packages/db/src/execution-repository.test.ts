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
});
