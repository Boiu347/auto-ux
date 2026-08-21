import { describe, expect, it } from "vitest";
import {
  AgentCapabilityManifestSchema,
  ExecutionEventSchema,
  ExecutionModeSchema,
  ExecutionPacketSchema,
  LocalConfirmationProofSchema
} from "./execution";

describe("execution contracts", () => {
  const packet = {
    executionId: "EX-1",
    userId: "U-1",
    workspaceId: "W-1",
    configVersion: 1,
    currentStep: "robot.create",
    targetPolicy: "create_only",
    approvedActions: ["configure"],
    blockedActions: ["publish", "import_numbers", "start_dial"]
  };

  const event = {
    executionId: "EX-1",
    stepId: "dial.verify",
    attempt: 1,
    status: "unknown",
    occurredAt: "2026-07-29T10:00:00.000Z",
    inputHash: "sha256:abc",
    evidence: {
      kind: "platform_record",
      summary: { outcome: "unavailable" },
      reference: { kind: "platform_record", id: "record:0123456789abcdef" }
    },
    errorCode: "CALL_RECORD_UNAVAILABLE",
    nextAction: "wait_for_user"
  };

  it("accepts only simulator and real Codex execution modes", () => {
    expect(ExecutionModeSchema.parse("simulator")).toBe("simulator");
    expect(ExecutionModeSchema.parse("real_codex")).toBe("real_codex");
    expect(ExecutionModeSchema.safeParse("cloud_agent").success).toBe(false);
  });

  it("accepts a strict local Codex confirmation proof", () => {
    const proof = {
      source: "local_codex",
      action: "publish",
      confirmedAt: "2026-08-06T04:00:00.000Z",
      stateHash: `sha256:${"a".repeat(64)}`
    };

    expect(LocalConfirmationProofSchema.parse(proof)).toEqual(proof);
  });

  it("rejects malformed or expanded local confirmation proofs", () => {
    const proof = {
      source: "local_codex",
      action: "publish",
      confirmedAt: "2026-08-06T04:00:00.000Z",
      stateHash: `sha256:${"a".repeat(64)}`
    };

    expect(
      LocalConfirmationProofSchema.safeParse({ ...proof, action: "configure" })
        .success
    ).toBe(false);
    expect(
      LocalConfirmationProofSchema.safeParse({ ...proof, stateHash: "sha256:abc" })
        .success
    ).toBe(false);
    expect(
      LocalConfirmationProofSchema.safeParse({ ...proof, token: "secret" })
        .success
    ).toBe(false);
  });

  it("rejects an execution packet that can modify existing robots", () => {
    const result = ExecutionPacketSchema.safeParse({
      ...packet,
      targetPolicy: "modify_existing"
    });

    expect(result.success).toBe(false);
  });

  it("accepts an unknown outcome with evidence", () => {
    expect(ExecutionEventSchema.parse(event).status).toBe("unknown");
  });

  it.each(
    [
      "pending",
      "running",
      "waiting_confirmation",
      "succeeded",
      "failed",
      "rolled_back",
      "unknown"
    ].flatMap((status) =>
      [
        "pending",
        "running",
        "waiting_confirmation",
        "succeeded",
        "failed",
        "rolled_back",
        "unknown"
      ].map((evidenceStatus) => [status, evidenceStatus] as const)
    )
  )(
    "accepts event status %s with checkpoint status %s only when outcomes agree",
    (status, evidenceStatus) => {
      const result = ExecutionEventSchema.safeParse({
        ...event,
        status,
        evidence: {
          kind: "checkpoint",
          summary: { phase: "call_verify", status: evidenceStatus },
          reference: {
            kind: "checkpoint",
            id: "checkpoint:0123456789abcdef"
          }
        }
      });

      expect(result.success).toBe(status === evidenceStatus);
    }
  );

  it("enforces every platform-record outcome and event-status combination", () => {
    const expectedByOutcome = {
      unavailable: "unknown",
      recorded: "succeeded",
      ringing: "succeeded",
      connected: "succeeded",
      no_answer: "succeeded",
      busy: "succeeded",
      failed: "failed"
    } as const;
    const statuses = [
      "pending",
      "running",
      "waiting_confirmation",
      "succeeded",
      "failed",
      "rolled_back",
      "unknown"
    ] as const;

    for (const [outcome, expectedStatus] of Object.entries(expectedByOutcome)) {
      for (const status of statuses) {
        expect(
          ExecutionEventSchema.safeParse({
            ...event,
            status,
            evidence: {
              kind: "platform_record",
              summary: { outcome },
              reference: {
                kind: "platform_record",
                id: "record:0123456789abcdef"
              }
            }
          }).success
        ).toBe(status === expectedStatus);
      }
    }
  });

  it("enforces every field-readback result and event-status combination", () => {
    const expectedByResult = {
      matched: "succeeded",
      mismatched: "failed"
    } as const;
    const statuses = [
      "pending",
      "running",
      "waiting_confirmation",
      "succeeded",
      "failed",
      "rolled_back",
      "unknown"
    ] as const;

    for (const [result, expectedStatus] of Object.entries(expectedByResult)) {
      for (const status of statuses) {
        expect(
          ExecutionEventSchema.safeParse({
            ...event,
            status,
            evidence: {
              kind: "field_readback",
              summary: { field: "publish_state", result },
              reference: {
                kind: "field_readback",
                id: "readback:0123456789abcdef"
              }
            }
          }).success
        ).toBe(status === expectedStatus);
      }
    }
  });

  it("rejects empty audit fields", () => {
    const result = ExecutionEventSchema.safeParse({
      ...event,
      inputHash: "",
      evidence: {
        ...event.evidence,
        summary: { outcome: "unavailable" }
      },
      nextAction: ""
    });

    expect(result.success).toBe(false);
  });

  it("rejects unrecognized keys at packet and evidence boundaries", () => {
    expect(
      ExecutionPacketSchema.safeParse({ ...packet, unexpected: true }).success
    ).toBe(false);
    expect(
      ExecutionEventSchema.safeParse({
        ...event,
        evidence: { ...event.evidence, content: "原始飞书内容" }
      }).success
    ).toBe(false);
  });

  it("rejects raw phone numbers and Feishu text in evidence", () => {
    expect(
      ExecutionEventSchema.safeParse({
        ...event,
        evidence: { kind: "phone_batch", summary: "13800138000" }
      }).success
    ).toBe(false);
    expect(
      ExecutionEventSchema.safeParse({
        ...event,
        evidence: { kind: "platform_record", summary: "飞书会议纪要原文" }
      }).success
    ).toBe(false);
  });

  it("rejects high-risk actions in generic preauthorization", () => {
    expect(
      ExecutionPacketSchema.safeParse({
        ...packet,
        approvedActions: ["publish"],
        blockedActions: ["import_numbers", "start_dial"]
      }).success
    ).toBe(false);
  });

  it("rejects empty or duplicate blocked confirmation actions", () => {
    expect(
      ExecutionPacketSchema.safeParse({ ...packet, blockedActions: [] }).success
    ).toBe(false);
    expect(
      ExecutionPacketSchema.safeParse({
        ...packet,
        blockedActions: ["publish", "publish", "start_dial"]
      }).success
    ).toBe(false);
  });

  it("accepts a confirmation only when it is bound to this action and execution", () => {
    const result = ExecutionPacketSchema.safeParse({
      ...packet,
      blockedActions: ["import_numbers", "start_dial"],
      confirmation: {
        action: "publish",
        executionId: "EX-1",
        configVersion: 1,
        confirmationId: "confirm:0123456789abcdef"
      }
    });

    expect(result.success && result.data.confirmation?.action).toBe("publish");
  });

  it("accepts only the exact supported local-agent capability handshake", () => {
    const manifest = {
      pluginVersion: "simulator-1.0.0",
      contractVersion: "2",
      capabilities: {
        feishuCli: true,
        baiduApi: true,
        browserFallback: true
      },
      agentId: "agent-simulator",
      sessionId: "session-EX-1",
      executionId: "EX-1"
    };

    expect(AgentCapabilityManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      AgentCapabilityManifestSchema.safeParse({
        ...manifest,
        contractVersion: "0"
      }).success
    ).toBe(false);
    expect(
      AgentCapabilityManifestSchema.safeParse({
        ...manifest,
        capabilities: { ...manifest.capabilities, baiduApi: false }
      }).success
    ).toBe(false);
    expect(
      AgentCapabilityManifestSchema.safeParse({
        ...manifest,
        rawFeishuDocument: "forbidden"
      }).success
    ).toBe(false);
  });
});
