import { getCurrentUser, type CurrentUser } from "./current-user";
import { readPairedBrowserToken } from "../devices/device-http";
import { deviceService } from "../devices/device-runtime";

export async function getRequestUser(request: Request): Promise<CurrentUser | null> {
  const developmentUser = getCurrentUser(request);
  if (developmentUser) return developmentUser;

  const token = readPairedBrowserToken(request);
  if (!token) return null;
  try {
    const scope = await deviceService.getBrowserScope(token);
    return { userId: scope.userId, workspaceId: scope.workspaceId };
  } catch {
    return null;
  }
}
