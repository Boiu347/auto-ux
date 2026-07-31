import { describe, expect, it } from "vitest";
import { ExecutionStatusSchema } from "@app/contracts";

describe("@app/contracts consumer", () => {
  it("resolves the declared package entry point", () => {
    expect(ExecutionStatusSchema.safeParse("unknown").success).toBe(true);
  });
});
