import { createHash } from "node:crypto";

import type {
  AgentCapabilityManifest,
  ConfirmationAction,
  ExecutionEvent,
  ExecutionPhase,
  ExecutionStatus
} from "@app/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ExecutionService,
  type ConfirmationRecord,
  type ExecutionDataStore,
  type PersistedStepEvent
} from "../../../server/executions/service";
import { getCurrentUser } from "../../../server/auth/current-user";
import { createExecutionCollectionHandlers } from "./route";
import { createExecutionItemHandlers } from "./[executionId]/route";
import { createConfirmationHandler } from "./[executionId]/confirmations/route";
import { createEventsHandlers } from "./[executionId]/events/route";
import { createAgentClaimHandler } from "./[executionId]/agent/claim/route";
import { createAgentHeartbeatHandler } from "./[executionId]/agent/heartbeat/route";
import { createDevelopmentSessionHandlers } from "../dev/session/route";

const owner = { userId: "U-1", workspaceId: "W-1" };

const firstEvent: ExecutionEvent = {
  executionId: "EX-1",
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

const secondEvent: ExecutionEvent = {
  ...firstEvent,
  stepId: "robot.create",
  attempt: 2,
  occurredAt: "2026-07-30T00:00:01.000Z"
};

const highRiskTransitions = [
  {
    action: "publish" as const,
    currentPhase: "publish_confirm" as const,
    stepId: "publish.verify" as const,
    nextPhase: "publish_verify" as const
  },
  {
    action: "import_numbers" as const,
    currentPhase: "numbers_confirm" as const,
    stepId: "dial.confirm" as const,
    nextPhase: "dial_confirm" as const
  },
  {
    action: "start_dial" as const,
    currentPhase: "dial_confirm" as const,
    stepId: "dial.verify" as const,
    nextPhase: "call_verify" as const
  }
];

describe("execution events API", () => {
  it("uses the signed development cookie for summary, SSE, and confirmation routes", async () => {
    const secret = "test-secret-with-at-least-32-characters";
    const session = await createDevelopmentSessionHandlers({
      environment: "test",
      secret
    }).POST(
      new Request("http://localhost/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(owner)
      })
    );
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const authenticate = (request: Request) =>
      getCurrentUser(request, "test", secret);
    const store = new MemoryExecutionStore();
    store.execution = {
      ...executionRecord(),
      status: "waiting_confirmation",
      phase: "publish_confirm"
    };
    store.agentHeartbeat = {
      agentId: "agent-owner",
      lastHeartbeatAt: new Date("2026-07-30T08:00:00.000Z")
    };
    const item = createExecutionItemHandlers(resolve(store), authenticate);
    const events = createEventsHandlers(resolve(store), authenticate);
    const confirmation = createConfirmationHandler(resolve(store), authenticate);
    const browserRequest = (url: string, init?: RequestInit) =>
      new Request(url, {
        ...init,
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
          cookie
        }
      });

    const summary = await item.GET(
      browserRequest("http://localhost/api/executions/EX-1"),
      context("EX-1")
    );
    expect(summary.status).toBe(200);

    const stream = await events.GET(
      browserRequest("http://localhost/api/executions/EX-1/events"),
      context("EX-1")
    );
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();

    const issued = await confirmation(
      browserRequest("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          configVersion: 1,
          agentId: "agent-owner"
        })
      }),
      context("EX-1")
    );
    expect(issued.status).toBe(201);
  });

  it("rejects an event from an agent not holding the lock", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    store.lockAgentId = "agent-owner";
    const handlers = createEventsHandlers(() => new ExecutionService(store));

    const response = await handlers.POST(
      request("http://localhost/api/executions/EX-1/events", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-other",
          event: {
            ...firstEvent,
            stepId: "source.parse",
            evidence: {
              kind: "checkpoint",
              summary: { phase: "source_parse", status: "running" },
              reference: {
                kind: "checkpoint",
                id: "checkpoint:cccccccccccccccc"
              }
            }
          }
        })
      }),
      context("EX-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "EXECUTION_LOCK_MISMATCH"
    });
  });

  it("does not acquire an absent execution lock while appending an event", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    const handlers = createEventsHandlers(resolve(store));

    const response = await handlers.POST(
      request("http://localhost/api/executions/EX-1/events", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-unclaimed",
          event: { ...firstEvent, stepId: "source.parse" }
        })
      }),
      context("EX-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "EXECUTION_LOCK_MISMATCH"
    });
    expect(store.lockAgentId).toBeNull();
  });

  it("returns SSE events in persisted order and resumes after the last cursor", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    store.events = [
      { cursor: "cursor:EX-1:first", event: firstEvent },
      { cursor: "cursor:EX-1:second", event: secondEvent }
    ];
    const handlers = createEventsHandlers(() => new ExecutionService(store));

    const initial = await handlers.GET(
      request("http://localhost/api/executions/EX-1/events"),
      context("EX-1")
    );
    const initialMessages = await readFirstSseMessages(initial, 2);

    expect(initial.headers.get("content-type")).toContain("text/event-stream");
    expect(initialMessages.map(({ data }) => data.stepId)).toEqual([
      firstEvent.stepId,
      secondEvent.stepId
    ]);
    expect(initialMessages.map(({ id }) => id)).toEqual([
      "cursor:EX-1:first",
      "cursor:EX-1:second"
    ]);

    const resumed = await handlers.GET(
      request("http://localhost/api/executions/EX-1/events", {
        headers: { "last-event-id": "cursor:EX-1:first" }
      }),
      context("EX-1")
    );
    const resumedMessages = await readFirstSseMessages(resumed, 1);
    expect(resumedMessages).toMatchObject([
      { id: "cursor:EX-1:second", data: { stepId: secondEvent.stepId } }
    ]);
  });

  it("rejects an opaque cursor issued for another execution", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    store.events = [
      {
        cursor: "cursor:EX-2:first",
        event: { ...firstEvent, executionId: "EX-2" }
      }
    ];
    const handlers = createEventsHandlers(resolve(store));

    const response = await handlers.GET(
      request("http://localhost/api/executions/EX-1/events", {
        headers: { "last-event-id": "cursor:EX-2:first" }
      }),
      context("EX-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_CURSOR" });
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
  });

  it("requires development authentication and rejects unknown request fields", async () => {
    const store = new MemoryExecutionStore();
    const collection = createExecutionCollectionHandlers(resolve(store));

    const unauthenticated = await collection.POST(
      new Request("http://localhost/api/executions", {
        method: "POST",
        body: JSON.stringify({ configVersion: 1 })
      })
    );
    expect(unauthenticated.status).toBe(401);

    const invalid = await collection.POST(
      request("http://localhost/api/executions", {
        method: "POST",
        body: JSON.stringify({
          configVersion: 1,
          rawFeishuDocument: "must never be accepted"
        })
      })
    );
    expect(invalid.status).toBe(400);
    expect(store.execution).toBeNull();
  });

  it("rejects development header authentication in production", () => {
    expect(
      getCurrentUser(
        request("http://localhost/api/executions"),
        "production"
      )
    ).toBeNull();
  });

  it("creates and returns only the authenticated tenant's execution", async () => {
    const store = new MemoryExecutionStore();
    const collection = createExecutionCollectionHandlers(resolve(store));
    const item = createExecutionItemHandlers(resolve(store));

    const created = await collection.POST(
      request("http://localhost/api/executions", {
        method: "POST",
        body: JSON.stringify({ configVersion: 2 })
      })
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      execution: { id: string; targetPolicy: string; configVersion: number };
    };
    expect(createdBody.execution).toMatchObject({
      targetPolicy: "create_only",
      configVersion: 2
    });

    const found = await item.GET(
      request(`http://localhost/api/executions/${createdBody.execution.id}`),
      context(createdBody.execution.id)
    );
    expect(found.status).toBe(200);

    const otherTenant = await item.GET(
      requestAs(
        { userId: "U-2", workspaceId: "W-2" },
        `http://localhost/api/executions/${createdBody.execution.id}`
      ),
      context(createdBody.execution.id)
    );
    expect(otherTenant.status).toBe(404);
  });

  it("returns the persisted scoped agent heartbeat in the execution summary", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    store.agentHeartbeat = {
      agentId: "agent-owner",
      lastHeartbeatAt: new Date("2026-07-30T08:00:00.000Z")
    };
    const item = createExecutionItemHandlers(resolve(store));

    const response = await item.GET(
      request("http://localhost/api/executions/EX-1"),
      context("EX-1")
    );

    await expect(response.json()).resolves.toMatchObject({
      execution: {
        agentId: "agent-owner",
        agentHeartbeatAt: "2026-07-30T08:00:00.000Z"
      }
    });
  });

  it("returns no current agent facts when the scoped lock lookup is expired", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    store.agentHeartbeat = null;
    const item = createExecutionItemHandlers(resolve(store));

    const response = await item.GET(
      request("http://localhost/api/executions/EX-1"),
      context("EX-1")
    );

    await expect(response.json()).resolves.toMatchObject({
      execution: { agentId: null, agentHeartbeatAt: null }
    });
  });

  it("enforces tenant ownership for SSE before opening the stream", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    const handlers = createEventsHandlers(resolve(store));

    const response = await handlers.GET(
      requestAs(
        { userId: "U-2", workspaceId: "W-2" },
        "http://localhost/api/executions/EX-1/events"
      ),
      context("EX-1")
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
  });

  it("enforces tenant ownership for event and confirmation writes", async () => {
    const store = new MemoryExecutionStore();
    store.execution = {
      ...executionRecord(),
      status: "waiting_confirmation",
      phase: "publish_confirm"
    };
    const events = createEventsHandlers(resolve(store));
    const confirmation = createConfirmationHandler(resolve(store));
    const otherActor = { userId: "U-2", workspaceId: "W-2" };

    const eventResponse = await events.POST(
      requestAs(
        otherActor,
        "http://localhost/api/executions/EX-1/events",
        {
          method: "POST",
          body: JSON.stringify({
            agentId: "agent-other",
            event: firstEvent
          })
        }
      ),
      context("EX-1")
    );
    const confirmationResponse = await confirmation(
      requestAs(
        otherActor,
        "http://localhost/api/executions/EX-1/confirmations",
        {
          method: "POST",
          body: JSON.stringify({
            action: "publish",
            configVersion: 1,
            agentId: "agent-other"
          })
        }
      ),
      context("EX-1")
    );

    expect(eventResponse.status).toBe(404);
    expect(confirmationResponse.status).toBe(404);
    expect(store.events).toHaveLength(0);
    expect(store.confirmations).toHaveLength(0);
  });

  it("streams newly persisted events once after connection and heartbeats at 15 seconds", async () => {
    vi.useFakeTimers();
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    const handlers = createEventsHandlers(resolve(store));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const response = await handlers.GET(
        request("http://localhost/api/executions/EX-1/events"),
        context("EX-1")
      );
      reader = response.body!.getReader();
      const firstRead = reader.read();
      store.events.push({ cursor: "cursor:EX-1:first", event: firstEvent });

      await vi.advanceTimersByTimeAsync(15_000);
      const firstChunk = await firstRead;
      expect(new TextDecoder().decode(firstChunk.value)).toContain(
        `id: cursor:EX-1:first\nevent: execution-step\ndata: ${JSON.stringify(firstEvent)}`
      );

      const secondRead = reader.read();
      await vi.advanceTimersByTimeAsync(15_000);
      const secondChunk = await secondRead;
      expect(new TextDecoder().decode(secondChunk.value)).toBe(
        ": heartbeat\n\n"
      );
    } finally {
      await reader?.cancel();
      vi.useRealTimers();
    }
  });

  it("clears SSE timers when persisted event polling fails", async () => {
    vi.useFakeTimers();
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    const handlers = createEventsHandlers(resolve(store));

    try {
      const response = await handlers.GET(
        request("http://localhost/api/executions/EX-1/events"),
        context("EX-1")
      );
      const reader = response.body!.getReader();
      store.failEventListing = true;
      const failedRead = reader.read();
      const rejection = expect(failedRead).rejects.toThrow(
        "persisted event read failed"
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects raw or unrecognized event fields before persistence", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    const handlers = createEventsHandlers(resolve(store));

    const response = await handlers.POST(
      request("http://localhost/api/executions/EX-1/events", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-owner",
          event: {
            ...firstEvent,
            rawPhone: "13800138000"
          }
        })
      }),
      context("EX-1")
    );

    expect(response.status).toBe(400);
    expect(store.events).toHaveLength(0);
  });

  it("validates authoritative evidence for direct service callers", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    store.lockAgentId = "agent-owner";
    const service = new ExecutionService(store);
    const contradictoryEvent = {
      ...firstEvent,
      stepId: "source.parse",
      status: "succeeded"
    } as ExecutionEvent;

    await expect(
      service.appendEvent("agent-owner", contradictoryEvent)
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(store.events).toHaveLength(0);
    expect(store.execution).toMatchObject({
      status: "pending",
      phase: "source_parse"
    });
  });

  it("does not let unknown evidence bypass any high-risk confirmation gate", async () => {
    for (const transitionCase of highRiskTransitions) {
      const store = new MemoryExecutionStore();
      store.execution = {
        ...executionRecord(),
        status: "waiting_confirmation",
        phase: transitionCase.currentPhase
      };
      store.lockAgentId = "agent-owner";
      const service = new ExecutionService(store);

      await expect(
        service.appendEvent(
          "agent-owner",
          checkpointEvent(
            transitionCase.stepId,
            "unknown",
            transitionCase.nextPhase
          )
        )
      ).rejects.toMatchObject({ code: "INVALID_EXECUTION_TRANSITION" });
      expect(store.events).toHaveLength(0);
      expect(store.execution).toMatchObject({
        status: "waiting_confirmation",
        phase: transitionCase.currentPhase
      });
    }
  });

  it("does not consume confirmations for cross-phase running, failed, or unknown evidence", async () => {
    for (const transitionCase of highRiskTransitions) {
      for (const status of ["running", "failed", "unknown"] as const) {
        const store = new MemoryExecutionStore();
        store.execution = {
          ...executionRecord(),
          status: "waiting_confirmation",
          phase: transitionCase.currentPhase
        };
        store.lockAgentId = "agent-owner";
        store.agentHeartbeat = {
          agentId: "agent-owner",
          lastHeartbeatAt: new Date("2026-07-30T08:00:00.000Z")
        };
        const service = new ExecutionService(store);
        const proof = await service.issueCreatorConfirmation(
          "EX-1",
          transitionCase.action,
          1,
          "agent-owner"
        );

        await expect(
          service.appendEvent(
            "agent-owner",
            checkpointEvent(
              transitionCase.stepId,
              status,
              transitionCase.nextPhase
            ),
            proof
          )
        ).rejects.toMatchObject({ code: "INVALID_EXECUTION_TRANSITION" });
        expect(store.events).toHaveLength(0);
        expect(store.confirmations[0]?.confirmation.consumedAt).toBeNull();
        expect(store.execution).toMatchObject({
          status: "waiting_confirmation",
          phase: transitionCase.currentPhase
        });
      }
    }
  });

  it("issues only the separately requested action for the creator and config version", async () => {
    const store = new MemoryExecutionStore();
    store.execution = {
      ...executionRecord(),
      status: "waiting_confirmation",
      phase: "publish_confirm"
    };
    store.agentHeartbeat = {
      agentId: "agent-owner",
      lastHeartbeatAt: new Date("2026-07-30T08:00:00.000Z")
    };
    const confirmation = createConfirmationHandler(resolve(store));

    const wrongAction = await confirmation(
      request("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: "import_numbers",
          configVersion: 1,
          agentId: "agent-owner"
        })
      }),
      context("EX-1")
    );
    expect(wrongAction.status).toBe(409);

    const combined = await confirmation(
      request("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: ["publish", "import_numbers"],
          configVersion: 1,
          agentId: "agent-owner"
        })
      }),
      context("EX-1")
    );
    expect(combined.status).toBe(400);

    const stale = await confirmation(
      request("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          configVersion: 2,
          agentId: "agent-owner"
        })
      }),
      context("EX-1")
    );
    expect(stale.status).toBe(409);

    const issued = await confirmation(
      request("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          configVersion: 1,
          agentId: "agent-owner"
        })
      }),
      context("EX-1")
    );
    expect(issued.status).toBe(201);
    const payload = (await issued.json()) as {
      confirmation: {
        action: ConfirmationAction;
        executionId: string;
        configVersion: number;
        confirmationId: string;
        token: string;
      };
    };
    expect(payload.confirmation).toMatchObject({
      action: "publish",
      executionId: "EX-1",
      configVersion: 1
    });
    expect(store.confirmations[0]).not.toHaveProperty("token");
    expect(store.confirmations[0]?.tokenHash).toBe(
      `sha256:${createHash("sha256")
        .update(payload.confirmation.token)
        .digest("hex")}`
    );
  });

  it("supersedes an older live confirmation for the same exact gate", async () => {
    const store = confirmationGateStore();
    const service = new ExecutionService(store);

    const first = await service.issueCreatorConfirmation(
      "EX-1",
      "publish",
      1,
      "agent-owner"
    );
    const second = await service.issueCreatorConfirmation(
      "EX-1",
      "publish",
      1,
      "agent-owner"
    );

    await expect(
      service.appendEvent(
        "agent-owner",
        confirmedPublishEvent(1),
        first
      )
    ).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
    await expect(
      service.appendEvent(
        "agent-owner",
        confirmedPublishEvent(1),
        second
      )
    ).resolves.toBeUndefined();
    expect(store.events).toHaveLength(1);
  });

  it("serializes concurrent confirmation issuance so only one token remains live", async () => {
    const store = confirmationGateStore();
    const service = new ExecutionService(store);

    const [first, second] = await Promise.all([
      service.issueCreatorConfirmation("EX-1", "publish", 1, "agent-owner"),
      service.issueCreatorConfirmation("EX-1", "publish", 1, "agent-owner")
    ]);

    const appendResults = await Promise.allSettled([
      service.appendEvent(
        "agent-owner",
        confirmedPublishEvent(1),
        first
      ),
      service.appendEvent(
        "agent-owner",
        confirmedPublishEvent(2),
        second
      )
    ]);

    expect(
      appendResults.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      appendResults.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          "code" in result.reason &&
          result.reason.code === "CONFIRMATION_INVALID"
      )
    ).toHaveLength(1);
    expect(store.events).toHaveLength(1);
  });

  it("rejects a live confirmation replay after its exact gate has closed", async () => {
    const store = confirmationGateStore();
    const service = new ExecutionService(store);
    const issued = await service.issueCreatorConfirmation(
      "EX-1",
      "publish",
      1,
      "agent-owner"
    );
    const legacyReplay = {
      confirmationId: `confirm:${"b".repeat(32)}`,
      token: `confirm_token:${"c".repeat(64)}`,
      action: "publish" as const,
      configVersion: 1
    };
    store.confirmations.push({
      confirmation: {
        id: legacyReplay.confirmationId,
        executionId: "EX-1",
        userId: owner.userId,
        workspaceId: owner.workspaceId,
        action: legacyReplay.action,
        configVersion: legacyReplay.configVersion,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        consumedAt: null,
        createdAt: new Date("2026-07-30T08:00:01.000Z")
      },
      tokenHash: `sha256:${createHash("sha256")
        .update(legacyReplay.token)
        .digest("hex")}`
    });

    await service.appendEvent(
      "agent-owner",
      confirmedPublishEvent(1),
      issued
    );
    await expect(
      service.appendEvent(
        "agent-owner",
        confirmedPublishEvent(2),
        legacyReplay
      )
    ).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
    expect(store.events).toHaveLength(1);
    expect(store.execution).toMatchObject({
      status: "succeeded",
      phase: "publish_confirm"
    });
  });

  it("refuses to issue a confirmation for a bridge agent without the current lock", async () => {
    const store = new MemoryExecutionStore();
    store.execution = {
      ...executionRecord(),
      status: "waiting_confirmation",
      phase: "publish_confirm"
    };
    store.agentHeartbeat = {
      agentId: "agent-owner",
      lastHeartbeatAt: new Date("2026-07-30T08:00:00.000Z")
    };
    const confirmation = createConfirmationHandler(resolve(store));

    const response = await confirmation(
      request("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          configVersion: 1,
          agentId: "agent-other"
        })
      }),
      context("EX-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "EXECUTION_LOCK_MISMATCH"
    });
    expect(store.confirmations).toHaveLength(0);
  });

  it("refuses to issue a confirmation when no unexpired lock agent is authoritative", async () => {
    const store = new MemoryExecutionStore();
    store.execution = {
      ...executionRecord(),
      status: "waiting_confirmation",
      phase: "publish_confirm"
    };
    store.agentHeartbeat = null;
    const confirmation = createConfirmationHandler(resolve(store));

    const response = await confirmation(
      request("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          configVersion: 1,
          agentId: "agent-owner"
        })
      }),
      context("EX-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "EXECUTION_LOCK_MISMATCH"
    });
    expect(store.confirmations).toHaveLength(0);
  });

  it("atomically consumes one durable creator confirmation for one event", async () => {
    const store = new MemoryExecutionStore();
    store.execution = {
      ...executionRecord(),
      status: "waiting_confirmation",
      phase: "publish_confirm"
    };
    store.lockAgentId = "agent-owner";
    store.agentHeartbeat = {
      agentId: "agent-owner",
      lastHeartbeatAt: new Date("2026-07-30T08:00:00.000Z")
    };
    const confirmation = createConfirmationHandler(resolve(store));
    const events = createEventsHandlers(resolve(store));
    const issued = await confirmation(
      request("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          configVersion: 1,
          agentId: "agent-owner"
        })
      }),
      context("EX-1")
    );
    const issuedBody = (await issued.json()) as {
      confirmation: {
        confirmationId: string;
        token: string;
        action: ConfirmationAction;
        configVersion: number;
      };
    };
    const publishEvent: ExecutionEvent = {
      ...firstEvent,
      stepId: "publish.confirm",
      status: "succeeded",
      evidence: {
        kind: "checkpoint",
        summary: { phase: "publish_confirm", status: "succeeded" },
        reference: {
          kind: "checkpoint",
          id: "checkpoint:fedcba9876543210"
        }
      },
      nextAction: "stop"
    };
    const eventRequest = () =>
      request("http://localhost/api/executions/EX-1/events", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-owner",
          event: publishEvent,
          confirmation: {
            confirmationId: issuedBody.confirmation.confirmationId,
            token: issuedBody.confirmation.token,
            action: issuedBody.confirmation.action,
            configVersion: issuedBody.confirmation.configVersion
          }
        })
      });

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        events.POST(eventRequest(), context("EX-1"))
      )
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(
      1
    );
    expect(
      responses.filter((response) => response.status === 409)
    ).toHaveLength(11);
    expect(store.events).toHaveLength(1);
    expect(
      store.confirmations.filter(
        (record) => record.confirmation.consumedAt !== null
      )
    ).toHaveLength(1);
  });

  it("does not consume a durable confirmation when the transition is rejected", async () => {
    const store = new MemoryExecutionStore();
    store.execution = {
      ...executionRecord(),
      status: "waiting_confirmation",
      phase: "publish_confirm"
    };
    store.lockAgentId = "agent-owner";
    store.agentHeartbeat = {
      agentId: "agent-owner",
      lastHeartbeatAt: new Date("2026-07-30T08:00:00.000Z")
    };
    const confirmation = createConfirmationHandler(resolve(store));
    const events = createEventsHandlers(resolve(store));
    const issued = await confirmation(
      request("http://localhost/api/executions/EX-1/confirmations", {
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          configVersion: 1,
          agentId: "agent-owner"
        })
      }),
      context("EX-1")
    );
    const issuedBody = (await issued.json()) as {
      confirmation: {
        confirmationId: string;
        token: string;
        action: ConfirmationAction;
        configVersion: number;
      };
    };
    const proof = {
      confirmationId: issuedBody.confirmation.confirmationId,
      token: issuedBody.confirmation.token,
      action: issuedBody.confirmation.action,
      configVersion: issuedBody.confirmation.configVersion
    };
    const invalid = await events.POST(
      request("http://localhost/api/executions/EX-1/events", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-owner",
          event: { ...firstEvent, stepId: "source.parse" },
          confirmation: proof
        })
      }),
      context("EX-1")
    );
    expect(invalid.status).toBe(409);
    expect(store.confirmations[0]?.confirmation.consumedAt).toBeNull();

    const valid = await events.POST(
      request("http://localhost/api/executions/EX-1/events", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-owner",
          event: {
            ...firstEvent,
            stepId: "publish.confirm",
            status: "succeeded",
            nextAction: "stop",
            evidence: {
              kind: "checkpoint",
              summary: { phase: "publish_confirm", status: "succeeded" },
              reference: {
                kind: "checkpoint",
                id: "checkpoint:bbbbbbbbbbbbbbbb"
              }
            }
          },
          confirmation: proof
        })
      }),
      context("EX-1")
    );
    expect(valid.status).toBe(201);
    expect(store.confirmations[0]?.confirmation.consumedAt).toEqual(
      expect.any(Date)
    );

    const nextPhase = await events.POST(
      request("http://localhost/api/executions/EX-1/events", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-owner",
          event: checkpointEvent(
            "publish.verify",
            "running",
            "publish_verify"
          )
        })
      }),
      context("EX-1")
    );
    expect(nextPhase.status).toBe(201);
    expect(store.execution).toMatchObject({
      status: "running",
      phase: "publish_verify"
    });
  });

  it("preserves an unknown event as unknown execution state", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    store.lockAgentId = "agent-owner";
    const events = createEventsHandlers(resolve(store));
    const unknownEvent: ExecutionEvent = {
      ...firstEvent,
      stepId: "source.parse",
      status: "unknown",
      evidence: {
        kind: "checkpoint",
        summary: { phase: "source_parse", status: "unknown" },
        reference: {
          kind: "checkpoint",
          id: "checkpoint:aaaaaaaaaaaaaaaa"
        }
      },
      nextAction: "wait_for_user"
    };

    const response = await events.POST(
      request("http://localhost/api/executions/EX-1/events", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-owner",
          event: unknownEvent
        })
      }),
      context("EX-1")
    );

    expect(response.status).toBe(201);
    expect(store.execution?.status).toBe("unknown");
  });

  it("claims and heartbeats one exact compatible local-agent session", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    const claim = createAgentClaimHandler(resolve(store));
    const heartbeat = createAgentHeartbeatHandler(resolve(store));
    const agentManifest = {
      pluginVersion: "simulator-1.0.0",
      contractVersion: "1",
      capabilities: { feishuCli: true, browser: true },
      agentId: "agent-owner",
      sessionId: "session-owner",
      executionId: "EX-1"
    };

    const claimed = await claim(
      request("http://localhost/api/executions/EX-1/agent/claim", {
        method: "POST",
        body: JSON.stringify(agentManifest)
      }),
      context("EX-1")
    );
    expect(claimed.status).toBe(201);
    await expect(claimed.json()).resolves.toMatchObject({
      pluginSessionCount: 1,
      configVersion: 1,
      events: []
    });

    const renewed = await heartbeat(
      request("http://localhost/api/executions/EX-1/agent/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          agentId: agentManifest.agentId,
          sessionId: agentManifest.sessionId
        })
      }),
      context("EX-1")
    );
    expect(renewed.status).toBe(200);
    expect(store.lockSessionId).toBe("session-owner");
    expect(store.heartbeatCount).toBe(1);

    const events = createEventsHandlers(resolve(store));
    const sourceEvent: ExecutionEvent = {
      ...firstEvent,
      stepId: "source.parse",
      evidence: {
        kind: "checkpoint",
        summary: { phase: "source_parse", status: "running" },
        reference: { kind: "checkpoint", id: "checkpoint:dddddddddddddddd" }
      }
    };
    const postEvent = (sessionId: string) =>
      events.POST(
        request("http://localhost/api/executions/EX-1/events", {
          method: "POST",
          body: JSON.stringify({
            agentId: agentManifest.agentId,
            sessionId,
            event: sourceEvent
          })
        }),
        context("EX-1")
      );
    expect((await postEvent("session-foreign")).status).toBe(409);
    expect((await postEvent("session-owner")).status).toBe(201);
  });

  it("rejects incompatible capability claims, contenders, foreign sessions, and tenants", async () => {
    const store = new MemoryExecutionStore();
    store.execution = executionRecord();
    const claim = createAgentClaimHandler(resolve(store));
    const heartbeat = createAgentHeartbeatHandler(resolve(store));
    const manifest = {
      pluginVersion: "simulator-1.0.0",
      contractVersion: "1",
      capabilities: { feishuCli: true, browser: true },
      agentId: "agent-owner",
      sessionId: "session-owner",
      executionId: "EX-1"
    };
    const postClaim = (body: unknown, actor = owner) =>
      claim(
        requestAs(actor, "http://localhost/api/executions/EX-1/agent/claim", {
          method: "POST",
          body: JSON.stringify(body)
        }),
        context("EX-1")
      );

    expect(
      (await postClaim({ ...manifest, contractVersion: "0" })).status
    ).toBe(400);
    expect((await postClaim(manifest)).status).toBe(201);
    const contender = await postClaim({
      ...manifest,
      agentId: "agent-other",
      sessionId: "session-other"
    });
    expect(contender.status).toBe(409);
    await expect(contender.json()).resolves.toEqual({
      code: "EXECUTION_LOCKED"
    });

    const foreignHeartbeat = await heartbeat(
      request("http://localhost/api/executions/EX-1/agent/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          agentId: manifest.agentId,
          sessionId: "session-foreign"
        })
      }),
      context("EX-1")
    );
    expect(foreignHeartbeat.status).toBe(409);
    expect(
      (await postClaim(manifest, { userId: "U-2", workspaceId: "W-2" })).status
    ).toBe(404);
  });
});

