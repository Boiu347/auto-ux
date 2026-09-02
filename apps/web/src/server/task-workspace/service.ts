import { prisma } from "@app/db";
import { z } from "zod";

import type { CurrentUser } from "../auth/current-user";

const SafeTextSchema = z.string().refine((value) => !/[\r\n\0]/.test(value));

export const TaskFormDraftSchema = z
  .object({
    feishuUrls: z
      .array(
        z
          .string()
          .url()
          .refine((value) => value.startsWith("https://"))
      )
      .max(8),
    requirements: z.string().max(16_000),
    phoneFilePath: z
      .string()
      .max(4_096)
      .refine((value) => value === "" || value.startsWith("/"))
      .refine((value) => !/[\r\n\0]/.test(value)),
    robotName: SafeTextSchema.max(256)
  })
  .strict();

export type TaskFormDraft = z.infer<typeof TaskFormDraftSchema>;

export type TaskHistoryItem = {
  id: string;
  robotName: string;
  createdAt: string;
  updatedAt: string;
  phase: string;
  status: string;
  input: TaskFormDraft | null;
};

export class TaskWorkspaceService {
  async getWorkspace(scope: CurrentUser): Promise<{
    draft: (TaskFormDraft & { updatedAt: string }) | null;
    executions: TaskHistoryItem[];
  }> {
    const [draft, executions] = await Promise.all([
      prisma.taskDraft.findUnique({
        where: {
          userId_workspaceId: {
            userId: scope.userId,
            workspaceId: scope.workspaceId
          }
        }
      }),
      prisma.execution.findMany({
        where: {
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          deviceTask: { isNot: null }
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          phase: true,
          status: true,
          deviceTask: {
            select: {
              feishuUrls: true,
              requirements: true,
              phoneFilePath: true,
              robotName: true
            }
          }
        }
      })
    ]);

    const parsedDraft = draft ? parseStoredInput(draft) : null;
    return {
      draft: parsedDraft
        ? { ...parsedDraft, updatedAt: draft!.updatedAt.toISOString() }
        : null,
      executions: executions.map((execution) => {
        const storedInput = execution.deviceTask
          ? parseStoredInput(execution.deviceTask)
          : null;
        const input = storedInput && hasReusableInput(storedInput)
          ? storedInput
          : null;
        return {
          id: execution.id,
          robotName: input?.robotName || "未命名机器人",
          createdAt: execution.createdAt.toISOString(),
          updatedAt: execution.updatedAt.toISOString(),
          phase: execution.phase,
          status: execution.status,
          input
        };
      })
    };
  }

  async saveDraft(
    scope: CurrentUser,
    input: TaskFormDraft
  ): Promise<TaskFormDraft & { updatedAt: string }> {
    const parsed = TaskFormDraftSchema.parse(input);
    const draft = await prisma.$transaction(async (transaction) => {
      await transaction.user.upsert({
        where: { id: scope.userId },
        create: { id: scope.userId },
        update: {}
      });
      await transaction.workspace.upsert({
        where: { id: scope.workspaceId },
        create: { id: scope.workspaceId },
        update: {}
      });
      await transaction.workspaceMember.upsert({
        where: {
          userId_workspaceId: {
            userId: scope.userId,
            workspaceId: scope.workspaceId
          }
        },
        create: scope,
        update: {}
      });
      return transaction.taskDraft.upsert({
        where: {
          userId_workspaceId: {
            userId: scope.userId,
            workspaceId: scope.workspaceId
          }
        },
        create: { ...scope, ...parsed },
        update: parsed
      });
    });
    return {
      ...parsed,
      updatedAt: draft.updatedAt.toISOString()
    };
  }

  async deleteDraft(scope: CurrentUser): Promise<void> {
    await prisma.taskDraft.deleteMany({ where: scope });
  }
}

function hasReusableInput(input: TaskFormDraft): boolean {
  return Boolean(
    input.feishuUrls.length ||
      input.requirements ||
      input.phoneFilePath ||
      input.robotName
  );
}

function parseStoredInput(value: {
  feishuUrls: unknown;
  requirements: string;
  phoneFilePath: string;
  robotName: string;
}): TaskFormDraft | null {
  const parsed = TaskFormDraftSchema.safeParse({
    feishuUrls: value.feishuUrls,
    requirements: value.requirements,
    phoneFilePath: value.phoneFilePath,
    robotName: value.robotName
  });
  return parsed.success ? parsed.data : null;
}

export const taskWorkspaceService = new TaskWorkspaceService();
