import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ExecutionAgentAuthenticator } from "./agent-auth";

describe("ExecutionAgentAuthenticator", () => {
  it("authenticates an exact execution-scoped bearer token", async () => {
    const token = `execution_token:${"a".repeat(64)}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const resolve = vi.fn(async () => ({
      userId: "U-1",
      workspaceId: "W-1",
      mode: "real_codex" as const,
      tokenExpiresAt: new Date("2026-08-07T00:00:00.000Z")
    }));
    const authenticator = new ExecutionAgentAuthenticator(resolve);

    await expect(
      authenticator.authenticate(
        new Request("http://localhost/api/executions/EX-1/agent/claim", {
          headers: { authorization: `Bearer ${token}` }
        }),
        "EX-1"
      )
    ).resolves.toMatchObject({ userId: "U-1", workspaceId: "W-1" });
    expect(resolve).toHaveBeenCalledWith(tokenHash, "EX-1");
  });

  it.each([
    undefined,
    "Basic nope",
    "Bearer execution_token:short",
    `Bearer execution_token:${"A".repeat(64)}`
  ])("rejects a missing or malformed bearer value", async (authorization) => {
    const resolve = vi.fn();
    const authenticator = new ExecutionAgentAuthenticator(resolve);
    const headers = authorization ? { authorization } : undefined;

    await expect(
      authenticator.authenticate(
        new Request("http://localhost/api/executions/EX-1/events", { headers }),
        "EX-1"
      )
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