function checkpointEvent(
  stepId: ExecutionEvent["stepId"],
  status: ExecutionStatus,
  phase: ExecutionPhase
): ExecutionEvent {
  return {
    ...firstEvent,
    stepId,
    status,
    evidence: {
      kind: "checkpoint",
      summary: { phase, status },
      reference: {
        kind: "checkpoint",
        id: "checkpoint:9999999999999999"
      }
    },
    nextAction: "stop"
  };
}

function executionRecord() {
  return {
    id: "EX-1",
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    configVersion: 1,
    status: "pending" as ExecutionStatus,
    phase: "source_parse" as ExecutionPhase,
    targetPolicy: "create_only" as const,
    createdAt: new Date("2026-07-30T00:00:00.000Z"),
    updatedAt: new Date("2026-07-30T00:00:00.000Z")
  };
}

function confirmationGateStore(): MemoryExecutionStore {
  const store = new MemoryExecutionStore();
  store.execution = {
    ...executionRecord(),
    status: "waiting_confirmation",
    phase: "publish_confirm"
  };
  store.lockAgentId = "agent-owner";
  store.agentHeartbeat = {
    agentId: "agent-owner",
    lastHeartbeatAt: new Date("2026-07-30T08:00:00.000Z")
  };
  return store;
}

function confirmedPublishEvent(attempt: number): ExecutionEvent {
  return {
    ...checkpointEvent("publish.confirm", "succeeded", "publish_confirm"),
    attempt
  };
}

