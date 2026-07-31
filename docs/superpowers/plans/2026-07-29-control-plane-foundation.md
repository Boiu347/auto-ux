# Control Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working vertical slice: a multi-user-ready web control plane that creates an execution, persists its state, displays the approved hybrid progress UI, receives local-agent events, enforces confirmation/idempotency rules, and completes an end-to-end run with a simulator.

**Architecture:** Use a pnpm TypeScript monorepo with a Next.js web app, shared Zod contracts, an isolated execution state-machine package, PostgreSQL persistence through Prisma, and a local agent simulator. The simulator proves the website and an eventual Codex plugin can share one durable task state without implementing Feishu or Baidu automation in this phase.

**Tech Stack:** Node.js 24, pnpm 11, TypeScript 7, Next.js 16, React 19, Zod, Prisma 7, PostgreSQL 16, Vitest, Testing Library, Playwright, Server-Sent Events.

## Global Constraints

- Every execution belongs to one `userId` and `workspaceId`.
- Existing Baidu robots are never modified; later adapters must use `targetPolicy: "create_only"`.
- Full phone numbers, Feishu source text, browser sessions, and raw uploaded files are never persisted by this control plane.
- Progress is derived from persisted execution steps, never from a timer or decorative animation.
- `publish`, `import_numbers`, and `start_dial` each require separate single-use confirmations.
- An already-running or succeeded action fingerprint cannot execute again.
- Unknown outcomes remain `unknown`; the system never converts them to success by inference.
- This phase uses a simulator only; real Feishu, Codex plugin, Baidu browser control, and phone dialing are separate follow-up plans.

---

## Planned Repository Structure

```text
apps/
  web/                         Next.js control plane and API
  agent-simulator/             Local CLI that claims and advances a test execution
packages/
  contracts/                   Zod schemas and shared TypeScript types
  execution-core/              Pure transition, idempotency, and confirmation logic
  db/                          Prisma schema and repository implementation
tests/e2e/                     Browser-level vertical slice
docker-compose.yml             Local PostgreSQL
pnpm-workspace.yaml            Workspace boundaries
```

## Follow-up Plans

1. Feishu OAuth, source ingestion, local-file references, and configuration-draft generation.
2. Codex plugin package, Skill, MCP task client, capability handshake, and deep-link handoff.
3. Baidu robot adapter with target, encoding, navigation, tab-binding, voice, and publish guards.
4. Local phone parsing, single-use dial confirmation, dial submission, and call-record verification.
5. Twenty-run regression suite, deployment, observability, and GitHub release workflow.

### Task 1: Monorepo and Web Health Slice

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `apps/web/package.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/api/health/route.ts`
- Create: `apps/web/src/app/api/health/route.test.ts`
- Create: `apps/web/vitest.config.ts`

**Interfaces:**
- Produces: `GET /api/health -> { status: "ok" }`
- Produces: workspace scripts `dev`, `build`, `test`, `typecheck`, and `lint`

- [ ] **Step 1: Write the failing health-route test**

```ts
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns an ok status", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Install workspace dependencies and verify the test fails**

Run: `pnpm install && pnpm --filter @app/web test -- src/app/api/health/route.test.ts`

Expected: FAIL because `route.ts` does not exist.

- [ ] **Step 3: Implement the minimal health route and dashboard shell**

```ts
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
```

The home page must render the product name, an empty execution list, and a disabled “在 Codex 中开始执行” button with explanatory copy.

- [ ] **Step 4: Run the web checks**

Run: `pnpm --filter @app/web test && pnpm --filter @app/web typecheck && pnpm --filter @app/web build`

Expected: all commands exit 0 and the health test passes.

- [ ] **Step 5: Commit the slice**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json docker-compose.yml .env.example apps/web
git commit -m "chore: scaffold control plane workspace"
```

### Task 2: Shared Execution Contracts

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/execution.ts`
- Create: `packages/contracts/src/execution.test.ts`

**Interfaces:**
- Produces: `ExecutionStatusSchema`
- Produces: `ExecutionPhaseSchema`
- Produces: `ExecutionPacketSchema`
- Produces: `ExecutionEventSchema`
- Produces: `ConfirmationActionSchema`
- Produces: corresponding inferred TypeScript types

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import { ExecutionEventSchema, ExecutionPacketSchema } from "./execution";

describe("execution contracts", () => {
  it("rejects an execution packet that can modify existing robots", () => {
    const result = ExecutionPacketSchema.safeParse({
      executionId: "EX-1",
      userId: "U-1",
      workspaceId: "W-1",
      configVersion: 1,
      currentStep: "robot.create",
      targetPolicy: "modify_existing",
      approvedActions: ["configure"],
      blockedActions: ["publish", "import_numbers", "start_dial"]
    });
    expect(result.success).toBe(false);
  });

  it("accepts an unknown outcome with evidence", () => {
    expect(ExecutionEventSchema.parse({
      executionId: "EX-1",
      stepId: "dial.verify",
      attempt: 1,
      status: "unknown",
      occurredAt: "2026-07-29T10:00:00.000Z",
      inputHash: "sha256:abc",
      evidence: { kind: "platform_record", summary: "record unavailable" },
      errorCode: "CALL_RECORD_UNAVAILABLE",
      nextAction: "wait_for_user"
    }).status).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run: `pnpm --filter @app/contracts test`

Expected: FAIL because the schemas are not exported.

- [ ] **Step 3: Implement exact enums and schemas**

```ts
export const ExecutionStatusSchema = z.enum([
  "pending", "running", "waiting_confirmation", "succeeded",
  "failed", "rolled_back", "unknown"
]);

