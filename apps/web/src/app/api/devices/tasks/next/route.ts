import { NextResponse } from "next/server";

import type { DeviceService } from "../../../../../server/devices/device-service";
import { readDeviceBearerToken } from "../../../../../server/devices/device-http";
import { deviceService } from "../../../../../server/devices/device-runtime";

type TaskClaimer = Pick<DeviceService, "claimNextTask">;

export function createNextTaskHandler(service: TaskClaimer) {
  return async function GET(request: Request): Promise<Response> {
    const token = readDeviceBearerToken(request);
    if (!token) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    try {
      const version = request.headers.get("x-auto-ux-agent-version") ?? undefined;
      const task = await service.claimNextTask(token, version);
      return task ? NextResponse.json({ task }) : new Response(null, { status: 204 });
    } catch (error) {
      const code = error instanceof Error ? error.message : "UNAUTHENTICATED";
      return NextResponse.json({ code }, { status: code === "UNAUTHENTICATED" ? 401 : 400 });
    }
  };
}

export const GET = createNextTaskHandler(deviceService);
export const runtime = "nodejs";