function request(url: string, init?: RequestInit): Request {
  return requestAs(owner, url, init);
}

function requestAs(
  actor: { userId: string; workspaceId: string },
  url: string,
  init?: RequestInit
): Request {
  const headers = new Headers(init?.headers);
  headers.set("x-dev-user-id", actor.userId);
  headers.set("x-dev-workspace-id", actor.workspaceId);
  if (init?.body) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

function resolve(store: MemoryExecutionStore) {
  return (user: { userId: string; workspaceId: string }) =>
    new ExecutionService(store.scoped(user));
}

function context(executionId: string) {
  return { params: Promise.resolve({ executionId }) };
}

async function readFirstSseMessages(
  response: Response,
  count: number
): Promise<Array<{ id: string; data: ExecutionEvent }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const messages: Array<{ id: string; data: ExecutionEvent }> = [];

  while (messages.length < count) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    buffer += decoder.decode(result.value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      if (chunk.startsWith(":")) {
        continue;
      }
      const id = chunk.match(/^id: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (id && data) {
        messages.push({ id, data: JSON.parse(data) as ExecutionEvent });
      }
    }
  }

  await reader.cancel();
  return messages;
}

class MemoryExecutionStore implements ExecutionDataStore {
  execution: ReturnType<typeof executionRecord> | null = null;
  events: PersistedStepEvent[] = [];
  lockAgentId: string | null = null;
  lockSessionId: string | null = null;
  heartbeatCount = 0;
  confirmations: Array<{
    confirmation: ConfirmationRecord;
    tokenHash: string;
  }> = [];
  failEventListing = false;
  agentHeartbeat: {
    agentId: string;
    lastHeartbeatAt: Date | null;
  } | null = null;
  private activeScope = owner;

