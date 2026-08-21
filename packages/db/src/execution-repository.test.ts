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

async function waitForPendingAdvisoryLock(
  client: PrismaClient,
  lockId: number
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const locks = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM pg_locks
      WHERE "locktype" = 'advisory'
        AND "objid" = ${lockId}
        AND "granted" = false`;
    if ((locks[0]?.count ?? 0n) > 0n) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("confirmation issuance never reached the blocked insert");
}

async function waitForPendingDatabaseLock(client: PrismaClient): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const locks = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM pg_locks
      WHERE "locktype" <> 'advisory'
        AND "granted" = false`;
    if ((locks[0]?.count ?? 0n) > 0n) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("concurrent issuance never waited on the execution row lock");
}

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

  it("persists real Codex mode and resolves only the matching active credential", async () => {
    const tokenHash = "b".repeat(64);
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1,
      mode: "real_codex",
      agentAccessTokenHash: tokenHash,
      agentAccessExpiresAt: new Date("2099-08-06T05:00:00.000Z")
    });

    expect(execution.mode).toBe("real_codex");
    await expect(
      repository.findScopeByAgentTokenHash(tokenHash, execution.id)
    ).resolves.toEqual({
      userId: "U-1",
      workspaceId: "W-1",
      mode: "real_codex",
      tokenExpiresAt: new Date("2099-08-06T05:00:00.000Z")
    });
    await expect(
      repository.findScopeByAgentTokenHash("c".repeat(64), execution.id)
    ).resolves.toBeNull();
    await expect(
      repository.findScopeByAgentTokenHash(tokenHash, "execution_missing")
    ).resolves.toBeNull();

    const otherRepository = new PrismaExecutionRepository(prisma, {
      userId: "U-2",
      workspaceId: "W-2"
    });
    await expect(
      otherRepository.findScopeByAgentTokenHash(tokenHash, execution.id)
    ).resolves.toBeNull();
  });

  it("does not resolve an expired real Codex credential", async () => {
    const tokenHash = "d".repeat(64);
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1,
      mode: "real_codex",
      agentAccessTokenHash: tokenHash,
      agentAccessExpiresAt: new Date("2000-08-06T05:00:00.000Z")
    });

    await expect(
      repository.findScopeByAgentTokenHash(tokenHash, execution.id)
    ).resolves.toBeNull();
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

  it("atomically registers one exact plugin session and rejects lock contention", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const manifest = {
      pluginVersion: "simulator-1.0.0",
      contractVersion: "2" as const,
      capabilities: {
        feishuCli: true as const,
        baiduApi: true as const,
        browserFallback: true as const
      },
      agentId: "agent-owner",
      sessionId: "session-owner",
      executionId: execution.id
    };

    await expect(
      repository.claimExecutionAgent({ manifest, ttlSeconds: 60 })
    ).resolves.toBe("claimed");
    await expect(
      repository.claimExecutionAgent({
        manifest: {
          ...manifest,
          agentId: "agent-other",
          sessionId: "session-other"
        },
        ttlSeconds: 60
      })
    ).resolves.toBe("locked");
    await expect(
      repository.claimExecutionAgent({
        manifest: { ...manifest, sessionId: "session-duplicate" },
        ttlSeconds: 60
      })
    ).resolves.toBe("session_mismatch");

    await expect(
      prisma.execution.findUniqueOrThrow({ where: { id: execution.id } })
    ).resolves.toMatchObject({
      executionLockAgentId: "agent-owner",
      executionLockSessionId: "session-owner"
    });
    await expect(
      prisma.localAgent.findUniqueOrThrow({ where: { id: "agent-owner" } })
    ).resolves.toMatchObject({
      workspaceId: "W-1",
      version: "simulator-1.0.0",
      capabilities: {
        contractVersion: "2",
        feishuCli: true,
        baiduApi: true,
        browserFallback: true,
        sessionId: "session-owner",
        executionId: execution.id
      }
    });
  });

  it("renews heartbeat only for the exact current session binding", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const manifest = {
      pluginVersion: "simulator-1.0.0",
      contractVersion: "2" as const,
      capabilities: {
        feishuCli: true as const,
        baiduApi: true as const,
        browserFallback: true as const
      },
      agentId: "agent-owner",
      sessionId: "session-owner",
      executionId: execution.id
    };
    await repository.claimExecutionAgent({ manifest, ttlSeconds: 60 });

    await expect(
      repository.heartbeatExecutionAgent({
        executionId: execution.id,
        agentId: manifest.agentId,
        sessionId: "session-wrong",
        ttlSeconds: 60
      })
    ).resolves.toBe("lock_mismatch");
    await expect(
      repository.heartbeatExecutionAgent({
        executionId: execution.id,
        agentId: manifest.agentId,
        sessionId: manifest.sessionId,
        ttlSeconds: 60
      })
    ).resolves.toBe("renewed");

    const heartbeat = await prisma.localAgent.findUniqueOrThrow({
      where: { id: manifest.agentId }
    });
    expect(heartbeat.lastHeartbeatAt).toEqual(expect.any(Date));
  });

  it("accepts agent events only from the exact claimed session", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const manifest = {
      pluginVersion: "simulator-1.0.0",
      contractVersion: "2" as const,
      capabilities: {
        feishuCli: true as const,
        baiduApi: true as const,
        browserFallback: true as const
      },
      agentId: "agent-owner",
      sessionId: "session-owner",
      executionId: execution.id
    };
    await repository.claimExecutionAgent({ manifest, ttlSeconds: 60 });
    const sourceEvent = {
      ...event,
      executionId: execution.id,
      stepId: "source.parse" as const,
      evidence: {
        kind: "checkpoint" as const,
        summary: { phase: "source_parse" as const, status: "running" as const },
        reference: {
          kind: "checkpoint" as const,
          id: "checkpoint:eeeeeeeeeeeeeeee"
        }
      }
    };
    const append = (sessionId: string) =>
      repository.appendStepEventForAgent({
        agentId: manifest.agentId,
        sessionId,
        event: sourceEvent,
        expectedState: { status: "pending", phase: "source_parse" },
        nextState: { status: "running", phase: "source_parse" }
      });

    await expect(append("session-foreign")).resolves.toBe("lock_mismatch");
    await expect(repository.listStepEvents(execution.id)).resolves.toEqual([]);
    await expect(append("session-owner")).resolves.toBe("appended");
  });

  it("binds plugin sessions per execution instead of globally per agent", async () => {
    const first = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const second = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 2
    });
    const baseManifest = {
      pluginVersion: "simulator-1.0.0",
      contractVersion: "2" as const,
      capabilities: {
        feishuCli: true as const,
        baiduApi: true as const,
        browserFallback: true as const
      },
      agentId: "agent-owner"
    };

    await expect(
      repository.claimExecutionAgent({
        manifest: {
          ...baseManifest,
          sessionId: "session-first",
          executionId: first.id
        },
        ttlSeconds: 60
      })
    ).resolves.toBe("claimed");
    await expect(
      repository.claimExecutionAgent({
        manifest: {
          ...baseManifest,
          sessionId: "session-second",
          executionId: second.id
        },
        ttlSeconds: 60
      })
    ).resolves.toBe("claimed");
  });

  it("returns the locked agent heartbeat only inside the execution workspace", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const heartbeatAt = new Date("2026-07-30T08:00:00.000Z");
    await prisma.localAgent.create({
      data: {
        id: "agent-owner",
        workspaceId: "W-1",
        version: "1.0.0",
        capabilities: {},
        lastHeartbeatAt: heartbeatAt
      }
    });
    await repository.acquireLock(execution.id, "agent-owner", 60);

    await expect(
      repository.findExecutionAgentHeartbeat(execution.id)
    ).resolves.toEqual({ agentId: "agent-owner", lastHeartbeatAt: heartbeatAt });

    const otherRepository = new PrismaExecutionRepository(prisma, {
      userId: "U-2",
      workspaceId: "W-2"
    });
    await expect(
      otherRepository.findExecutionAgentHeartbeat(execution.id)
    ).resolves.toBeNull();
  });

  it("returns no current agent once PostgreSQL considers the lock expired", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const heartbeatAt = new Date("2026-07-30T08:00:00.000Z");
    await prisma.localAgent.create({
      data: {
        id: "agent-expiring",
        workspaceId: "W-1",
        version: "1.0.0",
        capabilities: {},
        lastHeartbeatAt: heartbeatAt
      }
    });
    await prisma.$executeRaw`
      UPDATE "Execution"
      SET "executionLockAgentId" = 'agent-expiring',
          "executionLockExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute'
      WHERE "id" = ${execution.id}`;

    await expect(
      repository.findExecutionAgentHeartbeat(execution.id)
    ).resolves.toEqual({
      agentId: "agent-expiring",
      lastHeartbeatAt: heartbeatAt
    });

    await prisma.$executeRaw`
      UPDATE "Execution"
      SET "executionLockExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = ${execution.id}`;

    await expect(
      repository.findExecutionAgentHeartbeat(execution.id)
    ).resolves.toBeNull();
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

  it("rejects a third operation attempt after two failed attempts", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });

    const firstClaim = await repository.claimOperation(execution.id, "fingerprint-1");
    await repository.completeOperation(execution.id, "fingerprint-1", firstClaim.attempt!, "failed");
    const secondClaim = await repository.claimOperation(execution.id, "fingerprint-1");
    await repository.completeOperation(execution.id, "fingerprint-1", secondClaim.attempt!, "failed");

    await expect(repository.claimOperation(execution.id, "fingerprint-1")).resolves.toEqual({
      claimed: false
    });
    await expect(
      prisma.executionOperation.count({
        where: { executionId: execution.id, fingerprint: "fingerprint-1" }
      })
    ).resolves.toBe(2);
  });

  it("allows only one concurrent retry and never exceeds two failed attempts", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });

    const firstClaim = await repository.claimOperation(execution.id, "fingerprint-1");
    await repository.completeOperation(execution.id, "fingerprint-1", firstClaim.attempt!, "failed");

    const retryClaims = await Promise.all(
      Array.from({ length: 24 }, () =>
        repository.claimOperation(execution.id, "fingerprint-1")
      )
    );
    expect(retryClaims.filter((claim) => claim.claimed)).toEqual([
      { claimed: true, attempt: 2 }
    ]);

    await repository.completeOperation(execution.id, "fingerprint-1", 2, "failed");
    const exhaustedClaims = await Promise.all(
      Array.from({ length: 24 }, () =>
        repository.claimOperation(execution.id, "fingerprint-1")
      )
    );
    expect(exhaustedClaims.every((claim) => !claim.claimed)).toBe(true);
    await expect(
      prisma.executionOperation.count({
        where: { executionId: execution.id, fingerprint: "fingerprint-1" }
      })
    ).resolves.toBe(2);
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
      evidence: {
        kind: "checkpoint",
        summary: { phase: "environment_preflight", status: "unknown" },
        reference: {
          kind: "checkpoint",
          id: "checkpoint:0123456789abcdef"
        }
      },
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

  it("allows exactly one event transaction to consume a confirmation", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const confirmation = await repository.createConfirmation({
      id: "confirm:1111111111111111",
      executionId: execution.id,
      action: "publish",
      configVersion: 1,
      tokenHash: "sha256:1111111111111111",
      expiresAt: new Date(Date.now() + 60_000)
    });

    await repository.acquireLock(execution.id, "agent-owner", 60);
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        repository.appendStepEventForAgent({
          agentId: "agent-owner",
          event: {
            ...event,
            executionId: execution.id,
            stepId: "source.parse"
          },
          expectedState: { status: "pending", phase: "source_parse" },
          nextState: { status: "running", phase: "source_parse" },
          confirmation: {
            confirmationId: confirmation.id,
            executionId: execution.id,
            action: "publish",
            configVersion: 1,
            tokenHash: "sha256:1111111111111111"
          }
        })
      )
    );

    expect(results.filter((result) => result === "appended")).toHaveLength(1);
    await expect(
      repository.findConfirmation({
        confirmationId: confirmation.id,
        executionId: execution.id,
        action: "publish",
        configVersion: 1,
        tokenHash: "sha256:1111111111111111"
      })
    ).resolves.toBeNull();
  });

  it("serializes concurrent issuance for the same exact confirmation gate", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    await repository.acquireLock(execution.id, "agent-owner", 60);
    await prisma.execution.update({
      where: { id: execution.id },
      data: { status: "waiting_confirmation", phase: "publish_confirm" }
    });

    const blocker = new PrismaClient();
    let releaseBlocker!: () => void;
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let markBlockerReady!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      markBlockerReady = resolve;
    });

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "pause_first_confirmation_insert"()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = 'confirm:race_first' THEN
          PERFORM pg_advisory_xact_lock(70431);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "pause_first_confirmation_insert"
      BEFORE INSERT ON "Confirmation"
      FOR EACH ROW EXECUTE FUNCTION "pause_first_confirmation_insert"()`);

    const blockerTask = blocker.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SELECT pg_advisory_xact_lock(70431)");
      markBlockerReady();
      await blockerRelease;
    });

    try {
      await blockerReady;
      const expiresAt = new Date(Date.now() + 60_000);
      const first = repository.createConfirmationForGate({
        id: "confirm:race_first",
        executionId: execution.id,
        action: "publish",
        configVersion: 1,
        tokenHash: "sha256:race_first",
        expiresAt,
        agentId: "agent-owner",
        expectedState: {
          status: "waiting_confirmation",
          phase: "publish_confirm"
        }
      });
      await waitForPendingAdvisoryLock(prisma, 70431);

      const second = repository.createConfirmationForGate({
        id: "confirm:race_second",
        executionId: execution.id,
        action: "publish",
        configVersion: 1,
        tokenHash: "sha256:race_second",
        expiresAt,
        agentId: "agent-owner",
        expectedState: {
          status: "waiting_confirmation",
          phase: "publish_confirm"
        }
      });
      const secondBeforeRelease = await Promise.race([
        second.then(() => "completed" as const),
        waitForPendingDatabaseLock(prisma).then(() => "blocked" as const)
      ]);
      expect(secondBeforeRelease).toBe("blocked");

      releaseBlocker();
      await blockerTask;
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { status: "created" },
        { status: "created" }
      ]);
      await expect(
        prisma.confirmation.count({
          where: {
            executionId: execution.id,
            action: "publish",
            configVersion: 1,
            consumedAt: null,
            expiresAt: { gt: new Date() }
          }
        })
      ).resolves.toBe(1);
    } finally {
      releaseBlocker();
      await blockerTask.catch(() => undefined);
      await blocker.$disconnect();
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "pause_first_confirmation_insert" ON "Confirmation"`
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "pause_first_confirmation_insert"()`
      );
    }
  });

  it("binds confirmation consumption without consuming a mismatched record", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 3
    });
    const confirmation = await repository.createConfirmation({
      id: "confirm:2222222222222222",
      executionId: execution.id,
      action: "start_dial",
      configVersion: 3,
      tokenHash: "sha256:2222222222222222",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const otherRepository = new PrismaExecutionRepository(prisma, {
      userId: "U-2",
      workspaceId: "W-1"
    });

    for (const mismatch of [
      { action: "publish" as const },
      { executionId: "execution_other" },
      { configVersion: 4 },
      { tokenHash: "sha256:wrong" }
    ]) {
      await expect(
        repository.findConfirmation({
          confirmationId: confirmation.id,
          executionId: execution.id,
          action: "start_dial",
          configVersion: 3,
          tokenHash: "sha256:2222222222222222",
          ...mismatch
        })
      ).resolves.toBeNull();
    }
    await expect(
      otherRepository.findConfirmation({
        confirmationId: confirmation.id,
        executionId: execution.id,
        action: "start_dial",
        configVersion: 3,
        tokenHash: "sha256:2222222222222222"
      })
    ).resolves.toBeNull();
    await expect(
      repository.findConfirmation({
        confirmationId: confirmation.id,
        executionId: execution.id,
        action: "start_dial",
        configVersion: 3,
        tokenHash: "sha256:2222222222222222"
      })
    ).resolves.toMatchObject({
      id: confirmation.id,
      userId: "U-1",
      workspaceId: "W-1",
      action: "start_dial",
      configVersion: 3
    });
  });

  it("rejects expired confirmations and rehydrates an unconsumed record after restart", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 5
    });
    const expired = await repository.createConfirmation({
      id: "confirm:3333333333333333",
      executionId: execution.id,
      action: "import_numbers",
      configVersion: 5,
      tokenHash: "sha256:3333333333333333",
      expiresAt: new Date(Date.now() - 1_000)
    });
    const durable = await repository.createConfirmation({
      id: "confirm:4444444444444444",
      executionId: execution.id,
      action: "import_numbers",
      configVersion: 5,
      tokenHash: "sha256:4444444444444444",
      expiresAt: new Date(Date.now() + 60_000)
    });

    await expect(
      repository.findConfirmation({
        confirmationId: expired.id,
        executionId: execution.id,
        action: "import_numbers",
        configVersion: 5,
        tokenHash: "sha256:3333333333333333"
      })
    ).resolves.toBeNull();

    const restartedRepository = new PrismaExecutionRepository(prisma, {
      userId: "U-1",
      workspaceId: "W-1"
    });
    await expect(
      restartedRepository.findConfirmation({
        confirmationId: durable.id,
        executionId: execution.id,
        action: "import_numbers",
        configVersion: 5,
        tokenHash: "sha256:4444444444444444"
      })
    ).resolves.toMatchObject({
      id: durable.id,
      executionId: execution.id,
      action: "import_numbers",
      consumedAt: null
    });
  });

  it("lists persisted step events with a reconnect-safe insertion cursor", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    await repository.appendStepEvent({
      ...event,
      executionId: execution.id,
      attempt: 1
    });
    await repository.appendStepEvent({
      ...event,
      executionId: execution.id,
      attempt: 2,
      stepId: "robot.create"
    });

    const allEvents = await repository.listStepEventsAfter(execution.id);
    expect(allEvents.map(({ event: persisted }) => persisted.stepId)).toEqual([
      "environment.preflight",
      "robot.create"
    ]);
    await expect(
      repository.listStepEventsAfter(execution.id, allEvents[0]!.cursor)
    ).resolves.toMatchObject([
      {
        cursor: allEvents[1]!.cursor,
        event: { stepId: "robot.create" }
      }
    ]);
  });

  it("atomically rechecks the agent lock and expected execution state when appending", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    await repository.acquireLock(execution.id, "agent-owner", 60);
    const executionEvent = {
      ...event,
      executionId: execution.id,
      stepId: "source.parse" as const
    };

    await expect(
      repository.appendStepEventForAgent({
        agentId: "agent-other",
        event: executionEvent,
        expectedState: { status: "pending", phase: "source_parse" },
        nextState: { status: "running", phase: "source_parse" }
      })
    ).resolves.toBe("lock_mismatch");
    await expect(
      repository.appendStepEventForAgent({
        agentId: "agent-owner",
        event: executionEvent,
        expectedState: { status: "pending", phase: "source_parse" },
        nextState: { status: "running", phase: "source_parse" }
      })
    ).resolves.toBe("appended");
    await expect(
      repository.appendStepEventForAgent({
        agentId: "agent-owner",
        event: { ...executionEvent, attempt: 2 },
        expectedState: { status: "pending", phase: "source_parse" },
        nextState: { status: "succeeded", phase: "source_parse" }
      })
    ).resolves.toBe("state_mismatch");
    await expect(
      repository.findByIdForUser(execution.id, "U-1", "W-1")
    ).resolves.toMatchObject({
      status: "running",
      phase: "source_parse"
    });
  });

  it("consumes confirmation only inside a successful event transaction", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const eventInput = {
      ...event,
      executionId: execution.id,
      stepId: "source.parse" as const
    };
    const firstConfirmation = await repository.createConfirmation({
      id: "confirm:5555555555555555",
      executionId: execution.id,
      action: "publish",
      configVersion: 1,
      tokenHash: "sha256:5555555555555555",
      expiresAt: new Date(Date.now() + 60_000)
    });

    await expect(
      repository.appendStepEventForAgent({
        agentId: "agent-owner",
        event: eventInput,
        expectedState: { status: "pending", phase: "source_parse" },
        nextState: { status: "running", phase: "source_parse" },
        confirmation: {
          confirmationId: firstConfirmation.id,
          executionId: execution.id,
          action: "publish",
          configVersion: 1,
          tokenHash: "sha256:5555555555555555"
        }
      })
    ).resolves.toBe("lock_mismatch");
    await repository.acquireLock(execution.id, "agent-owner", 60);
    await expect(
      repository.appendStepEventForAgent({
        agentId: "agent-owner",
        event: eventInput,
        expectedState: { status: "running", phase: "source_parse" },
        nextState: { status: "running", phase: "source_parse" },
        confirmation: {
          confirmationId: firstConfirmation.id,
          executionId: execution.id,
          action: "publish",
          configVersion: 1,
          tokenHash: "sha256:5555555555555555"
        }
      })
    ).resolves.toBe("state_mismatch");
    await expect(
      repository.findConfirmation({
        confirmationId: firstConfirmation.id,
        executionId: execution.id,
        action: "publish",
        configVersion: 1,
        tokenHash: "sha256:5555555555555555"
      })
    ).resolves.toMatchObject({ id: firstConfirmation.id });

    const secondConfirmation = await repository.createConfirmation({
      id: "confirm:6666666666666666",
      executionId: execution.id,
      action: "publish",
      configVersion: 1,
      tokenHash: "sha256:6666666666666666",
      expiresAt: new Date(Date.now() + 60_000)
    });
    await expect(
      repository.appendStepEventForAgent({
        agentId: "agent-owner",
        event: eventInput,
        expectedState: { status: "pending", phase: "source_parse" },
        nextState: { status: "running", phase: "source_parse" },
        confirmation: {
          confirmationId: secondConfirmation.id,
          executionId: execution.id,
          action: "publish",
          configVersion: 1,
          tokenHash: "sha256:6666666666666666"
        }
      })
    ).resolves.toBe("appended");
    await expect(
      repository.findConfirmation({
        confirmationId: secondConfirmation.id,
        executionId: execution.id,
        action: "publish",
        configVersion: 1,
        tokenHash: "sha256:6666666666666666"
      })
    ).resolves.toBeNull();
  });

  it("rejects a cursor issued for another execution or tenant", async () => {
    const first = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const second = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 2
    });
    await repository.appendStepEvent({ ...event, executionId: first.id });
    await repository.appendStepEvent({ ...event, executionId: second.id });
    const foreignCursor = (await repository.listStepEventsAfter(second.id))[0]!
      .cursor;

    await expect(
      repository.listStepEventsAfter(first.id, foreignCursor)
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    const otherTenantRepository = new PrismaExecutionRepository(prisma, {
      userId: "U-2",
      workspaceId: "W-2"
    });
    const otherTenantExecution = await otherTenantRepository.create({
      userId: "U-2",
      workspaceId: "W-2",
      configVersion: 1
    });
    await otherTenantRepository.appendStepEvent({
      ...event,
      executionId: otherTenantExecution.id
    });
    const otherTenantCursor = (
      await otherTenantRepository.listStepEventsAfter(otherTenantExecution.id)
    )[0]!.cursor;
    await expect(
      repository.listStepEventsAfter(first.id, otherTenantCursor)
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      otherTenantRepository.listStepEventsAfter(first.id, foreignCursor)
    ).rejects.toThrow();
  });

  it("rejects a confirmation bound to a different execution without consuming it", async () => {
    const first = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const second = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const confirmation = await repository.createConfirmation({
      id: "confirm:7777777777777777",
      executionId: first.id,
      action: "publish",
      configVersion: 1,
      tokenHash: "sha256:7777777777777777",
      expiresAt: new Date(Date.now() + 60_000)
    });
    await repository.acquireLock(second.id, "agent-owner", 60);

    await expect(
      repository.appendStepEventForAgent({
        agentId: "agent-owner",
        event: { ...event, executionId: second.id, stepId: "source.parse" },
        expectedState: { status: "pending", phase: "source_parse" },
        nextState: { status: "running", phase: "source_parse" },
        confirmation: {
          confirmationId: confirmation.id,
          executionId: first.id,
          action: "publish",
          configVersion: 1,
          tokenHash: "sha256:7777777777777777"
        }
      })
    ).resolves.toBe("confirmation_invalid");
    await expect(
      repository.findConfirmation({
        confirmationId: confirmation.id,
        executionId: first.id,
        action: "publish",
        configVersion: 1,
        tokenHash: "sha256:7777777777777777"
      })
    ).resolves.toMatchObject({ id: confirmation.id, consumedAt: null });
    await expect(repository.listStepEvents(second.id)).resolves.toHaveLength(0);
  });

  it("rolls back confirmation consumption when event persistence fails", async () => {
    const execution = await repository.create({
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1
    });
    const duplicate = {
      ...event,
      executionId: execution.id,
      stepId: "source.parse" as const
    };
    await repository.appendStepEvent(duplicate);
    await repository.acquireLock(execution.id, "agent-owner", 60);
    const confirmation = await repository.createConfirmation({
      id: "confirm:8888888888888888",
      executionId: execution.id,
      action: "publish",
      configVersion: 1,
      tokenHash: "sha256:8888888888888888",
      expiresAt: new Date(Date.now() + 60_000)
    });

    await expect(
      repository.appendStepEventForAgent({
        agentId: "agent-owner",
        event: duplicate,
        expectedState: { status: "pending", phase: "source_parse" },
        nextState: { status: "running", phase: "source_parse" },
        confirmation: {
          confirmationId: confirmation.id,
          executionId: execution.id,
          action: "publish",
          configVersion: 1,
          tokenHash: "sha256:8888888888888888"
        }
      })
    ).rejects.toThrow();
    await expect(
      repository.findConfirmation({
        confirmationId: confirmation.id,
        executionId: execution.id,
        action: "publish",
        configVersion: 1,
        tokenHash: "sha256:8888888888888888"
      })
    ).resolves.toMatchObject({ id: confirmation.id, consumedAt: null });
  });
});
