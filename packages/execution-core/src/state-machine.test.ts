import { describe, expect, it, vi } from "vitest";

import type { ExecutionPhase, ExecutionStatus } from "@app/contracts";

import {
  consumeConfirmation,
  issueConfirmation,
  transition,
  type ConfirmationGrant
} from "./index.js";

const futureDate = new Date("2099-01-01T00:00:00.000Z");

const phases: readonly ExecutionPhase[] = [
  "source_parse",
  "draft_confirm",
  "environment_preflight",
  "robot_create",
  "field_configure",
  "voice_preflight",
  "publish_confirm",
  "publish_verify",
  "numbers_confirm",
  "dial_confirm",
  "call_verify",
  "complete"
];

function state(phase: ExecutionPhase, status: ExecutionStatus = "succeeded") {
  return { status, phase, executionId: "EX-1", configVersion: 4 };
}

function consumeGrant(
  action: "publish" | "import_numbers" | "start_dial",
  executionId = "EX-1",
  configVersion = 4,
  expiresAt = futureDate
): ConfirmationGrant {
  const result = consumeConfirmation(
    issueConfirmation(action, executionId, configVersion, expiresAt),
    action,
    executionId,
    configVersion
  );

  if (!result.ok) {
    throw new Error(`expected a grant, received ${result.reason}`);
  }

  return result.grant;
}

