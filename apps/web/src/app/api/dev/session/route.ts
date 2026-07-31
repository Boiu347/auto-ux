import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createDevelopmentSessionCookie,
  developmentSessionCookieName
} from "../../../../server/auth/development-session";

const DevelopmentSessionRequestSchema = z
  .object({
    userId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    workspaceId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  })
  .strict();

export function createDevelopmentSessionHandlers({
  environment = process.env.NODE_ENV,
  secret = process.env.DEV_SESSION_SECRET
}: {
  environment?: string;
  secret?: string;
} = {}) {
  return {
    async POST(request: Request): Promise<Response> {
      if (environment === "production") {
        return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
      }
      if (!secret || secret.length < 32) {
        return NextResponse.json(
          { code: "DEV_SESSION_SECRET_REQUIRED" },
          { status: 503 }
        );
      }
      const requestUrl = new URL(request.url);
      const origin = request.headers.get("origin");
      if (origin && origin !== requestUrl.origin) {
        return NextResponse.json(
          { code: "CROSS_ORIGIN_REQUEST" },
          { status: 403 }
        );
      }
      try {
        const user = DevelopmentSessionRequestSchema.parse(
          await request.json()
        );
        const value = createDevelopmentSessionCookie(user, secret);
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "set-cookie": `${developmentSessionCookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${requestUrl.protocol === "https:" ? "; Secure" : ""}`
          }
        });
      } catch {
        return NextResponse.json(
          { code: "INVALID_REQUEST" },
          { status: 400 }
        );
      }
    }
  };
}

export const POST = createDevelopmentSessionHandlers().POST;
export const runtime = "nodejs";
