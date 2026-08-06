import { prisma } from "@app/db";
import { NextResponse } from "next/server";

import type { CurrentUser } from "../../../../server/auth/current-user";
import { getRequestUser } from "../../../../server/auth/request-user";

type Context = { params: Promise<{ executionId: string }> };
type Delivery = { status: string; errorCode: string | null; updatedAt: Date };
type Dependencies = {
  authenticate(request: Request): Promise<CurrentUser | null> | CurrentUser | null;
  find(scope: CurrentUser, executionId: string): Promise<Delivery | null>;
};

export function createPairedTaskStatusHandler(dependencies: Dependencies) {
  return async function GET(request: Request, context: Context): Promise<Response> {
    const scope = await dependencies.authenticate(request);
    if (!scope) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    const { executionId } = await context.params;
    const task = await dependencies.find(scope, executionId);
    if (!task) return NextResponse.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({
      status: task.status,
      errorCode: task.errorCode,
      updatedAt: task.updatedAt.toISOString()
    });
  };
}

export const GET = createPairedTaskStatusHandler({
  authenticate: getRequestUser,
  find: (scope, executionId) => prisma.deviceTask.findFirst({
    where: {
      executionId,
      pairing: { userId: scope.userId, workspaceId: scope.workspaceId }
    },
    select: { status: true, errorCode: true, updatedAt: true }
  })
});
export const runtime = "nodejs";
