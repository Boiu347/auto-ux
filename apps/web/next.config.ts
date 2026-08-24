import type { NextConfig } from "next";

const publicBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  basePath: publicBasePath || undefined,
  skipTrailingSlashRedirect: true,
  trailingSlash: true
};

export default nextConfig;
