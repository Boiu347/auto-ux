import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  AgentCapabilityManifestSchema,
  type ExecutionEvent
} from "@app/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  AgentClientError,
  FakeConfirmationBridge,
  FakeLocalApiClient,
  FakeLocalApiPersistence,
  type AgentCapabilityManifest
} from "./client.ts";
import { runSimulation } from "./run-simulation.ts";

const manifest: AgentCapabilityManifest = {
  pluginVersion: "simulator-1.0.0",
  contractVersion: "1",
  capabilities: { feishuCli: true, browser: true },
  agentId: "agent-simulator",
  sessionId: "session-EX-1",
  executionId: "EX-1"
};

describe("local agent simulator", () => {
  it("runs the documented CLI deterministically without external services", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("./run-simulation.ts", import.meta.url)),
        "--execution",
        "EX-1"
      ],
      { encoding: "utf8" }
    );

    expect(JSON.parse(output)).toMatchObject({
      executionId: "EX-1",
      simulator: true,
      outputLabel: "SIMULATOR_ONLY",
      pluginSessionCount: 1,
      finalStatus: "waiting_confirmation",
      waitingFor: "publish"
    });
  });

  it("uses one plugin session and stops at publish confirmation", async () => {
    const fakeApi = new FakeLocalApiClient();

    const result = await runSimulation({ executionId: "EX-1", api: fakeApi });

    expect(result).toMatchObject({
      simulator: true,
      pluginSessionCount: 1,
      finalStatus: "waiting_confirmation",
      waitingFor: "publish"
    });
    expect(fakeApi.events.at(-1)?.stepId).toBe("publish.confirm");
    expect(fakeApi.events.at(-1)?.status).toBe("waiting_confirmation");
  });

  it.each([
    ["an incompatible contract", { contractVersion: "0" }, "INCOMPATIBLE_CONTRACT"],
    [
      "a missing Feishu CLI capability",
      { capabilities: { feishuCli: false, browser: true } },
      "MISSING_CAPABILITY"
    ],
    [
      "a missing browser capability",
      { capabilities: { feishuCli: true, browser: false } },
      "MISSING_CAPABILITY"
    ]
  ])("rejects %s without silently downgrading", async (_name, override, code) => {
    const fakeApi = new FakeLocalApiClient();

    await expect(
      runSimulation({
        executionId: "EX-1",
        api: fakeApi,
        manifest: { ...manifest, ...override }
      })
    ).rejects.toMatchObject({ code });
    expect(fakeApi.events).toHaveLength(0);
    expect(fakeApi.pluginSessionCount).toBe(0);
  });

  it.each([
    ["invalid agent id", { ...manifest, agentId: "agent invalid" }],
    ["invalid session id", { ...manifest, sessionId: "session:invalid" }],
    ["unknown top-level field", { ...manifest, rawFeishuDocument: "forbidden" }],
    [
      "unknown capability field",
      {
        ...manifest,
        capabilities: {
          ...manifest.capabilities,
          navigateRealWebsite: true
        }
      }
    ]
  ])("rejects %s with the same strict manifest schema as the real API", async (_name, candidate) => {
    expect(AgentCapabilityManifestSchema.safeParse(candidate).success).toBe(false);
    const fakeApi = new FakeLocalApiClient();

    await expect(
      fakeApi.claimExecution(
        "EX-1",
        candidate as unknown as AgentCapabilityManifest
      )
    ).rejects.toMatchObject({ code: "EXECUTION_BINDING_MISMATCH" });
    expect(fakeApi.pluginSessionCount).toBe(0);
  });

  it("allows one atomic lock winner and rejects a contender", async () => {
    const persistence = new FakeLocalApiPersistence();
    const first = new FakeLocalApiClient({ persistence });
    const contender = new FakeLocalApiClient({ persistence });

    const results = await Promise.allSettled([
      first.claimExecution("EX-1", manifest),
      contender.claimExecution("EX-1", {
        ...manifest,
        agentId: "agent-contender",
        sessionId: "session-contender"
      })
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "EXECUTION_LOCKED" }
    });
    expect(persistence.pluginSessionCount).toBe(1);
  });

  it("heartbeats the exact agent, session, and execution binding", async () => {
    let now = new Date("2026-07-30T00:00:00.000Z");
    const persistence = new FakeLocalApiPersistence();
    const fakeApi = new FakeLocalApiClient({ persistence, now: () => now });

    await runSimulation({ executionId: "EX-1", api: fakeApi });
    now = new Date("2026-07-30T00:00:30.000Z");
    await fakeApi.heartbeatExecution("EX-1", manifest);

    expect(persistence.heartbeatCount).toBeGreaterThanOrEqual(2);
    expect(persistence.lock).toMatchObject({
      agentId: "agent-simulator",
      sessionId: "session-EX-1",
      executionId: "EX-1",
      heartbeatAt: "2026-07-30T00:00:30.000Z"
    });
  });

  it("passes all three distinct action-bound confirmations before a simulated call record", async () => {
    const fakeApi = new FakeLocalApiClient();
    const bridge = new FakeConfirmationBridge(fakeApi);

    const result = await runSimulation({
      executionId: "EX-1",
      api: fakeApi,
      mode: "full",
      confirmationBridge: bridge
    });

    expect(result).toMatchObject({ simulator: true, finalStatus: "succeeded" });
    expect(bridge.requestedActions).toEqual([
      "publish",
      "import_numbers",
      "start_dial"
    ]);
    expect(fakeApi.consumedConfirmationActions).toEqual([
      "publish",
      "import_numbers",
      "start_dial"
    ]);
    expect(fakeApi.events.at(-2)).toMatchObject({
      stepId: "dial.verify",
      status: "succeeded",
      evidence: {
        kind: "platform_record",
        summary: { outcome: "recorded" }
      }
    });
    expect(fakeApi.events.at(-1)).toMatchObject({
      stepId: "complete",
      status: "succeeded"
    });
  });

  it("renews the lease while a confirmation wait exceeds sixty seconds and stops heartbeats afterward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00.000Z"));
    const persistence = new FakeLocalApiPersistence();
    const fakeApi = new FakeLocalApiClient({
      persistence,
      now: () => new Date(Date.now())
    });
    const requestedActions: string[] = [];
    let heartbeatCountBeforeWait = 0;
    const confirmationBridge = {
      async waitForConfirmation(request: { action: "publish" | "import_numbers" | "start_dial" }) {
        requestedActions.push(request.action);
        if (request.action === "publish") {
          heartbeatCountBeforeWait = persistence.heartbeatCount;
          await new Promise((resolve) => setTimeout(resolve, 65_000));
        }
        return fakeApi.issueConfirmation(request.action, manifest);
      }
    };

    try {
      const simulation = runSimulation({
        executionId: "EX-1",
        api: fakeApi,
        mode: "full",
        confirmationBridge
      });
      const completed = expect(simulation).resolves.toMatchObject({
        finalStatus: "succeeded"
      });
      await vi.advanceTimersByTimeAsync(65_000);

      await completed;
      expect(requestedActions).toEqual([
        "publish",
        "import_numbers",
        "start_dial"
      ]);
      expect(persistence.heartbeatCount).toBeGreaterThanOrEqual(
        heartbeatCountBeforeWait + 2
      );
      const heartbeatCount = persistence.heartbeatCount;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(persistence.heartbeatCount).toBe(heartbeatCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["failure", new Error("confirmation bridge failed")],
    ["abort", Object.assign(new Error("confirmation aborted"), { name: "AbortError" })]
  ])("cleans up lease heartbeats after confirmation %s", async (_name, failure) => {
    vi.useFakeTimers();
    const fakeApi = new FakeLocalApiClient();
    const confirmationBridge = {
      async waitForConfirmation() {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        throw failure;
      }
    };

    try {
      const simulation = runSimulation({
        executionId: "EX-1",
        api: fakeApi,
        mode: "full",
        confirmationBridge
      });
      const rejected = expect(simulation).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave a lease timer when returning at the publish gate", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        runSimulation({ executionId: "EX-1", api: new FakeLocalApiClient() })
      ).resolves.toMatchObject({ waitingFor: "publish" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a foreign confirmation without consuming it", async () => {
    const fakeApi = new FakeLocalApiClient();
    await runSimulation({ executionId: "EX-1", api: fakeApi });
    const delivery = await fakeApi.issueConfirmation("publish", manifest);

    await expect(
      fakeApi.postStepEvent(
        checkpointEvent("publish.confirm", "publish_confirm", "succeeded", 8),
        manifest,
        { ...delivery, executionId: "EX-FOREIGN" }
      )
    ).rejects.toMatchObject({ code: "FOREIGN_CONFIRMATION" });
    expect(fakeApi.consumedConfirmationActions).toEqual([]);
  });

  it("rejects confirmation replay and duplicate events", async () => {
    const fakeApi = new FakeLocalApiClient();
    await runSimulation({ executionId: "EX-1", api: fakeApi });
    const delivery = await fakeApi.issueConfirmation("publish", manifest);
    const resumed = checkpointEvent(
      "publish.confirm",
      "publish_confirm",
      "succeeded",
      8
    );
    await fakeApi.postStepEvent(resumed, manifest, delivery);

    await expect(
      fakeApi.postStepEvent({ ...resumed, attempt: 9 }, manifest, delivery)
    ).rejects.toMatchObject({ code: "CONFIRMATION_REPLAYED" });
    await expect(fakeApi.postStepEvent(resumed, manifest)).rejects.toMatchObject({
      code: "DUPLICATE_EVENT"
    });
  });

  it("recovers persisted progress after restart without a second plugin session or duplicate event", async () => {
    const persistence = new FakeLocalApiPersistence();
    const firstProcess = new FakeLocalApiClient({ persistence });
    await runSimulation({ executionId: "EX-1", api: firstProcess });
    const persistedEventCount = firstProcess.events.length;

    const restartedProcess = new FakeLocalApiClient({ persistence });
    const result = await runSimulation({
      executionId: "EX-1",
      api: restartedProcess
    });

    expect(result).toMatchObject({
      pluginSessionCount: 1,
      finalStatus: "waiting_confirmation",
      waitingFor: "publish"
    });
    expect(restartedProcess.events).toHaveLength(persistedEventCount);
    expect(persistence.recoveredClaimCount).toBe(1);

    await expect(
      restartedProcess.claimExecution("EX-1", {
        ...manifest,
        sessionId: "session-duplicate"
      })
    ).rejects.toMatchObject({ code: "DUPLICATE_PLUGIN_SESSION" });
  });

  it("preserves unknown persisted state and does not guess forward", async () => {
    const persistence = new FakeLocalApiPersistence();
    const firstProcess = new FakeLocalApiClient({ persistence });
    await firstProcess.claimExecution("EX-1", manifest);
    await firstProcess.heartbeatExecution("EX-1", manifest);
    await firstProcess.postStepEvent(
      checkpointEvent("source.parse", "source_parse", "unknown", 1),
      manifest
    );

    const restartedProcess = new FakeLocalApiClient({ persistence });
    const result = await runSimulation({
      executionId: "EX-1",
      api: restartedProcess,
      mode: "full",
      confirmationBridge: new FakeConfirmationBridge(restartedProcess)
    });

    expect(result.finalStatus).toBe("unknown");
    expect(restartedProcess.events).toHaveLength(1);
  });

  it("never calls fetch or emits raw Feishu documents or full phone numbers", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("external adapters are forbidden in simulator mode");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const fakeApi = new FakeLocalApiClient();

    try {
      await runSimulation({
        executionId: "EX-1",
        api: fakeApi,
        mode: "full",
        confirmationBridge: new FakeConfirmationBridge(fakeApi)
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    const persisted = JSON.stringify(fakeApi.events);
    expect(persisted).not.toContain("feishuDocument");
    expect(persisted).not.toMatch(/\b1\d{10}\b/);
    expect(JSON.stringify({ simulator: true, outputLabel: "SIMULATOR_ONLY" })).toContain(
      "SIMULATOR"
    );
  });

  it("surfaces rejected attempts with stable error codes", () => {
    expect(new AgentClientError("DUPLICATE_EVENT")).toMatchObject({
      code: "DUPLICATE_EVENT"
    });
  });
});

function checkpointEvent(
  stepId: ExecutionEvent["stepId"],
  phase: Extract<ExecutionEvent["evidence"], { kind: "checkpoint" }>["summary"]["phase"],
  status: ExecutionEvent["status"],
  attempt: number
): ExecutionEvent {
  return {
    executionId: "EX-1",
    stepId,
    attempt,
    status,
    occurredAt: `2026-07-30T00:00:${attempt.toString().padStart(2, "0")}.000Z`,
    inputHash: `sha256:${attempt.toString(16).padStart(16, "0")}`,
    evidence: {
      kind: "checkpoint",
      summary: { phase, status },
      reference: {
        kind: "checkpoint",
        id: `checkpoint:${attempt.toString(16).padStart(16, "0")}`
      }
    },
    nextAction: status === "unknown" ? "wait_for_user" : "stop"
  };
}
