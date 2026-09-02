import { getCurrentUser, type CurrentUser } from "./current-user";
import {
  readCentralAuthIdentity,
  resolveCentralAuthIdentity
} from "./central-auth";
import { readAuthSession } from "./session";
import type { AuthenticatedUser } from "./session";
import { readPairedBrowserToken } from "../devices/device-http";

export async function getAuthenticatedRequestUser(
  request: Request
): Promise<AuthenticatedUser | null> {
  const developmentUser = getCurrentUser(request);
  if (developmentUser) {
    return { ...developmentUser, name: "本地开发", avatarUrl: null };
  }
  const centralIdentity = readCentralAuthIdentity(request);
  if (centralIdentity) {
    return resolveCentralAuthIdentity(
      centralIdentity,
      readPairedBrowserToken(request)
    );
  }
  const session = readAuthSession(request);
  return session;
}

export async function getRequestUser(request: Request): Promise<CurrentUser | null> {
  const user = await getAuthenticatedRequestUser(request);
  return user ? { userId: user.userId, workspaceId: user.workspaceId } : null;
}