export const ExecutionPhaseSchema = z.enum([
  "source_parse", "draft_confirm", "environment_preflight", "robot_create",
  "field_configure", "voice_preflight", "publish_confirm", "publish_verify",
  "numbers_confirm", "dial_confirm", "call_verify", "complete"
]);

export const ConfirmationActionSchema = z.enum([
  "publish", "import_numbers", "start_dial"
]);
```

`ExecutionPacketSchema` must require `targetPolicy: z.literal("create_only")`. `ExecutionEventSchema` must require non-empty `inputHash`, `evidence.summary`, and `nextAction`.

- [ ] **Step 4: Run contract checks**

Run: `pnpm --filter @app/contracts test && pnpm --filter @app/contracts typecheck`

Expected: PASS.

- [ ] **Step 5: Commit contracts**

```bash
git add packages/contracts
git commit -m "feat: define execution contracts"
```

### Task 3: Durable PostgreSQL Execution Repository

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/prisma/schema.prisma`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/execution-repository.ts`
- Create: `packages/db/src/execution-repository.test.ts`

**Interfaces:**
- Consumes: `ExecutionStatus` and `ExecutionPhase` from `@app/contracts`
- Produces: `ExecutionRepository.create(input)`
- Produces: `ExecutionRepository.findByIdForUser(executionId, userId, workspaceId)`
- Produces: `ExecutionRepository.appendStepEvent(event)`
- Produces: `ExecutionRepository.listStepEvents(executionId)`
- Produces: `ExecutionRepository.acquireLock(executionId, agentId, ttlSeconds)`

- [ ] **Step 1: Write the failing repository isolation test**

```ts
it("does not return an execution to a different user", async () => {
  const execution = await repository.create({
    userId: "U-1", workspaceId: "W-1", configVersion: 1
  });
  await expect(
    repository.findByIdForUser(execution.id, "U-2", "W-1")
  ).resolves.toBeNull();
});
```

Add tests that an `(executionId, stepId, attempt)` event is unique and only one unexpired agent lock can exist.

- [ ] **Step 2: Start PostgreSQL and verify the test fails**

Run: `docker compose up -d postgres && pnpm --filter @app/db prisma:migrate && pnpm --filter @app/db test`

Expected: FAIL because repository methods do not exist.

- [ ] **Step 3: Implement the schema and repository**

The Prisma schema must define `User`, `Workspace`, `LocalAgent`, `ConfigDraft`, `Execution`, `ExecutionStep`, `Confirmation`, `RobotBinding`, and `AuditEvent`. `ExecutionStep` must have `@@unique([executionId, stepId, attempt])`. Store evidence as JSON and never add raw source text or full phone fields.

```ts
export interface ExecutionRepository {
  create(input: { userId: string; workspaceId: string; configVersion: number }): Promise<ExecutionRecord>;
  findByIdForUser(executionId: string, userId: string, workspaceId: string): Promise<ExecutionRecord | null>;
  appendStepEvent(event: ExecutionEvent): Promise<void>;
  listStepEvents(executionId: string): Promise<ExecutionEvent[]>;
  acquireLock(executionId: string, agentId: string, ttlSeconds: number): Promise<boolean>;
}
```

- [ ] **Step 4: Run migration and repository checks**

Run: `pnpm --filter @app/db prisma:migrate && pnpm --filter @app/db test && pnpm --filter @app/db typecheck`

Expected: PASS.

- [ ] **Step 5: Commit persistence**

```bash
git add packages/db docker-compose.yml
git commit -m "feat: persist execution state"
```

### Task 4: Execution State Machine, Retry Budget, and Confirmations

**Files:**
- Create: `packages/execution-core/package.json`
- Create: `packages/execution-core/tsconfig.json`
- Create: `packages/execution-core/src/index.ts`
- Create: `packages/execution-core/src/state-machine.ts`
- Create: `packages/execution-core/src/action-journal.ts`
- Create: `packages/execution-core/src/confirmation.ts`
- Create: `packages/execution-core/src/state-machine.test.ts`
- Create: `packages/execution-core/src/confirmation.test.ts`

**Interfaces:**
- Produces: `transition(current, event): ExecutionStatus`
- Produces: `createActionFingerprint(executionId, stepId, inputHash): string`
- Produces: `canAttempt(previousAttempts): { allowed: boolean; reason?: "retry_budget_exhausted" }`
- Produces: `issueConfirmation(action, executionId, configVersion, expiresAt)`
- Produces: `consumeConfirmation(token, action, executionId, configVersion)`

- [ ] **Step 1: Write failing transition and token tests**

```ts
it("does not allow publish verification before publish confirmation", () => {
  expect(() => transition("pending", {
    phase: "publish_verify", status: "running"
  })).toThrowError("publish confirmation required");
});

