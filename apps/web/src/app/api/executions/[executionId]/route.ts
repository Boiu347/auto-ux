import { NextResponse } from "next/server";

import {
  getCurrentUser,
  type CurrentUser
} from "../../../../server/auth/current-user";
import {
  createExecutionService,
  ExecutionService,
  ExecutionServiceError
} from "../../../../server/executions/service";

type RouteContext = {
  params: Promise<{ executionId: string }>;
};

type ResolveService = (user: CurrentUser) => ExecutionService;

export function createExecutionItemHandlers(resolveService: ResolveService) {
  return {
    async GET(request: Request, routeContext: RouteContext): Promise<Response> {
      const user = getCurrentUser(request);
      if (!user) {
        return NextResponse.json(
          { code: "UNAUTHENTICATED" },
          { status: 401 }
        );
      }

      try {
        const { executionId } = await routeContext.params;
        return NextResponse.json(
          await resolveService(user).getExecution(executionId)
        );
      } catch (error) {
        if (error instanceof ExecutionServiceError) {
          return NextResponse.json(
            { code: error.code },
            { status: error.status }
          );
        }
        throw error;
      }
    }
  };
}

const handlers = createExecutionItemHandlers(createExecutionService);

export const GET = handlers.GET;
export const runtime = "nodejs";
