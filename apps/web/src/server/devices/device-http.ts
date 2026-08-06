export const pairedBrowserCookieName = "paired_browser";

export function readPairedBrowserToken(request: Request): string | null {
  return readCookie(request.headers.get("cookie"), pairedBrowserCookieName) ?? null;
}

export function readDeviceBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return /^device_token:[a-f0-9]{64}$/.test(token) ? token : null;
}

export function pairedBrowserCookie(token: string, secure: boolean): string {
  return [
    `${pairedBrowserCookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
    secure ? "Secure" : ""
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
