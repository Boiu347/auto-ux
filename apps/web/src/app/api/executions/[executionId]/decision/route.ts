import { prisma } from "@app/db";
import { NextResponse } from "next/server";
import { z } from "zod";

import type { CurrentUser } from "../../../../../server/auth/current-user";
import { getRequestUser } from "../../../../../server/auth/request-user";
import { createExecutionAgentAuthenticator } from "../../../../../server/executions/agent-auth";

const ActionSchema = z.enum(["publish", "import_numbers", "start_dial"]);
const DecisionSchema = z.enum(["approved", "rejected"]);
const InputSchema = z.object({ action: ActionSchema, decision: DecisionSchema }).strict();
type Action = z.infer<typeof ActionSchema>;
type Decision = z.infer<typeof DecisionSchema>;
type Source = "website" | "codex";
type Scope = CurrentUser;
type StoredDecision = { action: Action; decision: Decision; source: Source; decidedAt?: Date };
type Context = { params: Promise<{ executionId: string }> };

type Dependencies = {
  authenticateBrowser(request: Request): Promise<Scope | null> | Scope | null;
  authenticateAgent(request: Request, executionId: string): Promise<Scope | null>;
  decide(input: Scope & { executionId: string; action: Action; decision: Decision; source: Source }): Promise<StoredDecision>;
  get(input: Scope & { executionId: string; action: Action }): Promise<StoredDecision | null>;
};

export function createDecisionHandlers(dependencies: Dependencies) {
  const authenticate = async (request: Request, executionId: string) => {
    const agent = request.headers.has("authorization");
    const scope = agent
      ? await dependencies.authenticateAgent(request, executionId)
      : await dependencies.authenticateBrowser(request);
    return { scope, source: (agent ? "codex" : "website") as Source };
  };
  return {
    async GET(request: Request, context: Context): Promise<Response> {
      const { executionId } = await context.params;
      const { scope } = await authenticate(request, executionId);
      if (!scope) return jsonError("UNAUTHENTICATED", 401);
      const parsed = ActionSchema.safeParse(new URL(request.url).searchParams.get("action"));
      if (!parsed.success) return jsonError("INVALID_REQUEST", 400);
      const result = await dependencies.get({ ...scope, executionId, action: parsed.data });
      return result ? NextResponse.json(result) : new Response(null, { status: 204 });
    },
    async POST(request: Request, context: Context): Promise<Response> {
      const { executionId } = await context.params;
      const { scope, source } = await authenticate(request, executionId);
      if (!scope) return jsonError("UNAUTHENTICATED", 401);
      const parsed = InputSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return jsonError("INVALID_REQUEST", 400);
      try {
        return NextResponse.json(await dependencies.decide({
          ...scope, executionId, ...parsed.data, source
        }));
      } catch (error) {
        const code = error instanceof Error ? error.message : "DECISION_FAILED";
        return jsonError(code, code === "EXECUTION_NOT_FOUND" ? 404 : 409);
      }
    }
  };
}

const phaseByAction: Record<Action, string> = {
  publish: "publish_confirm",
  import_numbers: "numbers_confirm",
  start_dial: "dial_confirm"
};

const repository = {
  async decide(input: Scope & { executionId: string; action: Action; decision: Decision; source: Source }) {
    const execution = await prisma.execution.findFirst({
      where: { id: input.executionId, userId: input.userId, workspaceId: input.workspaceId }
    });
    if (!execution) throw new Error("EXECUTION_NOT_FOUND");
    if (execution.status !== "waiting_confirmation" || execution.phase !== phaseByAction[input.action]) {
      throw new Error("CONFIRMATION_GATE_CLOSED");
    }
    try {
      return await prisma.$transaction(async (transaction) => {
        const decision = await transaction.confirmationDecision.create({ data: {
          executionId: input.executionId,
          action: input.action,
          decision: input.decision,
          source: input.source,
          decidedAt: new Date()
        }});
        if (input.decision === "rejected") {
          await transaction.execution.updateMany({
            where: {
              id: input.executionId,
              status: "waiting_confirmation",
              phase: phaseByAction[input.action] as never
            },
            data: { status: "failed" }
          });
        }
        return decision;
      });
    } catch {
      const existing = await prisma.confirmationDecision.findUnique({
        where: { executionId_action: { executionId: input.executionId, action: input.action } }
      });
      if (!existing) throw new Error("DECISION_FAILED");
      return existing;
    }
  },
  async get(input: Scope & { executionId: string; action: Action }) {
    const execution = await prisma.execution.findFirst({
      where: { id: input.executionId, userId: input.userId, workspaceId: input.workspaceId },
      select: { id: true }
    });
    if (!execution) return null;
    return prisma.confirmationDecision.findUnique({
      where: { executionId_action: { executionId: input.executionId, action: input.action } }
    });
  }
};

const agentAuthenticator = createExecutionAgentAuthenticator();
const handlers = createDecisionHandlers({
  authenticateBrowser: getRequestUser,
  authenticateAgent: (request, executionId) => agentAuthenticator.authenticate(request, executionId),
  decide: (input) => repository.decide(input),
  get: (input) => repository.get(input)
});

function jsonError(code: string, status: number): Response {
  return NextResponse.json({ code }, { status });
}

export const GET = handlers.GET;
export const POST = handlers.POST;
export const runtime = "nodejs";
