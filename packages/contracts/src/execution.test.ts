import { describe, expect, it } from "vitest";
import { ExecutionEventSchema, ExecutionPacketSchema } from "./execution";

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
});
