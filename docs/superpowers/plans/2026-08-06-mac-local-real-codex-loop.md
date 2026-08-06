# Mac Local Real Codex Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo-only launch path with a Mac-local task form that opens Codex, runs the existing Baidu configuration Skill, and streams redacted real execution progress back to the website.

**Architecture:** Keep the existing Next.js/PostgreSQL/SSE control plane. Add an execution mode and scoped bearer credential for a bound local Codex agent, a development-only macOS launcher, a real-task form, and a Python Skill reporter. Real high-risk confirmations remain inside Codex; the website observes their state and hides its simulator confirmation controls for real executions.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Zod 4, Prisma/PostgreSQL, Vitest, Playwright, Python 3 standard library, macOS `pbcopy`/`osascript`, `lark-cli`.

## Global Constraints

- First release supports macOS, the locally running website, local Codex, and the Codex Chrome extension only.
- Railway deployment, Windows, centralized device dispatch, and unattended background execution are out of scope.
- Feishu URLs are read only through `lark-cli`; Baidu is controlled only in an already signed-in Chrome tab on `ky.cloud.baidu.com`.
- Target policy remains exactly `create_only`; never modify, reuse, or delete an existing robot.
- Publish, real-number import, and real dialing require three separate confirmations inside Codex.
- The website must never persist Feishu body text, complete phone numbers, phone-file contents, browser sessions, or raw bearer tokens.
- Real execution events contain only contract-approved enums, hashes, counts, masked samples, opaque references, and controlled error codes.
- Dial submission happens at most once; unknown remains `unknown` and never triggers automatic redial.
- Existing simulator regression tests remain available and cannot trigger real external actions.
- All implementation follows TDD: add a failing focused test, observe the expected failure, implement the minimum change, rerun the focused test, then commit.

---

## File Structure

### New files

- `packages/db/prisma/migrations/20260806120000_add_real_codex_mode_and_token/migration.sql` — durable execution mode and hashed agent credential fields.
- `apps/web/src/server/executions/agent-auth.ts` — parse and resolve execution-scoped bearer credentials.
- `apps/web/src/server/executions/agent-auth.test.ts` — bearer authentication tests.
- `apps/web/src/server/local-launch/mac-codex-launcher.ts` — fixed-command macOS clipboard/open/paste adapter.
- `apps/web/src/server/local-launch/mac-codex-launcher.test.ts` — launcher security and fallback tests.
- `apps/web/src/app/api/local/launch/route.ts` — same-origin, development-only local launch API.
- `apps/web/src/app/api/local/launch/route.test.ts` — route guard tests.
- `apps/web/src/components/executions/real-execution-form.tsx` — real task form and launch flow.
- `apps/web/src/components/executions/real-execution-form.test.tsx` — form and failure-state tests.
- `apps/web/src/components/executions/build-codex-prompt.ts` — deterministic, length-bounded prompt builder.
- `apps/web/src/components/executions/build-codex-prompt.test.ts` — prompt privacy and content tests.
- `skills/baidu-cloud-one-click-config/scripts/report_progress.py` — standard-library API client with schema validation, redaction and bounded retry.
- `skills/baidu-cloud-one-click-config/references/progress-reporting.md` — reporter lifecycle and allowed payload contract.
- `skills/baidu-cloud-one-click-config/tests/test_report_progress.py` — reporter unit tests.

### Modified files

- `packages/contracts/src/execution.ts` and `execution.test.ts` — execution mode and local confirmation proof contracts.
- `packages/db/prisma/schema.prisma` — execution mode/token columns.
- `packages/db/src/execution-repository.ts` and `.test.ts` — create and resolve scoped credentials and persist execution mode.
- `apps/web/src/server/executions/service.ts` — real execution creation, local confirmation observation, and token resolution boundaries.
- `apps/web/src/app/api/executions/route.ts` and API tests — create real execution and return the one-time raw token only in the creation response.
- Agent claim, heartbeat, and event routes/tests — accept execution-scoped bearer auth for real mode while preserving dev simulator auth.
- `apps/web/src/components/home-dashboard.tsx`, `page.test.tsx`, and `globals.css` — expose the real form and states.
- `apps/web/src/components/executions/hybrid-progress.tsx`, `confirmation-panel.tsx`, and `hybrid-progress.test.tsx` — hide simulator confirmation controls for real mode and point the user back to Codex.
- `apps/agent-simulator/src/client.ts`, `run-simulation.ts`, and tests — explicitly create/use `simulator` mode.
- `skills/baidu-cloud-one-click-config/SKILL.md`, `agents/openai.yaml`, and existing Skill tests — invoke reporter at every phase without weakening local safety gates.
- `README.md` and `.env.example` — document local real mode, macOS permission fallback, and Railway limitation.

