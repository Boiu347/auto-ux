const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const publicBasePath = configuredBasePath
  ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

export function publicPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("public path must start with /");
  }
  return `${publicBasePath}${path}`;
}

export function publicOrigin(origin: string): string {
  return `${origin.replace(/\/$/, "")}${publicBasePath}`;
}
