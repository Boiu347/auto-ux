import { NextResponse } from "next/server";

import {
  clearAuthSessionCookie,
  requestIsSecure
} from "../../../../server/auth/session";
import { getAuthenticatedRequestUser } from "../../../../server/auth/request-user";
import { readCentralAuthIdentity } from "../../../../server/auth/central-auth";

export function createAuthSessionHandlers(
  readSession: typeof getAuthenticatedRequestUser = getAuthenticatedRequestUser,
  isManagedByProxy: (request: Request) => boolean = (request) =>
    Boolean(readCentralAuthIdentity(request))
) {
  return {
    async GET(request: Request): Promise<Response> {
      const user = await readSession(request);
      if (!user) {
        const response = NextResponse.json(
          { authenticated: false },
          { status: 401 }
        );
        response.headers.set("cache-control", "no-store");
        return response;
      }
      const response = NextResponse.json({
        authenticated: true,
        managedByProxy: isManagedByProxy(request),
        user: { name: user.name, avatarUrl: user.avatarUrl }
      });
      response.headers.set("cache-control", "no-store");
      return response;
    },
    async DELETE(request: Request): Promise<Response> {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin) {
        return NextResponse.json({ code: "CROSS_ORIGIN_REQUEST" }, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          "cache-control": "no-store",
          "set-cookie": clearAuthSessionCookie(requestIsSecure(request))
        }
      });
    }
  };
}

const handlers = createAuthSessionHandlers();
export const GET = handlers.GET;
export const DELETE = handlers.DELETE;
export const runtime = "nodejs";
