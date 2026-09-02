import { createHmac, timingSafeEqual } from "node:crypto";

import type { CurrentUser } from "./current-user";

export const authSessionCookieName = "auto_ux_session";
export const oauthStateCookieName = "auto_ux_oauth_state";

export type AuthenticatedUser = CurrentUser & {
  name: string;
  avatarUrl: string | null;
};

type SessionPayload = AuthenticatedUser & {
  version: 1;
  expiresAt: number;
};

export type OAuthStatePayload = {
  version: 1;
  state: string;
  codeVerifier: string;
  expiresAt: number;
};

const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function createAuthSessionToken(
  user: AuthenticatedUser,
  secret: string,
  now = new Date(),
  maxAgeSeconds = 7 * 24 * 60 * 60
): string {
  if (!isValidUser(user) || secret.length < 32) {
    throw new Error("AUTH_CONFIGURATION_INVALID");
  }
  return signPayload(
    {
      version: 1,
      ...user,
      expiresAt: now.getTime() + maxAgeSeconds * 1_000
    } satisfies SessionPayload,
    secret
  );
}

export function readAuthSession(
  request: Request,
  secret = process.env.AUTH_SESSION_SECRET,
  now = new Date()
): AuthenticatedUser | null {
  if (!secret || secret.length < 32) return null;
  const token = readCookie(request.headers.get("cookie"), authSessionCookieName);
  const payload = token ? verifyPayload<SessionPayload>(token, secret) : null;
  if (
    !payload ||
    payload.version !== 1 ||
    !isValidUser(payload) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= now.getTime()
  ) {
    return null;
  }
  return {
    userId: payload.userId,
    workspaceId: payload.workspaceId,
    name: payload.name,
    avatarUrl: payload.avatarUrl
  };
}

export function createOAuthStateToken(
  payload: OAuthStatePayload,
  secret: string
): string {
  if (
    secret.length < 32 ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(payload.state) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(payload.codeVerifier) ||
    !Number.isSafeInteger(payload.expiresAt)
  ) {
    throw new Error("AUTH_CONFIGURATION_INVALID");
  }
  return signPayload(payload, secret);
}

export function readOAuthState(
  request: Request,
  secret: string,
  now = new Date()
): OAuthStatePayload | null {
  if (secret.length < 32) return null;
  const token = readCookie(request.headers.get("cookie"), oauthStateCookieName);
  const payload = token ? verifyPayload<OAuthStatePayload>(token, secret) : null;
  if (
    !payload ||
    payload.version !== 1 ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(payload.state) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(payload.codeVerifier) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= now.getTime()
  ) {
    return null;
  }
  return payload;
}

export function authSessionCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds = 7 * 24 * 60 * 60
): string {
  return serializeCookie(authSessionCookieName, token, {
    maxAgeSeconds,
    path: applicationCookiePath(),
    secure
  });
}

export function clearAuthSessionCookie(secure: boolean): string {
  return serializeCookie(authSessionCookieName, "", {
    maxAgeSeconds: 0,
    path: applicationCookiePath(),
    secure
  });
}

export function oauthStateCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds = 5 * 60
): string {
  return serializeCookie(oauthStateCookieName, token, {
    maxAgeSeconds,
    path: `${applicationCookiePath()}api/auth/feishu`,
    secure
  });
}

export function clearOAuthStateCookie(secure: boolean): string {
  return serializeCookie(oauthStateCookieName, "", {
    maxAgeSeconds: 0,
    path: `${applicationCookiePath()}api/auth/feishu`,
    secure
  });
}

export function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  return forwarded ? forwarded === "https" : new URL(request.url).protocol === "https:";
}

function applicationCookiePath(): string {
  const configured = process.env.NEXT_PUBLIC_BASE_PATH?.trim();
  if (!configured) return "/";
  return `/${configured.replace(/^\/+|\/+$/g, "")}/`;
}

function signPayload(value: object, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

function verifyPayload<T>(token: string, secret: string): T | null {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  const expected = Buffer.from(signature(payload, secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; path: string; secure: boolean }
): string {
  return [
    `${name}=${value}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
    options.secure ? "Secure" : ""
  ]
    .filter(Boolean)
    .join("; ");
}

function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function isValidUser(user: AuthenticatedUser): boolean {
  return (
    identifierPattern.test(user.userId) &&
    identifierPattern.test(user.workspaceId) &&
    typeof user.name === "string" &&
    user.name.length > 0 &&
    user.name.length <= 256 &&
    (user.avatarUrl === null ||
      (typeof user.avatarUrl === "string" && user.avatarUrl.length <= 2_048))
  );
}
