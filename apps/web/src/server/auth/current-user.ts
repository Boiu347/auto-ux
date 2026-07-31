import { readDevelopmentSession } from "./development-session";

export interface CurrentUser {
  userId: string;
  workspaceId: string;
}

const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Development-only authentication adapter. Feishu OAuth can replace this
 * module without changing execution route handlers.
 */
export function getCurrentUser(
  request: Request,
  environment = process.env.NODE_ENV,
  developmentSessionSecret = process.env.DEV_SESSION_SECRET,
  localTestKey = process.env.AUTO_UX_LOCAL_TEST_KEY
): CurrentUser | null {
  const localTestEnabled =
    typeof localTestKey === "string" && localTestKey.length >= 32;
  if (
    environment !== "development" &&
    environment !== "test" &&
    !localTestEnabled
  ) {
    return null;
  }

  if (developmentSessionSecret) {
    const sessionUser = readDevelopmentSession(
      request,
      developmentSessionSecret
    );
    if (sessionUser) {
      return sessionUser;
    }
  }

  const userId = request.headers.get("x-dev-user-id");
  const workspaceId = request.headers.get("x-dev-workspace-id");
  const suppliedLocalTestKey = request.headers.get("x-auto-ux-local-key");

  if (
    !userId ||
    !workspaceId ||
    !identifierPattern.test(userId) ||
    !identifierPattern.test(workspaceId) ||
    (environment === "production" && suppliedLocalTestKey !== localTestKey)
  ) {
    return null;
  }

  return { userId, workspaceId };
}
