# auto UX

auto UX 是百度云外呼机器人“一键配置”的网站雏形。用户填写飞书文档、补充需求和 Mac 本地号码文件路径，网站生成与 `$baidu-cloud-one-click-config` 兼容的 Codex 任务。

## 当前范围

当前提供两种明确区分的使用方式：

- **Mac 本地模式**：创建 `real_codex` 执行，生成 24 小时 Agent 令牌，通过 `pbcopy` 和 `open -a Codex` 打开并粘贴任务；网站接收真实进度事件。
- **云端雏形模式**：Railway 等云端环境无法直接打开访问者 Mac 上的应用，因此只在浏览器复制独立任务提示词。用户手动打开 Codex 粘贴，仍使用同一个 Skill 完成任务。

仓库包含 `skills/baidu-cloud-one-click-config`。真实百度操作由 Codex 和该 Skill 执行，不由网站服务器执行。发布、导入号码、开始外呼仍需在 Codex 中分别确认。页面或进度记录不能证明百度平台成功，最终结果必须由平台回读证据确认。

## 前置条件

- Node.js 24
- pnpm 11
- Docker Desktop（可运行 Docker Compose）
- Playwright Chromium

真实百度 API 模式还需要在客悦“系统管理 → API 配置”创建 AK/SK。推荐在 Skill 目录运行 `python3 scripts/baidu_credentials.py set`，通过交互提示写入 macOS Keychain；不要把 AK/SK 放入仓库、网站环境变量或任务提示词。完成后可运行 `python3 scripts/baidu_robot_api.py preflight` 做只读连通性检查。

```bash
pnpm install
pnpm exec playwright install chromium
```

## 启动和停止

### 快速查看网站雏形

```bash
cp .env.example .env
pnpm build
pnpm start
```

打开 [http://localhost:3000](http://localhost:3000)。生产启动和 Railway 默认展示云端雏形模式，提交后复制任务提示词。

### Mac 本地完整模式

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
| `AUTO_UX_LOCAL_CODEX_LAUNCH` | 本地设为 `1` 时允许服务器调用 Mac 的 `pbcopy`、`open` 和固定 AppleScript；生产环境始终忽略 |
| `AUTO_UX_PUBLIC_BASE_URL` | Codex 网站回报使用的完整外部地址；反向代理部署必须包含公开路径，例如 `http://118.196.147.13/auto-ux` |

## NX Server 部署

GitLab `main` 流水线验证通过后会自动发布到：

```text
http://118.196.147.13/auto-ux/
```

生产镜像同时运行 Next.js 和仅监听容器回环地址的 PostgreSQL。数据库文件保存在 NX 平台声明的 `data/` 持久化目录中，代码发布不会覆盖业务数据，也不需要单独配置 `DATABASE_URL`。容器停止时会对 PostgreSQL 执行快速、安全关闭。

生产页面使用 Mac 配对令牌识别用户和工作区。每位同事应分别完成配对；服务端继续按 `userId + workspaceId` 隔离任务、确认和审计记录。公网入口本身不授予任务数据访问权限。

仓库中的 `.gitlab-ci.yml`、`Dockerfile`、`docker-entrypoint.sh` 和 `monitor.yaml` 是部署合同的一部分。GitHub 与 GitLab 应保持在同一个提交，GitLab 负责执行部署。

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
