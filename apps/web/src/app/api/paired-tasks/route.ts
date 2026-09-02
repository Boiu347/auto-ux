import { createHash, randomBytes } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { buildCodexPrompt } from "../../../components/executions/build-codex-prompt";
import { publicOrigin } from "../../../lib/public-path";
import type { CurrentUser } from "../../../server/auth/current-user";
import { getRequestUser } from "../../../server/auth/request-user";
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
const PairedTaskErrorStatuses: Record<string, number> = {
  AUTO_UX_PUBLIC_BASE_URL_INVALID: 500,
  DEVICE_NOT_PAIRED: 409,
  EXECUTION_TOKEN_MISSING: 500,
  INTERNAL_ERROR: 500,
  INVALID_REQUEST: 400,
  INVALID_TASK: 400,
  UNAUTHENTICATED: 401
};

function safeCauseCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" && /^[A-Z0-9_-]{2,80}$/.test(code) ? code : null;
}

type Dependencies = {
  getRequestUser(request: Request): Promise<CurrentUser | null>;
  getBrowserScope(token: string, expectedScope: CurrentUser): Promise<Scope>;
  createExecution(
    scope: CurrentUser,
    input: { configVersion: number; mode: "real_codex"; sourceCount: number; inputHash: string }
  ): Promise<{ execution: { id: string }; agentToken?: string }>;
  enqueueTask(
    token: string,
    input: {
      requestId: string;
      executionId: string;
      prompt: string;
      phoneFilePath: string;
      feishuUrls: string[];
      requirements: string;
      robotName: string;
    }
  ): Promise<Pick<DeviceTaskRecord, "id" | "status">>;
};

export function resolvePublicApiBaseUrl(requestUrl: string): string {
  const configured = process.env.AUTO_UX_PUBLIC_BASE_URL?.trim();
  const value = configured || publicOrigin(new URL(requestUrl).origin);
  const normalized = value.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("AUTO_UX_PUBLIC_BASE_URL_INVALID");
  }
  const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim();
  const expectedBasePath = configuredBasePath
    ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
    : "";
  const actualPath = url.pathname.replace(/\/+$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ["0.0.0.0", "::", "[::]"].includes(url.hostname) ||
    (expectedBasePath && !actualPath.endsWith(expectedBasePath))
  ) {
    throw new Error("AUTO_UX_PUBLIC_BASE_URL_INVALID");
  }
  return normalized;
}

export function createPairedTaskHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    const browserToken = readPairedBrowserToken(request);
    let requestId: string | null = null;
    let executionId: string | null = null;
    try {
      if (!browserToken) throw new Error("UNAUTHENTICATED");
      const currentUser = await dependencies.getRequestUser(request);
      if (!currentUser) throw new Error("UNAUTHENTICATED");
      const input = TaskInputSchema.parse(await request.json());
      requestId = input.requestId;
      const apiBaseUrl = resolvePublicApiBaseUrl(request.url);
      const paired = await dependencies.getBrowserScope(browserToken, currentUser);
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
      executionId = created.execution.id;
      const task = await dependencies.enqueueTask(browserToken, {
        requestId: input.requestId,
        executionId,
        feishuUrls: input.feishuUrls,
        requirements: input.requirements,
        phoneFilePath: input.phoneFilePath,
        robotName: input.robotName,
        prompt: buildCodexPrompt({
          executionId,
          agentToken: created.agentToken,
          apiBaseUrl,
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
      const diagnosticId = `diag_${randomBytes(16).toString("hex")}`;
      const rawCode = error instanceof Error ? error.message : "INVALID_REQUEST";
      const code = error instanceof z.ZodError || error instanceof SyntaxError
        ? "INVALID_REQUEST"
        : Object.hasOwn(PairedTaskErrorStatuses, rawCode)
          ? rawCode
          : "INTERNAL_ERROR";
      const status = PairedTaskErrorStatuses[code] ?? 500;
      console.error("paired_task_failed", {
        causeCode: safeCauseCode(error),
        code,
        diagnosticId,
        errorName: error instanceof Error ? error.name : typeof error,
        executionId,
        requestId
      });
      return NextResponse.json({ code, diagnosticId }, { status });
    }
  };
}

export const POST = createPairedTaskHandler({
  getRequestUser,
  getBrowserScope: (token, expectedScope) =>
    deviceService.getBrowserScope(token, expectedScope),
  createExecution: (scope, input) =>
    createExecutionService(scope).createExecution(scope, input),
  enqueueTask: (token, input) => deviceService.enqueueTask(token, input)
});
export const runtime = "nodejs";
