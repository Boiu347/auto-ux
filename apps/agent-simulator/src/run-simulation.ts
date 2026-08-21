import type {
  ConfirmationAction,
  ExecutionEvent,
  ExecutionPhase,
  ExecutionStatus
} from "@app/contracts";
import { fileURLToPath } from "node:url";

import {
  FakeLocalApiClient,
  HttpLocalApiClient,
  createLocalApiHeaders,
  SUPPORTED_CONTRACT_VERSION,
  type AgentCapabilityManifest,
  type ConfirmationBridge,
  type ConfirmationDelivery,
  type ConfirmationRequest,
  type LocalApiClient,
  type SimulationResult
} from "./client.ts";

export interface RunSimulationOptions {
  executionId: string;
  api: LocalApiClient;
  manifest?: AgentCapabilityManifest;
  mode?: "until_publish_confirmation" | "full";
  confirmationBridge?: ConfirmationBridge;
}

interface FlowEvent {
  event: ExecutionEvent;
  confirmationAction?: ConfirmationAction;
}

const CONFIRMATION_HEARTBEAT_INTERVAL_MS = 30_000;

export async function runSimulation(
  options: RunSimulationOptions
): Promise<SimulationResult> {
  const manifest =
    options.manifest ?? defaultManifest(options.executionId);
  const claimed = await options.api.claimExecution(options.executionId, manifest);
  await options.api.heartbeatExecution(options.executionId, manifest);
  const persisted = [...claimed.events];
  const last = persisted.at(-1);

  if (last?.status === "unknown") {
    return result(claimed.pluginSessionCount, "unknown");
  }
  if (last?.stepId === "complete" && last.status === "succeeded") {
    return result(claimed.pluginSessionCount, "succeeded");
  }

  const flow = simulationFlow(options.executionId);
  for (let index = persisted.length; index < flow.length; index += 1) {
    const next = flow[index]!;
    if (
      options.mode !== "full" &&
      next.event.stepId === "publish.confirm" &&
      next.event.status === "succeeded"
    ) {
      return result(claimed.pluginSessionCount, "waiting_confirmation", "publish");
    }

    let confirmation;
    if (next.confirmationAction) {
      if (!options.confirmationBridge) {
        return result(
          claimed.pluginSessionCount,
          "waiting_confirmation",
          next.confirmationAction
        );
      }
      confirmation = await waitForConfirmationWithLease({
        api: options.api,
        bridge: options.confirmationBridge,
        manifest,
        request: {
          action: next.confirmationAction,
          executionId: options.executionId,
          configVersion: claimed.configVersion,
          agentId: manifest.agentId,
          sessionId: manifest.sessionId
        }
      });
    }

    await options.api.heartbeatExecution(options.executionId, manifest);
    await options.api.postStepEvent(next.event, manifest, confirmation);
  }

  return result(claimed.pluginSessionCount, "succeeded");
}