  scoped(scope: { userId: string; workspaceId: string }): MemoryExecutionStore {
    this.activeScope = scope;
    return this;
  }

  async createExecution(input: {
    userId: string;
    workspaceId: string;
    configVersion: number;
  }) {
    const now = new Date("2026-07-30T00:00:00.000Z");
    this.execution = {
      ...executionRecord(),
      id: "EX-1",
      userId: input.userId,
      workspaceId: input.workspaceId,
      configVersion: input.configVersion,
      createdAt: now,
      updatedAt: now
    };
    return this.execution;
  }

  async findExecution() {
    return this.execution &&
      this.execution.userId === this.activeScope.userId &&
      this.execution.workspaceId === this.activeScope.workspaceId
      ? this.execution
      : null;
  }

  async findExecutionAgentHeartbeat() {
    return this.agentHeartbeat;
  }

  async claimExecutionAgent(input: {
    manifest: AgentCapabilityManifest;
    ttlSeconds: number;
  }) {
    if (!(await this.findExecution())) {
      return "not_found" as const;
    }
    if (this.lockAgentId && this.lockAgentId !== input.manifest.agentId) {
      return "locked" as const;
    }
    if (
      this.lockAgentId === input.manifest.agentId &&
      this.lockSessionId &&
      this.lockSessionId !== input.manifest.sessionId
    ) {
      return "session_mismatch" as const;
    }
    this.lockAgentId = input.manifest.agentId;
    this.lockSessionId = input.manifest.sessionId;
    this.agentHeartbeat = {
      agentId: input.manifest.agentId,
      lastHeartbeatAt: new Date()
    };
    return "claimed" as const;
  }

