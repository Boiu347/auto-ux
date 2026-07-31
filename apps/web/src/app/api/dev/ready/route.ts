import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

export function createDevelopmentReadinessHandler({
  environment = process.env.NODE_ENV,
  stateFile = process.env.DEV_DEMO_STATE_FILE
}: {
  environment?: string;
  stateFile?: string;
} = {}) {
  return async function GET(_request: Request): Promise<Response> {
    if (environment !== "development" && environment !== "test") {
      return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    if (!stateFile) {
      return notReady();
    }
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as {
        execution?: { id?: unknown };
      };
      if (typeof state.execution?.id !== "string") {
        return notReady();
      }
      return NextResponse.json(
        { ready: true },
        { headers: { "cache-control": "no-store" } }
      );
    } catch {
      return notReady();
    }
  };
}

function notReady(): Response {
  return NextResponse.json(
    { ready: false },
    { status: 503, headers: { "cache-control": "no-store" } }
  );
}

export const GET = createDevelopmentReadinessHandler();
export const runtime = "nodejs";
