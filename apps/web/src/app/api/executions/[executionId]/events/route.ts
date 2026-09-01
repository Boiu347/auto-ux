import { NextResponse } from "next/server";
import { ZodError } from "zod";

import type { CurrentUser } from "../../../../../server/auth/current-user";
import { getRequestUser } from "../../../../../server/auth/request-user";
import {
  AppendExecutionEventRequestSchema,
  createExecutionService,
  ExecutionService,
  ExecutionServiceError
} from "../../../../../server/executions/service";
import {
  createExecutionAgentAuthenticator,
  ExecutionAgentAuthenticationError
} from "../../../../../server/executions/agent-auth";

type RouteContext = {
  params: Promise<{ executionId: string }>;
};

type ResolveService = (user: CurrentUser) => ExecutionService;
type Authenticate = (request: Request) => CurrentUser | null | Promise<CurrentUser | null>;
type AuthenticateAgent = (
  request: Request,
  executionId: string
) => Promise<CurrentUser | null>;

const executionAgentAuthenticator = createExecutionAgentAuthenticator();

export function createEventsHandlers(
  resolveService: ResolveService,
  authenticate: Authenticate = getRequestUser,
  authenticateAgent: AuthenticateAgent = (request, executionId) =>
    executionAgentAuthenticator.authenticate(request, executionId)
) {
  return {
    async POST(request: Request, routeContext: RouteContext): Promise<Response> {
      const { executionId } = await routeContext.params;
      try {
        const user = request.headers.has("authorization")
          ? await authenticateAgent(request, executionId)
          : await authenticate(request);
        if (!user) return errorResponse("UNAUTHENTICATED", 401);
        const body = AppendExecutionEventRequestSchema.parse(
          await request.json()
        );
        if (body.event.executionId !== executionId) {
          return errorResponse("EXECUTION_ID_MISMATCH", 400);
        }

        await resolveService(user).appendEvent(
          body.agentId,
          body.event,
          body.confirmation,
          body.sessionId,
          body.localConfirmation
        );
        return NextResponse.json({ event: body.event }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async GET(request: Request, routeContext: RouteContext): Promise<Response> {
      const user = await authenticate(request);
      if (!user) {
        return errorResponse("UNAUTHENTICATED", 401);
      }

      try {
        const { executionId } = await routeContext.params;
        const url = new URL(request.url);
        const cursor =
          request.headers.get("last-event-id") ??
          url.searchParams.get("cursor") ??
          undefined;
        return await resolveService(user).createEventStream(executionId, cursor);
      } catch (error) {
        return handleError(error);
      }
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
  if (error instanceof ZodError) {
    return errorResponse("INVALID_REQUEST", 400, error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code,
      message: issue.message
    })));
  }
  if (error instanceof SyntaxError) {
    return errorResponse("INVALID_REQUEST", 400, [{
      path: "body",
      code: "invalid_json",
      message: "Request body is not valid JSON"
    }]);
  }
  throw error;
}

function errorResponse(code: string, status: number, details?: unknown): Response {
  return NextResponse.json({ code, ...(details ? { details } : {}) }, { status });
}

const handlers = createEventsHandlers(createExecutionService);

export const GET = handlers.GET;
export const POST = handlers.POST;
export const runtime = "nodejs";
