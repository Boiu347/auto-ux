import { NextResponse } from "next/server";

import {
  getCurrentUser,
  type CurrentUser
} from "../../../../../server/auth/current-user";
import {
  CreateConfirmationRequestSchema,
  createExecutionService,
  ExecutionService,
  ExecutionServiceError
} from "../../../../../server/executions/service";

type RouteContext = {
  params: Promise<{ executionId: string }>;
};

type ResolveService = (user: CurrentUser) => ExecutionService;
type Authenticate = (request: Request) => CurrentUser | null;

export function createConfirmationHandler(
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
      const body = CreateConfirmationRequestSchema.parse(await request.json());
      const confirmation = await resolveService(
        user
      ).issueCreatorConfirmation(
        executionId,
        body.action,
        body.configVersion
      );
      return NextResponse.json({ confirmation }, { status: 201 });
    } catch (error) {
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
  };
}

function errorResponse(code: string, status: number): Response {
  return NextResponse.json({ code }, { status });
}

export const POST = createConfirmationHandler(createExecutionService);
export const runtime = "nodejs";
