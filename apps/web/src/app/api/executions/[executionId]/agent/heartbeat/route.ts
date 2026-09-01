import { NextResponse } from "next/server";

import {
  getCurrentUser,
  type CurrentUser
} from "../../../../../../server/auth/current-user";
import {
  createExecutionService,
  ExecutionService,
  ExecutionServiceError,
  HeartbeatExecutionRequestSchema
} from "../../../../../../server/executions/service";
import {
  createExecutionAgentAuthenticator,
  ExecutionAgentAuthenticationError
} from "../../../../../../server/executions/agent-auth";

type RouteContext = { params: Promise<{ executionId: string }> };
type ResolveService = (user: CurrentUser) => ExecutionService;
type Authenticate = (request: Request) => CurrentUser | null;
type AuthenticateAgent = (
  request: Request,
  executionId: string
) => Promise<CurrentUser | null>;

const executionAgentAuthenticator = createExecutionAgentAuthenticator();

export function createAgentHeartbeatHandler(
  resolveService: ResolveService,
  authenticate: Authenticate = getCurrentUser,
  authenticateAgent: AuthenticateAgent = (request, executionId) =>
    executionAgentAuthenticator.authenticate(request, executionId)
) {
  return async function POST(
    request: Request,
    routeContext: RouteContext
  ): Promise<Response> {
    const { executionId } = await routeContext.params;
    try {
      const user = request.headers.has("authorization")
        ? await authenticateAgent(request, executionId)
        : authenticate(request);
      if (!user) return errorResponse("UNAUTHENTICATED", 401);
      const body = HeartbeatExecutionRequestSchema.parse(await request.json());
      await resolveService(user).heartbeatExecution(
        executionId,
        body.agentId,
        body.sessionId
      );
      return NextResponse.json({ renewed: true });
    } catch (error) {
      return handleError(error);
    }
  };
}

function handleError(error: unknown): Response {
  if (error instanceof ExecutionAgentAuthenticationError) {
    return errorResponse(error.code, 401);
  }
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

export const POST = createAgentHeartbeatHandler(createExecutionService);
export const runtime = "nodejs";
