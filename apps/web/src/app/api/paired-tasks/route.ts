import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { buildCodexPrompt } from "../../../components/executions/build-codex-prompt";
import type { CurrentUser } from "../../../server/auth/current-user";
import { ExecutionTokenPlaceholder, type DeviceService, type DeviceTaskRecord } from "../../../server/devices/device-service";
import { readPairedBrowserToken } from "../../../server/devices/device-http";
import { deviceService } from "../../../server/devices/device-runtime";
import { createExecutionService } from "../../../server/executions/service";

const TaskInputSchema = z.object({
  requestId: z.string().regex(/^request_[a-f0-9]{16,64}$/),
  feishuUrls: z.array(z.string().url().refine((value) => value.startsWith("https://"))).min(1).max(8),
  requirements: z.string().trim().min(1).max(16_000),
  phoneFilePath: z.string().startsWith("/").refine((value) => !/[\r\n\0]/.test(value)),
  robotName: z.string().max(256).refine((value) => !/[\r\n\0]/.test(value)).optional().default("")
}).strict();

type Scope = { pairingId: string; userId: string; workspaceId: string; agentId: string };
type Dependencies = {
  getBrowserScope(token: string): Promise<Scope>;
  createExecution(
    scope: CurrentUser,
    input: { configVersion: number; mode: "real_codex"; sourceCount: number; inputHash: string }
  ): Promise<{ execution: { id: string }; agentToken?: string }>;
  enqueueTask(
    token: string,
    input: { requestId: string; executionId: string; prompt: string; phoneFilePath: string }
  ): Promise<Pick<DeviceTaskRecord, "id" | "status">>;
};

export function createPairedTaskHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    const browserToken = readPairedBrowserToken(request);
    if (!browserToken) {
      return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    }
    try {
      const input = TaskInputSchema.parse(await request.json());
      const paired = await dependencies.getBrowserScope(browserToken);
      const scope = { userId: paired.userId, workspaceId: paired.workspaceId };
      const inputHash = `sha256:${createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex")}`;
      const created = await dependencies.createExecution(scope, {
        configVersion: 1,
        mode: "real_codex",
        sourceCount: input.feishuUrls.length,
        inputHash
      });
      if (!created.agentToken) throw new Error("EXECUTION_TOKEN_MISSING");
      const executionId = created.execution.id;
      const task = await dependencies.enqueueTask(browserToken, {
        requestId: input.requestId,
        executionId,
        phoneFilePath: input.phoneFilePath,
        prompt: buildCodexPrompt({
          executionId,
          agentToken: created.agentToken,
          apiBaseUrl: new URL(request.url).origin,
          feishuUrls: input.feishuUrls,
          requirements: input.requirements,
          phoneFilePath: input.phoneFilePath,
          robotName: input.robotName
        }).replace(created.agentToken, ExecutionTokenPlaceholder)
      });
      return NextResponse.json(
        { executionId, taskId: task.id, status: task.status },
        { status: 201 }
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_REQUEST";
      const status = code === "UNAUTHENTICATED" ? 401 : code === "DEVICE_NOT_PAIRED" ? 409 : 400;
      return NextResponse.json({ code }, { status });
    }
  };
}

export const POST = createPairedTaskHandler({
  getBrowserScope: (token) => deviceService.getBrowserScope(token),
  createExecution: (scope, input) =>
    createExecutionService(scope).createExecution(scope, input),
  enqueueTask: (token, input) => deviceService.enqueueTask(token, input)
});
export const runtime = "nodejs";