---

### Task 1: Execution Mode and Local Confirmation Contracts

**Files:**
- Modify: `packages/contracts/src/execution.ts`
- Modify: `packages/contracts/src/execution.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `ExecutionModeSchema`, `ExecutionMode`, `LocalConfirmationProofSchema`, and `LocalConfirmationProof`.
- `LocalConfirmationProof` is `{ source: "local_codex"; action: ConfirmationAction; confirmedAt: string; stateHash: string }`.

- [ ] **Step 1: Write failing contract tests**

Add tests that accept `simulator` and `real_codex`, reject unknown modes, accept a strict local confirmation proof, and reject extra fields, malformed hashes, and mismatched actions.

```ts
expect(ExecutionModeSchema.parse("real_codex")).toBe("real_codex");
expect(() => ExecutionModeSchema.parse("cloud_agent")).toThrow();

const proof = LocalConfirmationProofSchema.parse({
  source: "local_codex",
  action: "publish",
  confirmedAt: "2026-08-06T04:00:00.000Z",
  stateHash: `sha256:${"a".repeat(64)}`
});
expect(proof.action).toBe("publish");
```

- [ ] **Step 2: Run the focused tests and verify the expected export failure**

Run: `pnpm --filter @app/contracts test -- execution.test.ts`

Expected: FAIL because `ExecutionModeSchema` and `LocalConfirmationProofSchema` are not exported.

- [ ] **Step 3: Implement the strict schemas and types**

Add:

```ts
export const ExecutionModeSchema = z.enum(["simulator", "real_codex"]);

