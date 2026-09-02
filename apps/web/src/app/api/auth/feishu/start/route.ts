import { NextResponse } from "next/server";

import {
  createAuthorizationRequest,
  PrismaFeishuAuthStore,
  readFeishuAuthConfig,
  type FeishuAuthConfig,
  type FeishuAuthStore
} from "../../../../../server/auth/feishu-auth";
import {
  createOAuthStateToken,
  oauthStateCookie,
  requestIsSecure
} from "../../../../../server/auth/session";

type Dependencies = {
  config(): FeishuAuthConfig;
  store: Pick<FeishuAuthStore, "createLoginState">;
  now(): Date;
  environment: string | undefined;
};

export function createFeishuStartHandler(dependencies: Dependencies) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const secure = requestIsSecure(request);
      if (dependencies.environment === "production" && !secure) {
        return NextResponse.json({ code: "HTTPS_REQUIRED" }, { status: 503 });
      }
      const config = dependencies.config();
      if (
        dependencies.environment === "production" &&
        new URL(config.redirectUri).protocol !== "https:"
      ) {
        throw new Error("HTTPS_REQUIRED");
      }
      const auth = createAuthorizationRequest(config, dependencies.now());
      await dependencies.store.createLoginState(auth.stateHash, auth.expiresAt);
      const stateToken = createOAuthStateToken(
        {
          version: 1,
          state: auth.state,
          codeVerifier: auth.codeVerifier,
          expiresAt: auth.expiresAt.getTime()
        },
        config.sessionSecret
      );
      const response = NextResponse.redirect(auth.authorizationUrl, 302);
      response.headers.set("cache-control", "no-store");
      response.headers.set("set-cookie", oauthStateCookie(stateToken, secure));
      return response;
    } catch {
      return NextResponse.json(
        { code: "FEISHU_AUTH_NOT_CONFIGURED" },
        { status: 503 }
      );
    }
  };
}

const store = new PrismaFeishuAuthStore();
export const GET = createFeishuStartHandler({
  config: readFeishuAuthConfig,
  store,
  now: () => new Date(),
  environment: process.env.NODE_ENV
});
export const runtime = "nodejs";
