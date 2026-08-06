import { NextResponse } from "next/server";

import {
  getCurrentUser,
  type CurrentUser
} from "../../../server/auth/current-user";
import {
  CreateExecutionRequestSchema,
  createExecutionService,
  ExecutionService,
  ExecutionServiceError
} from "../../../server/executions/service";

type ResolveService = (user: CurrentUser) => ExecutionService;

export function createExecutionCollectionHandlers(
  resolveService: ResolveService
) {
  return {
    async POST(request: Request): Promise<Response> {
      const user = getCurrentUser(request);
      if (!user) {
        return errorResponse("UNAUTHENTICATED", 401);
      }

      try {
        const body = CreateExecutionRequestSchema.parse(await request.json());
        const result = await resolveService(user).createExecution(user, body);
        return NextResponse.json(result, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    }
  };
}

function handleError(error: unknown): Response {
  if (error instanceof ExecutionServiceError) {
    return errorResponse(error.code, error.status);
  }
  if (
    error instanceof SyntaxError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ZodError")
  ) {
    return errorResponse("INVALID_REQUEST", 400);
  }
  throw error;
}

function errorResponse(code: string, status: number): Response {
  return NextResponse.json({ code }, { status });
}

const handlers = createExecutionCollectionHandlers(createExecutionService);

export const POST = handlers.POST;
export const runtime = "nodejs";
