import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../server/auth/current-user";
import {
  createExecutionService,
  ExecutionServiceError
} from "../../../../server/executions/service";

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  const user = getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  }
  const stateFile = process.env.DEV_DEMO_STATE_FILE;
  if (!stateFile) {
    return NextResponse.json({ code: "DEMO_NOT_CONFIGURED" }, { status: 404 });
  }

  try {
    const state = JSON.parse(await readFile(stateFile, "utf8")) as {
      execution?: { id?: unknown };
    };
    if (typeof state.execution?.id !== "string") {
      return NextResponse.json({ code: "DEMO_NOT_READY" }, { status: 503 });
    }
    const persisted = await createExecutionService(user).getExecution(
      state.execution.id
    );
    return NextResponse.json({ execution: persisted.execution });
  } catch (error) {
    if (error instanceof ExecutionServiceError) {
      return NextResponse.json({ code: error.code }, { status: error.status });
    }
    return NextResponse.json({ code: "DEMO_NOT_READY" }, { status: 503 });
  }
}

export const runtime = "nodejs";
