import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getCurrentUser,
  type CurrentUser
} from "../../../../server/auth/current-user";
import {
  MacCodexLauncher,
  MacCodexLauncherError,
  type MacCodexLaunchResult
} from "../../../../server/local-launch/mac-codex-launcher";

const LaunchRequestSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 32 * 1024)
  })
  .strict();

type Launcher = { launch(prompt: string): Promise<MacCodexLaunchResult> };
type LaunchOptions = {
  authenticate: (request: Request) => CurrentUser | null;
  nodeEnv: string | undefined;
  enabled: boolean;
};

export function createLocalLaunchHandler(
  launcher: Launcher,
  options: LaunchOptions
) {
  return async function POST(request: Request): Promise<Response> {
    if (!options.authenticate(request)) {
      return errorResponse("UNAUTHENTICATED", 401);
    }
    if (options.nodeEnv === "production" || !options.enabled) {
      return errorResponse("LOCAL_LAUNCH_DISABLED", 404);
    }
    const url = new URL(request.url);
    if (!isLoopback(url.hostname) || request.headers.get("origin") !== url.origin) {
      return errorResponse("LOCAL_REQUEST_REQUIRED", 403);
    }

    try {
      const body = LaunchRequestSchema.parse(await request.json());
      return NextResponse.json(await launcher.launch(body.prompt));
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "ZodError") ||
        (error instanceof MacCodexLauncherError && error.code === "PROMPT_TOO_LARGE")
      ) {
        return errorResponse("INVALID_REQUEST", 400);
      }
      if (error instanceof MacCodexLauncherError) {
        return errorResponse(error.code, 500);
      }
      throw error;
    }
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function errorResponse(code: string, status: number): Response {
  return NextResponse.json({ code }, { status });
}

export const POST = createLocalLaunchHandler(new MacCodexLauncher(), {
  authenticate: getCurrentUser,
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AUTO_UX_LOCAL_CODEX_LAUNCH === "1"
});
export const runtime = "nodejs";