it("consumes a start_dial token only once", () => {
  const token = issueConfirmation("start_dial", "EX-1", 4, futureDate);
  expect(consumeConfirmation(token, "start_dial", "EX-1", 4)).toEqual({ ok: true });
  expect(consumeConfirmation(token, "start_dial", "EX-1", 4)).toEqual({ ok: false, reason: "already_consumed" });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @app/execution-core test`

Expected: FAIL because implementations do not exist.

- [ ] **Step 3: Implement the pure domain logic**

Allow only documented phase order. Recovered high-risk phases return `waiting_confirmation`. `canAttempt` allows attempts 1 and 2 and rejects attempt 3. Hash action fingerprints with SHA-256. Confirmation tokens must bind action, execution, config version, expiry, and consumed timestamp.

- [ ] **Step 4: Run domain checks**

Run: `pnpm --filter @app/execution-core test && pnpm --filter @app/execution-core typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the domain layer**

```bash
git add packages/execution-core
git commit -m "feat: enforce execution state rules"
```

### Task 5: Execution API and SSE Progress Stream

**Files:**
- Create: `apps/web/src/server/auth/current-user.ts`
- Create: `apps/web/src/server/executions/service.ts`
- Create: `apps/web/src/app/api/executions/route.ts`
- Create: `apps/web/src/app/api/executions/[executionId]/route.ts`
- Create: `apps/web/src/app/api/executions/[executionId]/events/route.ts`
- Create: `apps/web/src/app/api/executions/[executionId]/confirmations/route.ts`
- Create: `apps/web/src/app/api/executions/executions-api.test.ts`

**Interfaces:**
- Consumes: repository and execution-core interfaces
- Produces: `POST /api/executions`
- Produces: `GET /api/executions/:id`
- Produces: `POST /api/executions/:id/events`
- Produces: `GET /api/executions/:id/events` as `text/event-stream`
- Produces: `POST /api/executions/:id/confirmations`

- [ ] **Step 1: Write failing API tests**

```ts
it("rejects an event from an agent not holding the lock", async () => {
  const response = await postEvent({
    executionId, agentId: "agent-other", event: runningEvent
  });
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ code: "EXECUTION_LOCK_MISMATCH" });
});

it("returns SSE events in persisted order", async () => {
  await appendEvents([firstEvent, secondEvent]);
  const payloads = await readFirstSseMessages(executionId, 2);
  expect(payloads.map((event) => event.stepId)).toEqual([firstEvent.stepId, secondEvent.stepId]);
});
```

- [ ] **Step 2: Run API tests and verify failure**

Run: `pnpm --filter @app/web test -- executions-api.test.ts`

Expected: FAIL because routes and service are missing.

- [ ] **Step 3: Implement authenticated APIs**

Use a development-only header adapter returning `{ userId, workspaceId }`; keep it behind `current-user.ts` so Feishu OAuth replaces it in the next plan. Validate every body with shared Zod schemas. SSE must send persisted events first, then heartbeat comments every 15 seconds.

- [ ] **Step 4: Run API checks**

Run: `pnpm --filter @app/web test -- executions-api.test.ts && pnpm --filter @app/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit APIs**

```bash
git add apps/web/src/app/api apps/web/src/server
git commit -m "feat: expose execution progress api"
```

### Task 6: Approved Hybrid Progress Dashboard

**Files:**
- Create: `apps/web/src/components/executions/execution-list.tsx`
- Create: `apps/web/src/components/executions/hybrid-progress.tsx`
- Create: `apps/web/src/components/executions/current-action-card.tsx`
- Create: `apps/web/src/components/executions/evidence-card.tsx`
- Create: `apps/web/src/components/executions/confirmation-panel.tsx`
- Create: `apps/web/src/components/executions/hybrid-progress.test.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/executions/[executionId]/page.tsx`
- Create: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `ExecutionEvent[]`, execution summary, and confirmation API
- Produces: `<HybridProgress executionId initialEvents />`

- [ ] **Step 1: Write failing UI tests**

```tsx
it("shows facts for the running step and does not invent progress", () => {
  render(<HybridProgress execution={execution} events={[runningEvent]} />);
  expect(screen.getByText("正在执行")).toBeInTheDocument();
  expect(screen.getByText(runningEvent.evidence.summary)).toBeInTheDocument();
  expect(screen.queryByText("已接通")).not.toBeInTheDocument();
});

it("shows a confirmation button only for waiting_confirmation", () => {
  render(<HybridProgress execution={waitingPublishExecution} events={events} />);
  expect(screen.getByRole("button", { name: "确认发布" })).toBeEnabled();
});
```

- [ ] **Step 2: Run UI tests and verify failure**

Run: `pnpm --filter @app/web test -- hybrid-progress.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the selected A layout**

Render a left phase rail and right current-action panel. Show current target, config version, agent heartbeat, evidence, last checkpoint, error facts, and next confirmation. Use SSE to append events; reconnect with the last event ID. Confirmation buttons must display action-specific copy and never combine multiple approvals.

- [ ] **Step 4: Run UI and accessibility checks**

Run: `pnpm --filter @app/web test -- hybrid-progress.test.tsx && pnpm --filter @app/web typecheck && pnpm --filter @app/web build`

Expected: PASS with no inaccessible confirmation buttons.

- [ ] **Step 5: Commit the dashboard**

```bash
git add apps/web/src/app apps/web/src/components
git commit -m "feat: add hybrid execution progress dashboard"
```

### Task 7: Local Agent Simulator and Capability Handshake

**Files:**
- Create: `apps/agent-simulator/package.json`
- Create: `apps/agent-simulator/tsconfig.json`
- Create: `apps/agent-simulator/src/client.ts`
- Create: `apps/agent-simulator/src/run-simulation.ts`
- Create: `apps/agent-simulator/src/run-simulation.test.ts`

**Interfaces:**
- Produces: `claimExecution(executionId, agentManifest)`
- Produces: `postStepEvent(event)`
- Produces: CLI `pnpm agent:simulate --execution EX-1`

- [ ] **Step 1: Write the failing simulator test**

```ts
it("uses one plugin session and stops at publish confirmation", async () => {
  const result = await runSimulation({ executionId: "EX-1", api: fakeApi });
  expect(result.pluginSessionCount).toBe(1);
  expect(result.finalStatus).toBe("waiting_confirmation");
  expect(fakeApi.events.at(-1)?.stepId).toBe("publish.confirm");
});
```

- [ ] **Step 2: Run simulator tests and verify failure**

Run: `pnpm --filter @app/agent-simulator test`

Expected: FAIL because the simulator is missing.

- [ ] **Step 3: Implement the simulator**

Send a manifest containing plugin version, supported contract version, Feishu CLI capability, and browser capability. Claim one execution lock, emit deterministic evidence for low-risk steps, stop at publish confirmation, consume the returned confirmation, continue through a simulated call record, and never create a second session.

- [ ] **Step 4: Run simulator checks**

Run: `pnpm --filter @app/agent-simulator test && pnpm --filter @app/agent-simulator typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the simulator**

```bash
git add apps/agent-simulator
git commit -m "feat: simulate local codex execution"
```

### Task 8: End-to-End Vertical Slice and Developer Handoff

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/execution-progress.spec.ts`
- Create: `scripts/dev-up.sh`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: web API, PostgreSQL, and agent simulator
- Produces: `pnpm e2e`
- Produces: `pnpm dev:up`

- [ ] **Step 1: Write the failing browser test**

```ts
test("execution survives refresh and stops at independent confirmations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "创建演示任务" }).click();
  await page.getByRole("link", { name: /查看任务/ }).click();
  await expect(page.getByText("环境预检")).toBeVisible();
  await page.reload();
  await expect(page.getByText("环境预检")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认发布" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始拨打" })).not.toBeVisible();
});
```

- [ ] **Step 2: Run the E2E test and verify failure**

Run: `pnpm e2e`

Expected: FAIL because the orchestration script and demo action are missing.

- [ ] **Step 3: Add deterministic developer orchestration**

`scripts/dev-up.sh` must start PostgreSQL, apply migrations, start the web app, create a demo execution, and launch the simulator. `README.md` must document prerequisites, environment variables, start/stop commands, test commands, architecture boundaries, and explicitly state that this phase performs no real Feishu or Baidu actions.

- [ ] **Step 4: Run the complete verification suite**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e && pnpm build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the verified vertical slice**

```bash
git add playwright.config.ts tests scripts README.md package.json
git commit -m "test: verify control plane vertical slice"
```
