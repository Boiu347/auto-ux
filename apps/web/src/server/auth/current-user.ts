import { readDevelopmentSession } from "./development-session";

export interface CurrentUser {
  userId: string;
  workspaceId: string;
}

const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Development-only authentication adapter. Production requests are handled
 * by the Feishu session adapter in request-user.ts.
 */
export function getCurrentUser(
  request: Request,
  environment = process.env.NODE_ENV,
  developmentSessionSecret = process.env.DEV_SESSION_SECRET
): CurrentUser | null {
  if (environment !== "development" && environment !== "test") {
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
  if (
    !userId ||
    !workspaceId ||
    !identifierPattern.test(userId) ||
    !identifierPattern.test(workspaceId)
  ) {
    return null;
  }

  return { userId, workspaceId };
}