async function waitForConfirmationWithLease(input: {
  api: LocalApiClient;
  bridge: ConfirmationBridge;
  manifest: AgentCapabilityManifest;
  request: ConfirmationRequest;
}): Promise<ConfirmationDelivery> {
  let heartbeatInFlight: Promise<void> | undefined;
  let rejectHeartbeatFailure: (error: unknown) => void = () => undefined;
  const heartbeatFailure = new Promise<never>((_resolve, reject) => {
    rejectHeartbeatFailure = reject;
  });
  const timer = setInterval(() => {
    if (heartbeatInFlight) {
      return;
    }
    heartbeatInFlight = input.api
      .heartbeatExecution(input.request.executionId, input.manifest)
      .catch((error: unknown) => {
        rejectHeartbeatFailure(error);
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, CONFIRMATION_HEARTBEAT_INTERVAL_MS);

  try {
    return await Promise.race([
      input.bridge.waitForConfirmation(input.request),
      heartbeatFailure
    ]);
  } finally {
    clearInterval(timer);
    await heartbeatInFlight;
  }
}

function simulationFlow(executionId: string): FlowEvent[] {
  return [
    checkpoint(executionId, "source.parse", "source_parse", "succeeded", 1),
    checkpoint(executionId, "draft.confirm", "draft_confirm", "succeeded", 2),
    checkpoint(
      executionId,
      "environment.preflight",
      "environment_preflight",
      "succeeded",
      3
    ),
    checkpoint(executionId, "robot.create", "robot_create", "succeeded", 4),
    checkpoint(executionId, "field.configure", "field_configure", "succeeded", 5),
    checkpoint(executionId, "voice.preflight", "voice_preflight", "succeeded", 6),
    checkpoint(
      executionId,
      "publish.confirm",
      "publish_confirm",
      "waiting_confirmation",
      7
    ),
    {
      ...checkpoint(
        executionId,
        "publish.confirm",
        "publish_confirm",
        "succeeded",
        8
      ),
      confirmationAction: "publish"
    },
    fieldReadback(executionId, "publish.verify", "publish_state", 9),
    phoneBatch(executionId, 10),
    {
      ...checkpoint(
        executionId,
        "numbers.confirm",
        "numbers_confirm",
        "succeeded",
        11
      ),
      confirmationAction: "import_numbers"
    },
    checkpoint(
      executionId,
      "dial.confirm",
      "dial_confirm",
      "waiting_confirmation",
      12
    ),
    {
      ...checkpoint(
        executionId,
        "dial.confirm",
        "dial_confirm",
        "succeeded",
        13
      ),
      confirmationAction: "start_dial"
    },
    callRecord(executionId, 14),
    checkpoint(executionId, "complete", "complete", "succeeded", 15)
  ];
}

function checkpoint(
  executionId: string,
  stepId: ExecutionEvent["stepId"],
  phase: ExecutionPhase,
  status: ExecutionStatus,
  attempt: number
): FlowEvent {
  const reference = referenceFor(attempt);
  return {
    event: {
      executionId,
      stepId,
      attempt,
      status,
      occurredAt: occurredAt(attempt),
      inputHash: `sha256:${reference}`,
      evidence: {
        kind: "checkpoint",
        summary: { phase, status },
        reference: { kind: "checkpoint", id: `checkpoint:${reference}` }
      },
      nextAction: status === "waiting_confirmation" ? "wait_for_user" : "stop"
    }
  };
}

function fieldReadback(
  executionId: string,
  stepId: ExecutionEvent["stepId"],
  field: "publish_state",
  attempt: number
): FlowEvent {
  const reference = referenceFor(attempt);
  return {
    event: {
      executionId,
      stepId,
      attempt,
      status: "succeeded",
      occurredAt: occurredAt(attempt),
      inputHash: `sha256:${reference}`,
      evidence: {
        kind: "field_readback",
        summary: { field, result: "matched" },
        reference: { kind: "field_readback", id: `field:${reference}` }
      },
      nextAction: "stop"
    }
  };
}

function phoneBatch(executionId: string, attempt: number): FlowEvent {
  const reference = referenceFor(attempt);
  return {
    event: {
      executionId,
      stepId: "numbers.confirm",
      attempt,
      status: "waiting_confirmation",
      occurredAt: occurredAt(attempt),
      inputHash: `sha256:${reference}`,
      evidence: {
        kind: "phone_batch",
        summary: {
          total: 2,
          valid: 2,
          invalid: 0,
          duplicates: 0,
          maskedSamples: ["138****0001", "139****0002"]
        },
        reference: { kind: "phone_batch", id: `phone:${reference}` }
      },
      nextAction: "wait_for_user"
    }
  };
}

function callRecord(executionId: string, attempt: number): FlowEvent {
  const reference = referenceFor(attempt);
  return {
    event: {
      executionId,
      stepId: "dial.verify",
      attempt,
      status: "succeeded",
      occurredAt: occurredAt(attempt),
      inputHash: `sha256:${reference}`,
      evidence: {
        kind: "platform_record",
        summary: { outcome: "recorded" },
        reference: { kind: "platform_record", id: `record:${reference}` }
      },
      nextAction: "stop"
    }
  };
}

function defaultManifest(executionId: string): AgentCapabilityManifest {
  return {
    pluginVersion: "simulator-1.0.0",
    contractVersion: SUPPORTED_CONTRACT_VERSION,
    capabilities: { feishuCli: true, baiduApi: true, browserFallback: true },
    agentId: "agent-simulator",
    sessionId: `session-${executionId}`,
    executionId
  };
}

function result(
  pluginSessionCount: number,
  finalStatus: ExecutionStatus,
  waitingFor?: ConfirmationAction
): SimulationResult {
  return {
    simulator: true,
    outputLabel: "SIMULATOR_ONLY",
    pluginSessionCount,
    finalStatus,
    ...(waitingFor ? { waitingFor } : {})
  };
}

function occurredAt(attempt: number): string {
  return new Date(Date.UTC(2026, 6, 30, 0, 0, attempt)).toISOString();
}

function referenceFor(attempt: number): string {
  return attempt.toString(16).padStart(16, "0");
}

async function main(): Promise<void> {
  const executionId = argument("--execution");
  if (!executionId) {
    throw new Error("usage: pnpm agent:simulate --execution EX-1");
  }
  const baseUrl = argument("--api");
  const api = baseUrl
    ? new HttpLocalApiClient(baseUrl, createLocalApiHeaders())
    : new FakeLocalApiClient({ executionId });
  const simulation = await runSimulation({ executionId, api });
  process.stdout.write(`${JSON.stringify({ executionId, ...simulation })}\n`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
