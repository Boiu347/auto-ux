import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("development demo route", () => {
  it("is unreachable in production before authentication or file access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_DEMO_STATE_FILE", "/must/not/be/read.json");

    const response = await POST(
      new Request("http://localhost/api/dev/demo", { method: "POST" })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND" });
  });
});
