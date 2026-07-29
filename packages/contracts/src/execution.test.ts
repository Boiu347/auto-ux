import { describe, expect, it } from "vitest";
import { ExecutionEventSchema, ExecutionPacketSchema } from "./execution";

describe("execution contracts", () => {
  it("rejects an execution packet that can modify existing robots", () => {
    const result = ExecutionPacketSchema.safeParse({
      executionId: "EX-1",
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1,
      currentStep: "robot.create",
      targetPolicy: "modify_existing",
      approvedActions: ["configure"],
      blockedActions: ["publish", "import_numbers", "start_dial"]
    });

    expect(result.success).toBe(false);
  });

  it("accepts an unknown outcome with evidence", () => {
    expect(
      ExecutionEventSchema.parse({
        executionId: "EX-1",
        stepId: "dial.verify",
        attempt: 1,
        status: "unknown",
        occurredAt: "2026-07-29T10:00:00.000Z",
        inputHash: "sha256:abc",
        evidence: { kind: "platform_record", summary: "record unavailable" },
        errorCode: "CALL_RECORD_UNAVAILABLE",
        nextAction: "wait_for_user"
      }).status
    ).toBe("unknown");
  });

  it("rejects empty audit fields", () => {
    const result = ExecutionEventSchema.safeParse({
      executionId: "EX-1",
      stepId: "dial.verify",
      attempt: 1,
      status: "failed",
      occurredAt: "2026-07-29T10:00:00.000Z",
      inputHash: "",
      evidence: { kind: "platform_record", summary: "" },
      nextAction: ""
    });

    expect(result.success).toBe(false);
  });
});
