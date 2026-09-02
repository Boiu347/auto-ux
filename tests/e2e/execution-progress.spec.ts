import { expect, test } from "@playwright/test";

test("execution survives refresh and stops at independent confirmations", async ({
  page
}) => {
  await page.addInitScript(() => {
    const listeners = new Set<() => void>();
    const binding = () => {
      const executionId = decodeURIComponent(
        window.location.pathname.split("/").at(-1) ?? ""
      );
      return {
        connected: executionId.startsWith("execution_"),
        agentId: "agent-simulator",
        sessionId: `session-${executionId}`,
        executionId
      };
    };
    const postEvent = async (
      executionId: string,
      event: Record<string, unknown>,
      confirmation?: Record<string, unknown>
    ) => {
      const response = await fetch(
        `/api/executions/${encodeURIComponent(executionId)}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: "agent-simulator",
            sessionId: `session-${executionId}`,
            event,
            ...(confirmation ? { confirmation } : {})
          })
        }
      );
      if (!response.ok) {
        throw new Error(`event rejected: ${response.status}`);
      }
    };
    const checkpoint = (
      executionId: string,
      stepId: string,
      phase: string,
      status: string,
      attempt: number
    ) => ({
      executionId,
      stepId,
      attempt,
      status,
      occurredAt: new Date(Date.UTC(2026, 6, 30, 0, 1, attempt)).toISOString(),
      inputHash: `sha256:e2e${attempt.toString().padStart(13, "0")}`,
      evidence: {
        kind: "checkpoint",
        summary: { phase, status },
        reference: {
          kind: "checkpoint",
          id: `checkpoint:${attempt.toString(16).padStart(16, "0")}`
        }
      },
      nextAction: status === "waiting_confirmation" ? "wait_for_user" : "stop"
    });

    window.baiduOneClickLocalAgentBridge = {
      getConnection: binding,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async deliverConfirmation(grant) {
        const confirmation = {
          confirmationId: grant.confirmationId,
          token: grant.token,
          action: grant.action,
          configVersion: grant.configVersion
        };
        if (grant.action === "publish") {
          await postEvent(
            grant.executionId,
            checkpoint(
              grant.executionId,
              "publish.confirm",
              "publish_confirm",
              "succeeded",
              8
            ),
            confirmation
          );
          await postEvent(grant.executionId, {
            executionId: grant.executionId,
            stepId: "publish.verify",
            attempt: 9,
            status: "succeeded",
            occurredAt: "2026-07-30T00:01:09.000Z",
            inputHash: "sha256:e2e00000000009",
            evidence: {
              kind: "field_readback",
              summary: { field: "publish_state", result: "matched" },
              reference: {
                kind: "field_readback",
                id: "field_readback:0000000000000009"
              }
            },
            nextAction: "stop"
          });
          await postEvent(grant.executionId, {
            executionId: grant.executionId,
            stepId: "numbers.confirm",
            attempt: 10,
            status: "waiting_confirmation",
            occurredAt: "2026-07-30T00:01:10.000Z",
            inputHash: "sha256:e2e00000000010",
            evidence: {
              kind: "phone_batch",
              summary: {
                total: 2,
                valid: 2,
                invalid: 0,
                duplicates: 0,
                maskedSamples: ["138****0001", "139****0002"]
              },
              reference: {
                kind: "phone_batch",
                id: "phone_batch:000000000000000a"
              }
            },
            nextAction: "wait_for_user"
          });
        } else if (grant.action === "import_numbers") {
          await postEvent(
            grant.executionId,
            checkpoint(
              grant.executionId,
              "numbers.confirm",
              "numbers_confirm",
              "succeeded",
              11
            ),
            confirmation
          );
          await postEvent(
            grant.executionId,
            checkpoint(
              grant.executionId,
              "dial.confirm",
              "dial_confirm",
              "waiting_confirmation",
              12
            )
          );
        } else {
          await postEvent(
            grant.executionId,
            checkpoint(
              grant.executionId,
              "dial.confirm",
              "dial_confirm",
              "succeeded",
              13
            ),
            confirmation
          );
          await postEvent(grant.executionId, {
            executionId: grant.executionId,
            stepId: "dial.verify",
            attempt: 14,
            status: "succeeded",
            occurredAt: "2026-07-30T00:01:14.000Z",
            inputHash: "sha256:e2e00000000014",
            evidence: {
              kind: "platform_record",
              summary: { outcome: "recorded" },
              reference: {
                kind: "platform_record",
                id: "platform_record:000000000000000e"
              }
            },
            nextAction: "stop"
          });
          await postEvent(
            grant.executionId,
            checkpoint(
              grant.executionId,
              "complete",
              "complete",
              "succeeded",
              15
            )
          );
        }
        return { acknowledged: true as const };
      }
    };
  });
  await page.goto("/");
  const executionId = await page.evaluate(async () => {
    const session = await fetch("/api/dev/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "U-1", workspaceId: "W-1" })
    });
    if (!session.ok) throw new Error(`session rejected: ${session.status}`);
    const response = await fetch("/api/dev/demo", { method: "POST" });
    const payload = (await response.json()) as {
      execution?: { id?: unknown };
    };
    if (!response.ok || typeof payload.execution?.id !== "string") {
      throw new Error(`demo rejected: ${response.status}`);
    }
    return payload.execution.id;
  });
  expect(executionId).toMatch(/^execution_/);
  await page.goto(`/executions/${encodeURIComponent(executionId)}`);

  await expect(page.getByText("环境预检")).toBeVisible();
  await page.reload();
  await expect(page.getByText("环境预检")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认发布" })).toBeVisible();
  await expectDialogInsideViewport(page);
  await page.screenshot({
    path: "/private/tmp/auto-ux-progress-dialog-desktop.png",
    fullPage: false
  });
  await expect(
    page.getByRole("button", { name: "确认导入号码" })
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认开始外呼" })
  ).not.toBeVisible();

  await page.getByRole("button", { name: "确认发布" }).click();
  await expect(
    page.getByRole("button", { name: "确认导入号码" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认开始外呼" })
  ).not.toBeVisible();

  await page.getByRole("button", { name: "确认导入号码" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "确认开始外呼" })
  ).toBeVisible();
  await expectDialogInsideViewport(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "/private/tmp/auto-ux-progress-dialog-mobile.png",
    fullPage: false
  });
  await expect(page.getByRole("button", { name: "确认发布" })).not.toBeVisible();

  await page.getByRole("button", { name: "确认开始外呼" }).click();
  await expect(
    page.getByRole("button", { name: "确认开始外呼" })
  ).not.toBeVisible();

  await expect
    .poll(async () => readDurableSummary(page, executionId))
    .toEqual({ phase: "complete", status: "succeeded", lastStep: "complete" });

  await page.reload();
  await expect(
    page.locator(".current-action-card dd").filter({ hasText: /^complete$/ })
  ).toHaveCount(2);
  await expect(
    page.locator(".current-action-card").getByText("已完成", { exact: true })
  ).toBeVisible();
  await expect(readDurableSummary(page, executionId)).resolves.toEqual({
    phase: "complete",
    status: "succeeded",
    lastStep: "complete"
  });
});

async function expectDialogInsideViewport(
  page: import("@playwright/test").Page
) {
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

async function readDurableSummary(
  page: import("@playwright/test").Page,
  executionId: string
) {
  return page.evaluate(async (id) => {
    const response = await fetch(
      `/api/executions/${encodeURIComponent(id)}`,
      { headers: { accept: "application/json" } }
    );
    if (!response.ok) {
      throw new Error(`summary rejected: ${response.status}`);
    }
    const payload = (await response.json()) as {
      execution: { phase: string; status: string };
      events: Array<{ event: { stepId: string } }>;
    };
    return {
      phase: payload.execution.phase,
      status: payload.execution.status,
      lastStep: payload.events.at(-1)?.event.stepId
    };
  }, executionId);
}