describe("transition", () => {
  it("does not allow publish verification before publish confirmation", () => {
    expect(() =>
      transition("pending", { phase: "publish_verify", status: "running" })
    ).toThrowError("publish confirmation required");
  });

  it("allows the initial source parse through the compatibility signature", () => {
    expect(
      transition("pending", { phase: "source_parse", status: "running" })
    ).toBe("running");
  });

  it("rejects skipped and regressed documented phases", () => {
    expect(() =>
      transition(state("source_parse"), {
        phase: "environment_preflight",
        status: "running"
      })
    ).toThrowError("phase environment_preflight must follow source_parse");
    expect(() =>
      transition(state("draft_confirm"), { phase: "source_parse", status: "running" })
    ).toThrowError("phase source_parse must follow draft_confirm");
  });

  it.each(phases.slice(0, -1).flatMap((phase, index) =>
    (["running", "failed", "waiting_confirmation"] as const).map((status) => [
      phase,
      phases[index + 1],
      status
    ] as const)
  ))(
    "does not advance %s to %s from %s",
    (phase, nextPhase, status) => {
      expect(() =>
        transition(state(phase, status), { phase: nextPhase, status: "running" })
      ).toThrow();
    }
  );

  it.each(phases.slice(0, -1).flatMap((phase, index) =>
    (["running", "failed", "waiting_confirmation"] as const).map((status) => [
      phase,
      phases[index + 1],
      status
    ] as const)
  ))(
    "does not let recovery advance %s to %s from %s",
    (phase, nextPhase, status) => {
      expect(() =>
        transition(state(phase, status), {
          phase: nextPhase,
          status: "running",
          recovered: true
        })
      ).toThrow();
    }
  );

  it("waits at each high-risk confirmation phase", () => {
    expect(
      transition(state("voice_preflight"), {
        phase: "publish_confirm",
        status: "running"
      })
    ).toBe("waiting_confirmation");
    expect(
      transition(state("publish_verify"), {
        phase: "numbers_confirm",
        status: "running"
      })
    ).toBe("waiting_confirmation");
    expect(
      transition(state("numbers_confirm", "waiting_confirmation"), {
        phase: "numbers_confirm",
        status: "succeeded",
        confirmation: consumeGrant("import_numbers")
      })
    ).toBe("succeeded");
    expect(
      transition(state("numbers_confirm", "succeeded"), {
        phase: "dial_confirm",
        status: "running"
      })
    ).toBe("waiting_confirmation");
  });

  it.each([
    ["publish_confirm", "publish_verify", "publish"],
    ["numbers_confirm", "dial_confirm", "import_numbers"],
    ["dial_confirm", "call_verify", "start_dial"]
  ] as const)(
    "rejects unconfirmed %s → %s outcomes including unknown",
    (phase, nextPhase, action) => {
      for (const status of ["running", "failed", "unknown"] as const) {
        expect(() =>
          transition(state(phase, "waiting_confirmation"), {
            phase: nextPhase,
            status
          })
        ).toThrow(`${action} confirmation grant required`);
      }
    }
  );

  it.each([
    ["publish_confirm", "publish_verify", "publish", "running"],
    ["numbers_confirm", "dial_confirm", "import_numbers", "waiting_confirmation"],
    ["dial_confirm", "call_verify", "start_dial", "running"]
  ] as const)(
    "requires %s to succeed in-phase before advancing to %s",
    (phase, nextPhase, action, expected) => {
      expect(
        transition(state(phase, "waiting_confirmation"), {
          phase,
          status: "succeeded",
          confirmation: consumeGrant(action)
        })
      ).toBe("succeeded");
      expect(
        transition(state(phase, "succeeded"), {
          phase: nextPhase,
          status: "running"
        })
      ).toBe(expected);
    }
  );

  it.each([
    ["voice_preflight", "publish_confirm"],
    ["publish_verify", "numbers_confirm"],
    ["numbers_confirm", "dial_confirm"]
  ] as const)(
    "does not expose the %s gate for a failed or unknown operation from %s",
    (phase, nextPhase) => {
      for (const status of ["failed", "unknown"] as const) {
        expect(() =>
          transition(state(phase, "succeeded"), {
            phase: nextPhase,
            status
          })
        ).toThrow();
      }
    }
  );

  it("rejects an object fabricated as a confirmation grant", () => {
    expect(() =>
      transition(state("publish_confirm", "waiting_confirmation"), {
        phase: "publish_confirm",
        status: "succeeded",
        confirmation: {} as ConfirmationGrant
      })
    ).toThrowError("publish confirmation grant required");
  });

  it("rejects a grant issued for another action, execution, or config version", () => {
    for (const grant of [
      consumeGrant("import_numbers"),
      consumeGrant("publish", "EX-2"),
      consumeGrant("publish", "EX-1", 5)
    ]) {
      expect(() =>
        transition(state("publish_confirm", "waiting_confirmation"), {
          phase: "publish_confirm",
          status: "succeeded",
          confirmation: grant
        })
      ).toThrowError("publish confirmation grant required");
    }
  });

  it("does not allow expired or replayed grants to advance", () => {
    const expired = consumeConfirmation(
      issueConfirmation("publish", "EX-1", 4, new Date("2000-01-01T00:00:00.000Z")),
      "publish",
      "EX-1",
      4
    );
    expect(expired).toEqual({ ok: false, reason: "expired" });
    expect(() =>
      transition(state("publish_confirm", "waiting_confirmation"), {
        phase: "publish_confirm",
        status: "succeeded"
      })
    ).toThrowError("publish confirmation grant required");

    const grant = consumeGrant("publish");
    expect(
      transition(state("publish_confirm", "waiting_confirmation"), {
        phase: "publish_confirm",
        status: "succeeded",
        confirmation: grant
      })
    ).toBe("succeeded");
    expect(() =>
      transition(state("publish_confirm", "waiting_confirmation"), {
        phase: "publish_confirm",
        status: "succeeded",
        confirmation: grant
      })
    ).toThrowError("publish confirmation grant required");
  });

  it("rejects a grant that expires between consumption and transition", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const grant = consumeGrant(
        "publish",
        "EX-1",
        4,
        new Date(2_000)
      );
      now.mockReturnValue(2_001);

      expect(() =>
        transition(state("publish_confirm", "waiting_confirmation"), {
          phase: "publish_confirm",
          status: "succeeded",
          confirmation: grant
        })
      ).toThrowError("publish confirmation grant required");
      expect(() =>
        transition(state("publish_confirm", "waiting_confirmation"), {
          phase: "publish_confirm",
          status: "succeeded",
          confirmation: grant
        })
      ).toThrowError("publish confirmation grant required");
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ["publish", "publish_confirm", "publish_verify"],
    ["import_numbers", "numbers_confirm", "dial_confirm"],
    ["start_dial", "dial_confirm", "call_verify"]
  ] as const)(
    "invalidates a prior %s grant when %s is recovered",
    (action, phase, nextPhase) => {
      const grant = consumeGrant(action);

      expect(
        transition(state(phase, "waiting_confirmation"), {
          phase,
          status: "running",
          recovered: true,
          confirmation: grant
        })
      ).toBe("waiting_confirmation");
      expect(() =>
        transition(state(phase, "waiting_confirmation"), {
          phase: nextPhase,
          status: "running",
          confirmation: grant
        })
      ).toThrowError(`${action} confirmation grant required`);
    }
  );

  it("rejects tokenless publish and import recovery across phases", () => {
    expect(() =>
      transition(state("publish_confirm", "waiting_confirmation"), {
        phase: "publish_verify",
        status: "running",
        recovered: true
      })
    ).toThrow();
    expect(() =>
      transition(state("numbers_confirm", "waiting_confirmation"), {
        phase: "dial_confirm",
        status: "running",
        recovered: true
      })
    ).toThrow();
  });

  it("requires a fresh publish grant after publish recovery", () => {
    expect(
      transition(state("publish_confirm", "waiting_confirmation"), {
        phase: "publish_confirm",
        status: "running",
        recovered: true
      })
    ).toBe("waiting_confirmation");
    expect(() =>
      transition(state("publish_confirm", "waiting_confirmation"), {
        phase: "publish_verify",
        status: "running"
      })
    ).toThrowError("publish confirmation grant required");
  });

  it("requires a new publish grant to resume recovered publish verification", () => {
    const oldGrant = consumeGrant("publish");
    expect(
      transition(state("publish_verify", "running"), {
        phase: "publish_verify",
        status: "running",
        recovered: true,
        confirmation: oldGrant
      })
    ).toBe("waiting_confirmation");
    expect(() =>
      transition(state("publish_verify", "waiting_confirmation"), {
        phase: "publish_verify",
        status: "running"
      })
    ).toThrowError("publish confirmation grant required");
    expect(() =>
      transition(state("publish_verify", "waiting_confirmation"), {
        phase: "publish_verify",
        status: "running",
        confirmation: oldGrant
      })
    ).toThrowError("publish confirmation grant required");
    expect(
      transition(state("publish_verify", "waiting_confirmation"), {
        phase: "publish_verify",
        status: "running",
        confirmation: consumeGrant("publish")
      })
    ).toBe("running");
  });

  it.each([
    ["publish_confirm", "publish"],
    ["numbers_confirm", "import_numbers"],
    ["dial_confirm", "start_dial"]
  ] as const)(
    "requires a new %s grant to resume its recovered phase",
    (phase, action) => {
      transition(state(phase, "waiting_confirmation"), {
        phase,
        status: "running",
        recovered: true
      });

      expect(() =>
        transition(state(phase, "waiting_confirmation"), {
          phase,
          status: "running"
        })
      ).toThrowError(`${action} confirmation grant required`);
      expect(
        transition(state(phase, "waiting_confirmation"), {
          phase,
          status: "running",
          confirmation: consumeGrant(action)
        })
      ).toBe("running");
    }
  );

  it("does not advance an unknown predecessor to complete", () => {
    expect(() =>
      transition(
        state("call_verify", "unknown"),
        { phase: "complete", status: "succeeded" }
      )
    ).toThrow("phase call_verify must succeed before advancing");
  });
});