  async heartbeatExecutionAgent(input: {
    executionId: string;
    agentId: string;
    sessionId: string;
    ttlSeconds: number;
  }) {
    if (
      this.execution?.id !== input.executionId ||
      this.lockAgentId !== input.agentId ||
      this.lockSessionId !== input.sessionId
    ) {
      return "lock_mismatch" as const;
    }
    this.heartbeatCount += 1;
    this.agentHeartbeat = {
      agentId: input.agentId,
      lastHeartbeatAt: new Date()
    };
    return "renewed" as const;
  }

  async acquireLock(_executionId: string, agentId: string) {
    if (this.lockAgentId && this.lockAgentId !== agentId) {
      return false;
    }
    this.lockAgentId = agentId;
    return true;
  }

  async appendEventForAgent(input: {
    agentId: string;
    sessionId?: string;
    event: ExecutionEvent;
    expectedState: { status: ExecutionStatus; phase: ExecutionPhase };
    nextState: { status: ExecutionStatus; phase: ExecutionPhase };
    confirmation?: {
      confirmationId: string;
      executionId: string;
      action: ConfirmationAction;
      configVersion: number;
      tokenHash: string;
    };
  }) {
    if (this.lockAgentId !== input.agentId) {
      return "lock_mismatch" as const;
    }
    if (this.lockSessionId !== null && this.lockSessionId !== input.sessionId) {
      return "lock_mismatch" as const;
    }
    if (
      !this.execution ||
      this.execution.status !== input.expectedState.status ||
      this.execution.phase !== input.expectedState.phase
    ) {
      return "state_mismatch" as const;
    }
    if (input.confirmation) {
      const persisted = this.confirmations.find(
        (record) =>
          record.confirmation.id === input.confirmation!.confirmationId &&
          record.confirmation.executionId ===
            input.confirmation!.executionId &&
          record.confirmation.userId === this.activeScope.userId &&
          record.confirmation.workspaceId === this.activeScope.workspaceId &&
          record.confirmation.action === input.confirmation!.action &&
          record.confirmation.configVersion ===
            input.confirmation!.configVersion &&
          record.tokenHash === input.confirmation!.tokenHash &&
          record.confirmation.consumedAt === null &&
          record.confirmation.expiresAt.getTime() > Date.now()
      );
      if (!persisted) {
        return "confirmation_invalid" as const;
      }
      persisted.confirmation = {
        ...persisted.confirmation,
        consumedAt: new Date()
      };
    }
    this.events.push({
      cursor: `cursor:${input.event.executionId}:${this.events.length + 1}`,
      event: input.event
    });
    this.execution = {
      ...this.execution,
      ...input.nextState,
      updatedAt: new Date()
    };
    return "appended" as const;
  }

