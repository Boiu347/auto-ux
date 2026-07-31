import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDevelopmentReadinessHandler } from "./route";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("development demo readiness", () => {
  it("is unreachable in production even when a demo file exists", async () => {
    const stateFile = await demoStateFile();
    const response = await createDevelopmentReadinessHandler({
      environment: "production",
      stateFile
    })(new Request("http://localhost/api/dev/ready"));

    expect(response.status).toBe(404);
  });

  it("reports unavailable until the demo execution file is complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auto-ux-ready-test-"));
    temporaryDirectories.push(directory);
    const response = await createDevelopmentReadinessHandler({
      environment: "test",
      stateFile: join(directory, "missing.json")
    })(new Request("http://localhost/api/dev/ready"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ready: false });
  });

  it("reports ready only after a valid execution id is durable", async () => {
    const stateFile = await demoStateFile();
    const response = await createDevelopmentReadinessHandler({
      environment: "test",
      stateFile
    })(new Request("http://localhost/api/dev/ready"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ready: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

async function demoStateFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "auto-ux-ready-test-"));
  temporaryDirectories.push(directory);
  const stateFile = join(directory, "demo.json");
  await writeFile(
    stateFile,
    JSON.stringify({ execution: { id: "execution_ready" } }),
    "utf8"
  );
  return stateFile;
}
