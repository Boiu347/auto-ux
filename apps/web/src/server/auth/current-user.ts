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
  environment = process.env.NODE_ENV
): CurrentUser | null {
  if (environment !== "development" && environment !== "test") {
    return null;
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