  async listEventsAfter(executionId: string, cursor?: string) {
    if (this.failEventListing) {
      throw new Error("persisted event read failed");
    }
    const scopedEvents = this.events.filter(
      ({ event }) => event.executionId === executionId
    );
    if (cursor === undefined) {
      return scopedEvents;
    }
    const cursorIndex = scopedEvents.findIndex((event) => event.cursor === cursor);
    if (cursorIndex === -1) {
      throw Object.assign(new Error("invalid execution event cursor"), {
        code: "INVALID_CURSOR"
      });
    }
    return scopedEvents.slice(cursorIndex + 1);
  }

  async createConfirmationForGate(input: {
    id: string;
    executionId: string;
    action: ConfirmationAction;
    configVersion: number;
    tokenHash: string;
    expiresAt: Date;
    agentId: string;
    expectedState: {
      status: "waiting_confirmation";
      phase: ExecutionPhase;
    };
  }): Promise<
    | { status: "created"; confirmation: ConfirmationRecord }
    | { status: "state_mismatch" }
    | { status: "lock_mismatch" }
  > {
    if (
      !this.execution ||
      this.execution.userId !== this.activeScope.userId ||
      this.execution.workspaceId !== this.activeScope.workspaceId ||
      this.execution.status !== input.expectedState.status ||
      this.execution.phase !== input.expectedState.phase ||
      this.execution.configVersion !== input.configVersion
    ) {
      return { status: "state_mismatch" };
    }
    if (this.agentHeartbeat?.agentId !== input.agentId) {
      return { status: "lock_mismatch" };
    }

    const invalidatedAt = new Date();
    for (const record of this.confirmations) {
      if (
        record.confirmation.executionId === input.executionId &&
        record.confirmation.userId === this.activeScope.userId &&
        record.confirmation.workspaceId === this.activeScope.workspaceId &&
        record.confirmation.action === input.action &&
        record.confirmation.configVersion === input.configVersion &&
        record.confirmation.consumedAt === null &&
        record.confirmation.expiresAt.getTime() > invalidatedAt.getTime()
      ) {
        record.confirmation = {
          ...record.confirmation,
          consumedAt: invalidatedAt
        };
      }
    }
    const confirmation: ConfirmationRecord = {
      id: input.id,
      executionId: input.executionId,
      userId: this.activeScope.userId,
      workspaceId: this.activeScope.workspaceId,
      action: input.action,
      configVersion: input.configVersion,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: new Date()
    };
    this.confirmations.push({ confirmation, tokenHash: input.tokenHash });
    return { status: "created", confirmation };
  }

  async findConfirmation(input: {
    confirmationId: string;
    executionId: string;
    action: ConfirmationAction;
    configVersion: number;
    tokenHash: string;
  }): Promise<ConfirmationRecord | null> {
    const persisted = this.confirmations.find(
      (record) =>
        record.confirmation.id === input.confirmationId &&
        record.confirmation.executionId === input.executionId &&
        record.confirmation.userId === this.activeScope.userId &&
        record.confirmation.workspaceId === this.activeScope.workspaceId &&
        record.confirmation.action === input.action &&
        record.confirmation.configVersion === input.configVersion &&
        record.tokenHash === input.tokenHash &&
        record.confirmation.consumedAt === null &&
        record.confirmation.expiresAt.getTime() > Date.now()
    );
    return persisted?.confirmation ?? null;
  }
}
