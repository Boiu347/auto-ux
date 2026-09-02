import { NextResponse } from "next/server";

import type { CurrentUser } from "../../../server/auth/current-user";
import { getRequestUser } from "../../../server/auth/request-user";
import {
  TaskFormDraftSchema,
  TaskWorkspaceService,
  taskWorkspaceService
} from "../../../server/task-workspace/service";

type Authenticate = (
  request: Request
) => CurrentUser | null | Promise<CurrentUser | null>;

export function createTaskWorkspaceHandlers(
  service: TaskWorkspaceService,
  authenticate: Authenticate = getRequestUser
) {
  const requireUser = async (request: Request) => authenticate(request);
  return {
    async GET(request: Request): Promise<Response> {
      const user = await requireUser(request);
      if (!user) {
        return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      }
      return NextResponse.json(await service.getWorkspace(user));
    },

    async PUT(request: Request): Promise<Response> {
      const user = await requireUser(request);
      if (!user) {
        return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      }
      try {
        const input = TaskFormDraftSchema.parse(await request.json());
        return NextResponse.json({ draft: await service.saveDraft(user, input) });
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (typeof error === "object" &&
            error !== null &&
            "name" in error &&
            error.name === "ZodError")
        ) {
          return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
        }
        throw error;
      }
    },

    async DELETE(request: Request): Promise<Response> {
      const user = await requireUser(request);
      if (!user) {
        return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      }
      await service.deleteDraft(user);
      return new Response(null, { status: 204 });
    }
  };
}

const handlers = createTaskWorkspaceHandlers(taskWorkspaceService);

export const GET = handlers.GET;
export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
export const runtime = "nodejs";
