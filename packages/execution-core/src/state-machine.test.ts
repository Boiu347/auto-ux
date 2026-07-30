import { describe, expect, it } from "vitest";

import { transition } from "./state-machine.js";

describe("transition", () => {
  it("does not allow publish verification before publish confirmation", () => {
    expect(() =>
      transition("pending", { phase: "publish_verify", status: "running" })
    ).toThrowError("publish confirmation required");
  });

  it.each(["publish_confirm", "numbers_confirm", "dial_confirm"] as const)(
    "waits for the %s confirmation",
    (phase) => {
    const previousPhase =
      phase === "publish_confirm"
        ? "voice_preflight"
        : phase === "numbers_confirm"
          ? "publish_verify"
          : "numbers_confirm";

    expect(
      transition(
        { status: "succeeded", phase: previousPhase },
        { phase, status: "running" }
      )
    ).toBe(
      "waiting_confirmation"
    );
    }
  );

  it("allows publish verification after a confirmation wait", () => {
    expect(
      transition(
        { status: "waiting_confirmation", phase: "publish_confirm" },
        { phase: "publish_verify", status: "running" }
      )
    ).toBe("running");
  });

  it.each(["publish_verify", "numbers_confirm", "dial_confirm"] as const)(
    "returns to confirmation wait when %s is recovered",
    (phase) => {
      const previousPhase =
        phase === "publish_verify"
          ? "publish_confirm"
          : phase === "numbers_confirm"
            ? "publish_verify"
            : "numbers_confirm";

      expect(
        transition(
          { status: "running", phase: previousPhase },
          { phase, status: "running", recovered: true }
        )
      ).toBe("waiting_confirmation");
    }
  );

  it("never promotes an unknown result to success", () => {
    expect(
      transition(
        { status: "unknown", phase: "call_verify" },
        { phase: "complete", status: "succeeded" }
      )
    ).toBe("unknown");
  });

  it("allows the documented next phase", () => {
    expect(
      transition(
        { status: "succeeded", phase: "source_parse" },
        { phase: "draft_confirm", status: "running" }
      )
    ).toBe("running");
  });

  it("rejects a skipped documented phase", () => {
    expect(() =>
      transition(
        { status: "succeeded", phase: "source_parse" },
        { phase: "environment_preflight", status: "running" }
      )
    ).toThrowError("phase environment_preflight must follow source_parse");
  });

  it("rejects a regressed documented phase", () => {
    expect(() =>
      transition(
        { status: "succeeded", phase: "draft_confirm" },
        { phase: "source_parse", status: "running" }
      )
    ).toThrowError("phase source_parse must follow draft_confirm");
  });

  it("does not permit an in-progress execution without phase context", () => {
    expect(() =>
      transition("running", { phase: "robot_create", status: "running" })
    ).toThrowError("current phase is required after execution start");
  });

  it("permits the initial source parse through the compatibility signature", () => {
    expect(
      transition("pending", { phase: "source_parse", status: "running" })
    ).toBe("running");
  });

  it("does not let the compatibility signature skip initial phases", () => {
    expect(() =>
      transition("pending", { phase: "draft_confirm", status: "running" })
    ).toThrowError("phase draft_confirm must follow source_parse");
  });
});