export const LocalConfirmationProofSchema = z.object({
  source: z.literal("local_codex"),
  action: ConfirmationActionSchema,
  confirmedAt: z.string().datetime(),
  stateHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();

export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type LocalConfirmationProof = z.infer<typeof LocalConfirmationProofSchema>;
```

- [ ] **Step 4: Run contract tests and typecheck**

Run: `pnpm --filter @app/contracts test && pnpm --filter @app/contracts typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/execution.ts packages/contracts/src/execution.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): define real codex execution mode"
```

---

### Task 2: Persist Real Mode and a Hashed Execution Credential

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260806120000_add_real_codex_mode_and_token/migration.sql`
- Modify: `packages/db/src/execution-repository.ts`
- Modify: `packages/db/src/execution-repository.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `ExecutionMode`.
- Changes `ExecutionRepository.create(input)` to consume `mode`, `agentAccessTokenHash`, and `agentAccessExpiresAt`.
- Produces: `findScopeByAgentTokenHash(tokenHash, executionId)` returning `{ userId; workspaceId; mode; tokenExpiresAt } | null`.
- Adds `mode` to `ExecutionRecord`.

- [ ] **Step 1: Write failing repository tests**

Cover all of the following:

```ts
const created = await repository.create({
  userId: "U-1",
  workspaceId: "W-1",
  configVersion: 1,
  mode: "real_codex",
  agentAccessTokenHash: "b".repeat(64),
  agentAccessExpiresAt: new Date("2026-08-06T05:00:00.000Z")
});
expect(created.mode).toBe("real_codex");

await expect(repository.findScopeByAgentTokenHash(
  "b".repeat(64),
  created.id
)).resolves.toMatchObject({ userId: "U-1", workspaceId: "W-1" });
```

Also prove a wrong hash, wrong execution ID, expired token, and cross-workspace lookup return `null`.

- [ ] **Step 2: Run the focused DB tests and verify schema/interface failures**

Run: `pnpm --filter @app/db test -- execution-repository.test.ts`

Expected: FAIL because the Prisma fields and repository method do not exist.

- [ ] **Step 3: Add Prisma enum, columns, and migration**

Add `ExecutionMode { simulator real_codex }` and these non-null/defaulted columns to `Execution`:

```prisma
mode                   ExecutionMode @default(simulator)
agentAccessTokenHash   String?
agentAccessExpiresAt   DateTime?
```

The migration adds the enum, columns, a unique partial index on non-null token hashes, and an expiry lookup index. Existing rows become `simulator`.

- [ ] **Step 4: Implement repository creation and credential lookup**

Validate the mode with `ExecutionModeSchema`. Token lookup must include both the hash and execution ID, require `agentAccessExpiresAt > CURRENT_TIMESTAMP`, and return only scope/mode/expiry—not the hash.

- [ ] **Step 5: Generate Prisma client, apply migration, and run tests**

Run:

```bash
pnpm --filter @app/db exec prisma generate --schema prisma/schema.prisma
DATABASE_URL="postgresql://control_plane:control_plane@127.0.0.1:5432/control_plane?schema=public" pnpm --filter @app/db exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @app/db test -- execution-repository.test.ts
pnpm --filter @app/db typecheck
```

Expected: migration applies once and all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma packages/db/src
git commit -m "feat(db): persist real codex execution credentials"
```

---

### Task 3: Create Real Executions and Authenticate the Bound Agent

**Files:**
- Create: `apps/web/src/server/executions/agent-auth.ts`
- Create: `apps/web/src/server/executions/agent-auth.test.ts`
- Modify: `apps/web/src/server/executions/service.ts`
- Modify: `apps/web/src/app/api/executions/route.ts`
- Modify: `apps/web/src/app/api/executions/executions-api.test.ts`
- Modify: `apps/web/src/app/api/executions/[executionId]/agent/claim/route.ts`
- Modify: `apps/web/src/app/api/executions/[executionId]/agent/heartbeat/route.ts`
- Modify: `apps/web/src/app/api/executions/[executionId]/events/route.ts`

**Interfaces:**
- Produces `ExecutionAgentAuthenticator.authenticate(request, executionId): Promise<RepositoryScope | null>`.
- `ExecutionService.createExecution(scope, request)` returns `{ execution; agentToken?: string; tokenExpiresAt?: string }`.
- Real creation request is `{ configVersion: 1; mode: "real_codex"; sourceCount: number; inputHash: "sha256:..." }`.
- Bearer format is `execution_token:<64 lowercase hex characters>`.

- [ ] **Step 1: Write failing service/API tests**

Prove that real creation returns a token once, only the SHA-256 hash reaches the store, simulator creation returns no token, and invalid source counts/hashes are rejected.

Add auth tests:

```ts
const request = new Request("http://127.0.0.1/api/executions/execution_1/events", {
  headers: { authorization: `Bearer execution_token:${"c".repeat(64)}` }
});
await expect(auth.authenticate(request, "execution_1")).resolves.toEqual({
  userId: "U-1",
  workspaceId: "W-1"
});
```

Reject missing `Bearer`, malformed tokens, expired tokens, and a token bound to another execution.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @app/web test -- executions-api.test.ts agent-auth.test.ts`

Expected: FAIL because real execution request fields and agent authentication are absent.

- [ ] **Step 3: Implement token creation and hashing**

Generate exactly 32 random bytes:

```ts
const agentToken = `execution_token:${randomBytes(32).toString("hex")}`;
const agentAccessTokenHash = createHash("sha256").update(agentToken).digest("hex");
```

Set expiry to 24 hours for the local validation build. Never serialize the token from `getExecution`, list APIs, SSE, errors, or logs.

- [ ] **Step 4: Implement bearer authentication and route selection**

For claim/heartbeat/event POST routes:

1. If a valid execution bearer token exists, resolve its exact scope and use a service for that scope.
2. Otherwise retain `getCurrentUser` for the simulator/dev route.
3. Never accept browser cookies as a substitute when an invalid Authorization header is present.
4. GET summary/SSE remains browser-session authenticated.

- [ ] **Step 5: Add local confirmation observation for real mode**

Extend `AppendExecutionEventRequestSchema` with `localConfirmation?: LocalConfirmationProofSchema`. Enforce:

- allowed only when `execution.mode === "real_codex"`;
- required when a real event continues past `publish_confirm`, `numbers_confirm`, or `dial_confirm`;
- action must match the current gate;
- `confirmedAt` cannot be in the future and cannot predate the waiting event;
- `stateHash` is stored only inside the event's controlled evidence summary/reference, never as an authorization token;
- simulator mode continues to require the existing persisted website confirmation grant.

Use the existing execution state machine for phase/status ordering. The real-mode path synthesizes only the minimal consumed domain confirmation needed for transition validation; it does not create a database `Confirmation` row.

- [ ] **Step 6: Run focused service and route tests**

Run: `pnpm --filter @app/web test -- executions-api.test.ts agent-auth.test.ts`

Expected: PASS, including simulator compatibility.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/executions apps/web/src/app/api/executions
git commit -m "feat(web): authenticate real local codex executions"
```

---

### Task 4: Secure Mac-Local Codex Launcher

**Files:**
- Create: `apps/web/src/server/local-launch/mac-codex-launcher.ts`
- Create: `apps/web/src/server/local-launch/mac-codex-launcher.test.ts`
- Create: `apps/web/src/app/api/local/launch/route.ts`
- Create: `apps/web/src/app/api/local/launch/route.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces `MacCodexLauncher.launch(prompt: string): Promise<{ opened: true; pasted: boolean; fallback: "none" | "manual_paste" }>`.
- Launch request is `{ prompt: string }`, maximum 32 KiB UTF-8.
- Feature flag is `AUTO_UX_LOCAL_CODEX_LAUNCH=1`, ignored in production.

- [ ] **Step 1: Write failing launcher tests**

Inject a fake process runner and prove:

- prompt bytes go to `pbcopy` stdin and never appear in argv;
- `open` receives exactly `["-a", "Codex"]`;
- AppleScript source is fixed and contains no prompt text;
- `osascript` failure returns `manual_paste` after Codex opens;
- `pbcopy` or `open` failure returns a controlled error;
- prompts over 32 KiB are rejected before spawning.

- [ ] **Step 2: Write failing route tests**

Test unauthenticated requests, production mode, disabled flag, non-loopback host/origin, invalid JSON, oversized prompt, successful paste, and manual-paste fallback.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `pnpm --filter @app/web test -- mac-codex-launcher.test.ts route.test.ts`

Expected: FAIL because the launcher and route do not exist.

- [ ] **Step 4: Implement fixed-command launcher**

Use `spawn`/`execFile` with fixed executable names and argument arrays. Pipe the prompt to `pbcopy` stdin. After `open -a Codex`, run a fixed AppleScript that activates Codex, waits briefly, and presses Command+V. Do not press Return or click Send.

- [ ] **Step 5: Implement route guards**

Require existing dev session auth, exact loopback URL host, same-origin request, non-production mode, and `AUTO_UX_LOCAL_CODEX_LAUNCH=1`. Return only controlled codes:

```json
{ "opened": true, "pasted": true, "fallback": "none" }
```

or

```json
{ "opened": true, "pasted": false, "fallback": "manual_paste" }
```

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm --filter @app/web test -- mac-codex-launcher.test.ts route.test.ts && pnpm --filter @app/web typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/local-launch apps/web/src/app/api/local/launch .env.example
git commit -m "feat(web): launch codex from local mac"
```

---

### Task 5: Real Task Form and Real-Mode Progress UI

**Files:**
- Create: `apps/web/src/components/executions/build-codex-prompt.ts`
- Create: `apps/web/src/components/executions/build-codex-prompt.test.ts`
- Create: `apps/web/src/components/executions/real-execution-form.tsx`
- Create: `apps/web/src/components/executions/real-execution-form.test.tsx`
- Modify: `apps/web/src/components/home-dashboard.tsx`
- Modify: `apps/web/src/app/page.test.tsx`
- Modify: `apps/web/src/components/executions/hybrid-progress.tsx`
- Modify: `apps/web/src/components/executions/confirmation-panel.tsx`
- Modify: `apps/web/src/components/executions/hybrid-progress.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Produces `buildCodexPrompt(input: RealExecutionPromptInput): string`.
- `RealExecutionPromptInput` contains `executionId`, `agentToken`, `apiBaseUrl`, `feishuUrls`, `requirements`, `phoneFilePath`, and optional `robotName`.
- `ExecutionSummary` gains `mode: "simulator" | "real_codex"`.

- [ ] **Step 1: Write failing prompt-builder tests**

Assert the prompt:

- explicitly invokes `$baidu-cloud-one-click-config`;
- includes exact execution ID, API base URL, bearer token, URLs, requirements and local path;
- states `create_only`, three Codex confirmations, no full-number output, and progress reporter use;
- contains no shell command interpolation;
- rejects unsupported URL schemes, blank requirements, newlines/NUL in the phone path, and output over 32 KiB.

- [ ] **Step 2: Write failing form tests**

Test validation, session bootstrap, execution creation, launcher request, success link, manual-paste fallback, and no second execution creation when launch fails after creation.

The request ordering assertion is:

```ts
expect(fetchCalls.map(({ url }) => url)).toEqual([
  "/api/dev/session",
  "/api/executions",
  "/api/local/launch"
]);
```

- [ ] **Step 3: Write failing real progress tests**

For `mode: "real_codex"` and a waiting confirmation event, assert the page shows “请回到 Codex 确认发布” and does not render a website confirmation button. For `mode: "simulator"`, preserve the existing button behavior.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `pnpm --filter @app/web test -- build-codex-prompt.test.ts real-execution-form.test.tsx hybrid-progress.test.tsx page.test.tsx`

Expected: FAIL because the form, builder, mode, and real confirmation presentation are absent.

- [ ] **Step 5: Implement the prompt builder and form state machine**

Use explicit states: `idle`, `creating`, `launching`, `manual_paste`, `launched`, and `error`. Once execution creation succeeds, preserve the execution ID through launcher retries and never call create again.

Compute the persisted input hash in the browser from normalized source count/non-sensitive metadata; do not include complete phone contents because the website never reads the file.

- [ ] **Step 6: Implement real-mode progress presentation**

Add `mode` to API summaries. In real mode, render a non-interactive confirmation card naming the required Codex action. Do not call the confirmation issuance API and do not resolve `LocalAgentBridge` for real tasks.

- [ ] **Step 7: Run focused tests, accessibility assertions, and typecheck**

Run: `pnpm --filter @app/web test -- build-codex-prompt.test.ts real-execution-form.test.tsx hybrid-progress.test.tsx page.test.tsx && pnpm --filter @app/web typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components apps/web/src/app
git commit -m "feat(web): create and launch real codex tasks"
```

---

### Task 6: Skill Progress Reporter and Workflow Integration

**Files:**
- Create: `skills/baidu-cloud-one-click-config/scripts/report_progress.py`
- Create: `skills/baidu-cloud-one-click-config/references/progress-reporting.md`
- Create: `skills/baidu-cloud-one-click-config/tests/test_report_progress.py`
- Modify: `skills/baidu-cloud-one-click-config/SKILL.md`
- Modify: `skills/baidu-cloud-one-click-config/agents/openai.yaml`
- Modify: `tests/test_skill_scripts.py`

**Interfaces:**
- CLI commands:

```text
report_progress.py claim CONTEXT_JSON
report_progress.py heartbeat CONTEXT_JSON
report_progress.py event CONTEXT_JSON EVENT_JSON
```

- Context JSON keys: `apiBaseUrl`, `executionId`, `agentId`, `sessionId`, `agentToken`, `pluginVersion`, `contractVersion`.
- HTTP requests use `Authorization: Bearer <agentToken>` and never print the header.

- [ ] **Step 1: Read the current `skill-creator` and `superpowers:writing-skills` instructions before editing the Skill**

This is a required execution-time skill gate. Read both complete `SKILL.md` files, then preserve the repository Skill's stricter create-only and privacy rules.

- [ ] **Step 2: Write failing Python tests**

Using `unittest` and a local fake HTTP server, cover:

- strict context keys and token format;
- HTTPS or loopback HTTP URL requirement;
- claim/heartbeat/event paths and JSON bodies;
- Authorization header present on the wire but absent from stdout/stderr;
- rejection of complete phone patterns, `access_token`, `refresh_token`, Cookie fields, Feishu body text fields, and unknown evidence keys;
- allowed masked samples such as `138****0001`;
- idempotent duplicate event handling;
- retry only for connection errors, HTTP 429, and HTTP 5xx, at most two attempts;
- no retry for HTTP 4xx contract/auth errors.

- [ ] **Step 3: Run the focused Python tests and verify failure**

Run: `python3 -m unittest skills/baidu-cloud-one-click-config/tests/test_report_progress.py -v`

Expected: FAIL because `report_progress.py` does not exist.

- [ ] **Step 4: Implement the reporter with Python standard library only**

Use `json`, `hashlib`, `urllib.request`, `urllib.error`, `ipaddress`, and `time`. Validate before opening the network request. Print only controlled success/error JSON without echoing context or server response bodies.

- [ ] **Step 5: Add the progress-reporting reference and wire each Skill phase**

Update the Skill so reporting is conditional: if website execution context is present, claim once, maintain heartbeat, and report each existing phase/checkpoint. If context is absent, preserve current standalone behavior. A reporting failure cannot authorize, repeat, or replace a Baidu action.

- [ ] **Step 6: Extend repository Skill structure tests**

Require the new reference and script, verify `SKILL.md` links the reference, and run reporter `--help`/invalid-input checks without network access.

- [ ] **Step 7: Run all Skill tests**

Run:

```bash
python3 -m unittest skills/baidu-cloud-one-click-config/tests/test_report_progress.py -v
python3 -m unittest tests/test_skill_scripts.py -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add skills/baidu-cloud-one-click-config tests/test_skill_scripts.py
git commit -m "feat(skill): report redacted execution progress"
```

---

### Task 7: Full Integration and Regression Verification

**Files:**
- Modify: `apps/agent-simulator/src/client.ts`
- Modify: `apps/agent-simulator/src/run-simulation.ts`
- Modify: `apps/agent-simulator/src/run-simulation.test.ts`
- Modify: `tests/e2e/execution-progress.spec.ts`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Simulator always uses `mode: "simulator"` and existing website-issued confirmation grants.
- Real E2E uses a fake Mac launcher and fake reporter events; it never opens Codex, Feishu, Baidu, or a phone service in CI.

- [ ] **Step 1: Add a failing real-mode vertical slice test**

The E2E test must:

1. create a dev session;
2. submit the real task form;
3. intercept the launch route and inspect the generated prompt;
4. claim with the returned bearer token;
5. post preflight and waiting-confirmation events;
6. verify SSE updates without refresh;
7. verify the real page points to Codex and contains no confirmation button;
8. post a matching local confirmation proof and completion events;
9. reload and verify the terminal state persists.

- [ ] **Step 2: Run the E2E test and verify failure**

Run: `pnpm e2e --grep "real codex task"`

Expected: FAIL before simulator and fixtures are updated for execution mode/token auth.

- [ ] **Step 3: Update simulator fixtures and README**

Keep all simulator confirmation tests unchanged in meaning. Document exact local prerequisites, `AUTO_UX_LOCAL_CODEX_LAUNCH=1`, macOS Accessibility fallback, real-mode privacy boundaries, and the fact that Railway cannot open local Codex without a future connector.

- [ ] **Step 4: Run full automated verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
pnpm verify:clean-build
python3 -m unittest tests/test_skill_scripts.py -v
python3 -m unittest skills/baidu-cloud-one-click-config/tests/test_report_progress.py -v
```

Expected: every command exits 0. No test may access real Feishu, Baidu, Codex, or phone services.

- [ ] **Step 5: Review the diff for secrets and unrelated changes**

Run:

```bash
git diff --check
git status --short
rg -n "execution_token:[a-f0-9]{64}|1[3-9][0-9]{9}|access_token|refresh_token" apps packages skills tests README.md
```

Expected: only intentional test fixtures match; no real token, phone number, or Feishu body is committed.

- [ ] **Step 6: Commit**

```bash
git add apps packages tests README.md .env.example
git commit -m "test: verify mac local real codex loop"
```

---

### Task 8: Package the Skill and Update the Existing Feishu Guide

**Files:**
- Modify only if needed: `skills/baidu-cloud-one-click-config/agents/openai.yaml`
- Create outside Git tracking: `/private/tmp/baidu-cloud-one-click-config.zip`
- External target: Feishu document `Mdm1dXWM0o3ezuxcHwNczytanPc`

**Interfaces:**
- Package root remains `skills/baidu-cloud-one-click-config/`.
- Required package entries: `SKILL.md`, `agents/openai.yaml`, every referenced file, and all deterministic scripts.
- Feishu document keeps its current structure and URL.

- [ ] **Step 1: Re-run Skill verification immediately before packaging**

Run:

```bash
python3 -m unittest tests/test_skill_scripts.py -v
python3 -m unittest skills/baidu-cloud-one-click-config/tests/test_report_progress.py -v
```

Expected: PASS.

- [ ] **Step 2: Build and inspect the ZIP**

Run from the repository root:

```bash
zip -r /private/tmp/baidu-cloud-one-click-config.zip skills/baidu-cloud-one-click-config -x '*.DS_Store' '__pycache__/*' '*.pyc'
shasum -a 256 /private/tmp/baidu-cloud-one-click-config.zip
unzip -Z1 /private/tmp/baidu-cloud-one-click-config.zip
```

Expected: one deterministic Skill tree with no caches, credentials, state files, or phone files. Record the emitted SHA-256 as the package digest.

- [ ] **Step 3: Read the current lark-cli update/media instructions**

Before the external write, read `lark-doc-update.md`, `lark-doc-media-insert.md`, `lark-doc-xml.md`, `lark-doc-style.md`, and the document update workflow through `lark-cli skills read`. Re-check `lark-cli whoami`; only request authorization if the token is actually invalid or a precise scope is missing.

- [ ] **Step 4: Fetch the document with full block IDs and replace the package block safely**

Fetch document `Mdm1dXWM0o3ezuxcHwNczytanPc` with `--detail full`. Insert the new ZIP with `docs +media-insert`, then replace the old attachment block using its current block ID from that fetch. Do not rebuild the document from Markdown and do not delete unrelated blocks.

- [ ] **Step 5: Update exact guide sections**

Update only:

- package SHA-256;
- current Skill version and file list;
- website form and Mac launch instructions;
- real-time progress reporting and privacy boundary;
- confirmation location (Codex, not website);
- Mac-local limitation and Railway/local-connector caveat;
- capability boundary.

If the manual Baidu acceptance has not yet run, keep the explicit statement that online field mapping and end-to-end real dialing are not verified. Do not claim production success from automated tests.

- [ ] **Step 6: Fetch the document again and verify the write**

Use `lark-cli docs +fetch --doc Mdm1dXWM0o3ezuxcHwNczytanPc --detail simple`. Confirm the new filename/digest/version appear once, old digest is absent, installation steps point to the new attachment, and unrelated guide sections remain present.

- [ ] **Step 7: Record the final local repository state**

Run: `git status --short --branch && git log -8 --oneline`

Expected: only the pre-existing `.DS_Store` remains untracked; all implementation changes are committed.

---

## Final Manual Acceptance Gate

After automated implementation, use the installed Skill in a new Codex task with an already signed-in Chrome session. First perform a read-only page-contract inspection. Only a dedicated test robot and test number may be used for the external acceptance, and the user must separately confirm publish, number import, and dial. Until that acceptance produces real Baidu readback and call-record evidence, report the software integration as complete but the production page adapter as unverified.
