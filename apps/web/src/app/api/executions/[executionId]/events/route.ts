import { NextResponse } from "next/server";

import {
  getCurrentUser,
  type CurrentUser
} from "../../../../../server/auth/current-user";
import {
  AppendExecutionEventRequestSchema,
  createExecutionService,
  ExecutionService,
  ExecutionServiceError
} from "../../../../../server/executions/service";
import { createExecutionAgentAuthenticator } from "../../../../../server/executions/agent-auth";

type RouteContext = {
  params: Promise<{ executionId: string }>;
};

type ResolveService = (user: CurrentUser) => ExecutionService;
type Authenticate = (request: Request) => CurrentUser | null;
type AuthenticateAgent = (
  request: Request,
  executionId: string
) => Promise<CurrentUser | null>;

const executionAgentAuthenticator = createExecutionAgentAuthenticator();

export function createEventsHandlers(
  resolveService: ResolveService,
  authenticate: Authenticate = getCurrentUser,
  authenticateAgent: AuthenticateAgent = (request, executionId) =>
    executionAgentAuthenticator.authenticate(request, executionId)
) {
  return {
    async POST(request: Request, routeContext: RouteContext): Promise<Response> {
      const { executionId } = await routeContext.params;
      const user = request.headers.has("authorization")
        ? await authenticateAgent(request, executionId)
        : authenticate(request);
      if (!user) {
        return errorResponse("UNAUTHENTICATED", 401);
      }

      try {
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
      const user = authenticate(request);
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

const handlers = createEventsHandlers(createExecutionService);

export const GET = handlers.GET;
export const POST = handlers.POST;
export const runtime = "nodejs";
