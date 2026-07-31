import { NextResponse } from "next/server";

import {
  getCurrentUser,
  type CurrentUser
} from "../../../../../../server/auth/current-user";
import {
  ClaimExecutionRequestSchema,
  createExecutionService,
  ExecutionService,
  ExecutionServiceError
} from "../../../../../../server/executions/service";

type RouteContext = { params: Promise<{ executionId: string }> };
type ResolveService = (user: CurrentUser) => ExecutionService;
type Authenticate = (request: Request) => CurrentUser | null;

export function createAgentClaimHandler(
  resolveService: ResolveService,
  authenticate: Authenticate = getCurrentUser
) {
  return async function POST(
    request: Request,
    routeContext: RouteContext
  ): Promise<Response> {
    const user = authenticate(request);
    if (!user) {
      return errorResponse("UNAUTHENTICATED", 401);
    }
    try {
      const { executionId } = await routeContext.params;
      const manifest = ClaimExecutionRequestSchema.parse(await request.json());
      if (manifest.executionId !== executionId) {
        return errorResponse("EXECUTION_ID_MISMATCH", 400);
      }
      const claimed = await resolveService(user).claimExecution(manifest);
      return NextResponse.json(claimed, { status: 201 });
    } catch (error) {
      return handleError(error);
    }
  };
}

function handleError(error: unknown): Response {
  if (error instanceof ExecutionServiceError) {
    return errorResponse(error.code, error.status);
  }
  if (
    error instanceof SyntaxError ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "ZodError")
  ) {
    return errorResponse("INVALID_REQUEST", 400);
  }
  throw error;
}

function errorResponse(code: string, status: number): Response {
  return NextResponse.json({ code }, { status });
}

export const POST = createAgentClaimHandler(createExecutionService);
export const runtime = "nodejs";
