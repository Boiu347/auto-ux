import { NextResponse } from "next/server";
import { z } from "zod";

import type { DeviceService } from "../../../../../server/devices/device-service";
import { readDeviceBearerToken } from "../../../../../server/devices/device-http";
import { deviceService } from "../../../../../server/devices/device-runtime";

const ResultSchema = z.discriminatedUnion("status", [
  z.object({
    claimToken: z.string().regex(/^task_claim:[a-f0-9]{64}$/),
    status: z.literal("codex_opened")
  }).strict(),
  z.object({
    claimToken: z.string().regex(/^task_claim:[a-f0-9]{64}$/),
    status: z.literal("waiting_permission"),
    errorCode: z.literal("MAC_ACCESSIBILITY_REQUIRED")
  }).strict(),
  z.object({
    claimToken: z.string().regex(/^task_claim:[a-f0-9]{64}$/),
    status: z.literal("prompt_sent")
  }).strict(),
  z.object({
    claimToken: z.string().regex(/^task_claim:[a-f0-9]{64}$/),
    status: z.literal("failed"),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)
  }).strict()
]);

type TaskUpdater = Pick<DeviceService, "updateTask">;
type Context = { params: Promise<{ taskId: string }> };

export function createDeviceTaskStatusHandler(service: TaskUpdater) {
  return async function POST(request: Request, context: Context): Promise<Response> {
    const deviceToken = readDeviceBearerToken(request);
    if (!deviceToken) {
      return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    }
    try {
      const { taskId } = await context.params;
      const input = ResultSchema.parse(await request.json());
      const task = await service.updateTask(deviceToken, taskId, input);
      return NextResponse.json({
        task: { id: task.id, status: task.status, errorCode: task.errorCode }
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_TASK_RESULT";
      return NextResponse.json(
        { code },
        { status: code === "UNAUTHENTICATED" ? 401 : code === "TASK_CLAIM_MISMATCH" ? 409 : 400 }
      );
    }
  };
}

export const POST = createDeviceTaskStatusHandler(deviceService);
export const runtime = "nodejs";
