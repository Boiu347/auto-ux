import { describe, expect, it, vi } from "vitest";

import {
  canAttempt,
  consumeConfirmation,
  createActionFingerprint,
  issueConfirmation
} from "./index.js";
import {
  __getConfirmationRegistrySizeForTests,
  invalidateConfirmations
} from "./confirmation.js";

const futureDate = new Date("2099-01-01T00:00:00.000Z");

describe("action journal", () => {
  it("creates a SHA-256 execution-scoped action fingerprint", () => {
    expect(createActionFingerprint("EX-1", "publish.confirm", "sha256:input")).toBe(
      "sha256:c8ae91f6fdd1f904d5371e1c23af15670fc0792346b0e70aad19c243ff67b041"
    );
  });

  it("allows attempts one and two but rejects attempt three", () => {
    expect(canAttempt(0)).toEqual({ allowed: true });
    expect(canAttempt(1)).toEqual({ allowed: true });
    expect(canAttempt(2)).toEqual({
      allowed: false,
      reason: "retry_budget_exhausted"
    });
  });
});

describe("confirmation", () => {
  it("invalidates an older live token when the same exact gate is issued again", () => {
    const first = issueConfirmation("publish", "EX-1", 4, futureDate);
    const second = issueConfirmation("publish", "EX-1", 4, futureDate);

    expect(consumeConfirmation(first, "publish", "EX-1", 4)).toEqual({
      ok: false,
      reason: "invalidated"
    });
    expect(consumeConfirmation(second, "publish", "EX-1", 4).ok).toBe(true);
  });

  it("keeps tokens for different gate bindings independent", () => {
    const oldVersion = issueConfirmation("publish", "EX-1", 4, futureDate);
    const newVersion = issueConfirmation("publish", "EX-1", 5, futureDate);

    expect(consumeConfirmation(oldVersion, "publish", "EX-1", 4).ok).toBe(true);
    expect(consumeConfirmation(newVersion, "publish", "EX-1", 5).ok).toBe(true);
  });

  it("consumes a start_dial token only once", () => {
    const token = issueConfirmation("start_dial", "EX-1", 4, futureDate);

    const result = consumeConfirmation(token, "start_dial", "EX-1", 4);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant).toBeDefined();
    }
    expect(consumeConfirmation(token, "start_dial", "EX-1", 4)).toEqual({
      ok: false,
      reason: "already_consumed"
    });
  });

  it("rejects use for a different action, execution, or config version", () => {
    const token = issueConfirmation("publish", "EX-1", 4, futureDate);

    expect(consumeConfirmation(token, "import_numbers", "EX-1", 4)).toEqual({
      ok: false,
      reason: "action_mismatch"
    });
    expect(consumeConfirmation(token, "publish", "EX-2", 4)).toEqual({
      ok: false,
      reason: "execution_mismatch"
    });
    expect(consumeConfirmation(token, "publish", "EX-1", 5)).toEqual({
      ok: false,
      reason: "config_version_mismatch"
    });
  });

  it("rejects an expired token", () => {
    const token = issueConfirmation(
      "publish",
      "EX-1",
      4,
      new Date("2000-01-01T00:00:00.000Z")
    );

    expect(consumeConfirmation(token, "publish", "EX-1", 4)).toEqual({
      ok: false,
      reason: "expired"
    });
  });

  it("prunes terminal confirmation records back to the prior registry size", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const baseline = __getConfirmationRegistrySizeForTests();

      for (let index = 0; index < 100; index += 1) {
        const id = `EX-CONSUMED-${index}`;
        const token = issueConfirmation("publish", id, 1, new Date(2_000));
        expect(consumeConfirmation(token, "publish", id, 1).ok).toBe(true);
      }
      for (let index = 0; index < 100; index += 1) {
        const id = `EX-EXPIRED-${index}`;
        const token = issueConfirmation("import_numbers", id, 1, new Date(0));
        expect(consumeConfirmation(token, "import_numbers", id, 1)).toEqual({
          ok: false,
          reason: "expired"
        });
      }
      for (let index = 0; index < 100; index += 1) {
        const id = `EX-INVALIDATED-${index}`;
        issueConfirmation("start_dial", id, 1, new Date(2_000));
        invalidateConfirmations("start_dial", id, 1);
      }

      now.mockReturnValue(2_001);
      expect(__getConfirmationRegistrySizeForTests()).toBe(baseline);
    } finally {
      now.mockRestore();
    }
  });
});
