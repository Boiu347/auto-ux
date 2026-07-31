# auto UX

auto UX 是百度云外呼机器人“一键配置”的本地控制面基础版。网页只展示服务端已持久化的任务进度、证据和确认门；本地 Agent 负责实际执行。

## 当前范围

本阶段只有确定性模拟器，用来验证从 PostgreSQL、API、SSE 到网页确认门的完整链路。

- 不读取真实飞书文档或会议纪要。
- 不打开或修改真实百度云机器人。
- 不导入真实号码，不启动真实外呼。
- 未包含发给每个人的 Codex 插件/Skill 安装包。

真实飞书 CLI 读取、Codex 插件、百度云浏览器自动化、本地号码解析和外呼结果核验是后续集成项，不应把当前模拟结果当作真实平台成功。

## 前置条件

- Node.js 24
- pnpm 11
- Docker Desktop（可运行 Docker Compose）
- Playwright Chromium

```bash
pnpm install
pnpm exec playwright install chromium
```

## 启动和停止

```bash
pnpm dev:up
```

脚本会按固定顺序执行：

1. 启动并等待 PostgreSQL。
2. 生成 Prisma Client，使用 `prisma migrate deploy` 应用已提交迁移。
3. 验证生产构建，再以非生产 `next dev` 适配器在 `127.0.0.1:3100` 启动 Web。
4. 通过真实 API 创建一个租户隔离的演示执行。
5. 启动 HTTP 模拟器，在“确认发布”前停下。

打开 [http://127.0.0.1:3100](http://127.0.0.1:3100)，点击“创建演示任务”后进入执行页。启动日志位于 `.dev-runtime/`。

在另一个终端停止：

```bash
pnpm dev:down
```

`dev:down` 只终止 `.dev-runtime/web.owner` 同时记录且通过“PID + 随机所有权标记 + 启动包装器路径”校验的 Web 子进程，然后执行 `docker compose stop postgres`。如果 PID 被复用或无法核实进程身份，脚本会拒绝发送信号并保留元数据供人工检查。它不删除数据卷。

## 环境变量

| 变量 | 默认值 / 用途 |
| --- | --- |
| `DATABASE_URL` | 本地 `control_plane` PostgreSQL 连接 |
| `PORT` | `3100` |
| `DEV_USER_ID` | `U-1`，演示用户边界 |
| `DEV_WORKSPACE_ID` | `W-1`，演示工作区边界 |
| `DEV_SESSION_SECRET` | 本地 HttpOnly 会话签名密钥，至少 32 字符 |
| `AUTO_UX_RUNTIME_DIR` | 运行时 PID、演示执行 ID 和日志目录 |

`.env.example` 只提供本地示例。不要把真实会话、原始文档或完整电话号码写入环境文件。

## 验证

`pnpm test` 会运行 contracts、execution-core、db、agent-simulator、web 和进程所有权脚本测试。其中数据库测试需要先启动 PostgreSQL、生成 Prisma Client 并应用已提交迁移：

```bash
docker compose up -d postgres
DATABASE_URL="postgresql://control_plane:control_plane@127.0.0.1:5432/control_plane?schema=public" pnpm --filter @app/db exec prisma generate --schema prisma/schema.prisma
DATABASE_URL="postgresql://control_plane:control_plane@127.0.0.1:5432/control_plane?schema=public" pnpm --filter @app/db exec prisma migrate deploy --schema prisma/schema.prisma
```

然后运行全仓验证：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
```

`pnpm build` 按 contracts、execution-core、db 类型检查、agent-simulator 类型检查、web 的顺序执行。`pnpm verify:clean-build` 会在 `mktemp` 创建的隔离副本中排除所有 `dist` 和 `.next` 产物，再运行同一构建入口；它不删除或改名当前工作区的共享产物。

`pnpm e2e` 自动调用 `dev:up`。该入口先验证生产构建，再通过 `next dev` 启动仅限非生产环境的本地认证适配器；Playwright 等待 `/api/dev/ready` 确认演示执行已经持久化后才开始。生产环境无条件拒绝开发 Cookie 和请求头认证，客户端启动数据不包含任何认证密钥。测试结束后无论成功或失败都会核验并清理自己启动的本地 Web 进程所有权记录，但不会停止或删除可能被其他开发任务复用的 PostgreSQL。它不会发起真实外呼。

## 架构与信任边界

```text
浏览器 UI ──确认请求──> Next.js API ──> PostgreSQL
     ^                         |
     |                         | 任务包 / 持久化事件
     +──本地桥接── 本地 Agent/模拟器
```

- 所有执行读写都同时绑定 `userId` 和 `workspaceId`。
- 目标策略固定为 `create_only`，后续真实适配器不得修改已有机器人。
- 进度只来自持久化事件，未知结果保持 `unknown`，不通过超时或推测变成成功。
- `publish`、`import_numbers`、`start_dial` 各自需要本人单独确认，凭据绑定执行、配置版本和动作，且不可重放。
- 服务端不保存原始飞书文本、浏览器会话、原始上传文件或完整电话号码。
- 浏览器确认凭据只交给持有当前执行锁的精确 Agent/session。
- 本地测试适配器仅由 `dev:up` 通过 `next dev` 显式开启，Web 只绑定 `127.0.0.1`。生产环境无条件隐藏开发会话和演示入口，并拒绝所有开发 Cookie、租户请求头及旧的本地测试密钥请求头；不存在可打开此认证分支的生产配置。
