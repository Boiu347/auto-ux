import { createHmac, timingSafeEqual } from "node:crypto";

import type { CurrentUser } from "./current-user";

export const developmentSessionCookieName = "dev_session";

const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type DevelopmentSessionPayload = CurrentUser & { expiresAt: number };

export function createDevelopmentSessionCookie(
  user: CurrentUser,
  secret: string,
  now = new Date(),
  maxAgeSeconds = 8 * 60 * 60
): string {
  if (!isValidUser(user) || secret.length < 32) {
    throw new Error("invalid development session configuration");
  }
  const payload = Buffer.from(
    JSON.stringify({
      ...user,
      expiresAt: now.getTime() + maxAgeSeconds * 1_000
    } satisfies DevelopmentSessionPayload)
  ).toString("base64url");
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

export function readDevelopmentSession(
  request: Request,
  secret: string,
  now = new Date()
): CurrentUser | null {
  if (secret.length < 32) {
    return null;
  }
  const token = readCookie(
    request.headers.get("cookie"),
    developmentSessionCookieName
  );
  if (!token) {
    return null;
  }
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) {
    return null;
  }
  const expectedSignature = sign(payload, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as DevelopmentSessionPayload;
    if (
      !isValidUser(parsed) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= now.getTime()
    ) {
      return null;
    }
    return { userId: parsed.userId, workspaceId: parsed.workspaceId };
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function isValidUser(user: CurrentUser): boolean {
  return (
    identifierPattern.test(user.userId) &&
    identifierPattern.test(user.workspaceId)
  );
}
