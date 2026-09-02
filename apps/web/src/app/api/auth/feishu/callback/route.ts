import { NextResponse } from "next/server";

import { publicPath } from "../../../../../lib/public-path";
import {
  exchangeCodeForIdentity,
  hashState,
  PrismaFeishuAuthStore,
  readFeishuAuthConfig,
  statesMatch,
  type FeishuAuthConfig,
  type FeishuAuthStore
} from "../../../../../server/auth/feishu-auth";
import {
  authSessionCookie,
  clearOAuthStateCookie,
  createAuthSessionToken,
  readOAuthState,
  requestIsSecure
} from "../../../../../server/auth/session";

type Dependencies = {
  config(): FeishuAuthConfig;
  store: Pick<FeishuAuthStore, "consumeLoginState" | "resolveIdentity">;
  exchangeIdentity: typeof exchangeCodeForIdentity;
  now(): Date;
  environment: string | undefined;
};

export function createFeishuCallbackHandler(dependencies: Dependencies) {
  return async function GET(request: Request): Promise<Response> {
    const secure = requestIsSecure(request);
    const now = dependencies.now();
    let config: FeishuAuthConfig;
    try {
      if (dependencies.environment === "production" && !secure) {
        throw new Error("HTTPS_REQUIRED");
      }
      config = dependencies.config();
      if (
        dependencies.environment === "production" &&
        new URL(config.redirectUri).protocol !== "https:"
      ) {
        throw new Error("HTTPS_REQUIRED");
      }
    } catch {
      return NextResponse.json(
        { code: "FEISHU_AUTH_NOT_CONFIGURED" },
        { status: 503 }
      );
    }

    const requestUrl = new URL(request.url);
    const suppliedState = requestUrl.searchParams.get("state") ?? "";
    const state = readOAuthState(request, config.sessionSecret, now);
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(suppliedState) ||
      !statesMatch(state.state, suppliedState) ||
      !(await dependencies.store.consumeLoginState(hashState(suppliedState), now))
    ) {
      return responseWithClearedState(
        NextResponse.json({ code: "INVALID_OAUTH_STATE" }, { status: 400 }),
        secure
      );
    }

    if (requestUrl.searchParams.get("error") === "access_denied") {
      return responseWithClearedState(redirectHome(request, "denied"), secure);
    }
    const code = requestUrl.searchParams.get("code") ?? "";
    if (!/^[A-Za-z0-9_-]{20,512}$/.test(code)) {
      return responseWithClearedState(redirectHome(request, "failed"), secure);
    }

    try {
      const identity = await dependencies.exchangeIdentity(
        config,
        code,
        state.codeVerifier
      );
      const user = await dependencies.store.resolveIdentity(identity);
      const sessionToken = createAuthSessionToken(user, config.sessionSecret, now);
      const response = redirectHome(request, "success");
      response.headers.append("set-cookie", authSessionCookie(sessionToken, secure));
      return responseWithClearedState(response, secure);
    } catch {
      return responseWithClearedState(redirectHome(request, "failed"), secure);
    }
  };
}

function redirectHome(request: Request, result: "success" | "denied" | "failed") {
  const target = new URL(publicPath("/"), new URL(request.url).origin);
  target.searchParams.set("auth", result);
  const response = NextResponse.redirect(target, 302);
  response.headers.set("cache-control", "no-store");
  return response;
}

function responseWithClearedState(response: NextResponse, secure: boolean) {
  response.headers.set("cache-control", "no-store");
  response.headers.append("set-cookie", clearOAuthStateCookie(secure));
  return response;
}

const store = new PrismaFeishuAuthStore();
export const GET = createFeishuCallbackHandler({
  config: readFeishuAuthConfig,
  store,
  exchangeIdentity: exchangeCodeForIdentity,
  now: () => new Date(),
  environment: process.env.NODE_ENV
});
export const runtime = "nodejs";
