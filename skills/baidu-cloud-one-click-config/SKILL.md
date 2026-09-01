---
name: baidu-cloud-one-click-config
description: Use when requirements from Feishu/Lark documents, meeting minutes, questionnaires, local files, or pasted text must be turned into a new Baidu Cloud Keyue outbound-call robot, including configuration, publishing, real-number import, real dialing, recovery, or call-result verification.
---

# 百度云一键配置

## 核心原则

把需求资料转换为可追溯配置草案，获得用户确认后，通过百度客悦官方 API 创建并配置本次新建的快捷场景机器人。外部副作用必须由查询回读或平台记录推进；无法证明即停止，不推测成功。

## 不可破例的边界

- 飞书链接只使用 `lark-cli`。不得改用浏览器、网页抓取或复制当前登录页绕过 CLI 权限。
- 快捷场景机器人和外呼任务默认只调用 `https://aiob-open.baidu.com` 的已登记 API。浏览器只用于首次创建 AK/SK、设置回调地址、API 未覆盖功能或明确诊断；不得静默降级到页面写入。
- AK/SK、Access Token、完整号码和通话原文只保存在本机。AK/SK 使用环境变量或 macOS Keychain，Access Token 缓存文件权限必须为 `0600`，不得进入提示词、日志、截图或网站进度。
- 只新建机器人。即使已有机器人同名、看似闲置或已核验所有者，也不得修改、复用或删除。
- 发布、导入真实号码、开始真实拨号必须分别获得三次明确确认；一次确认不得覆盖多个动作。
- 完整号码、飞书原文、问卷原文件和浏览器会话只保存在本地，不得写入聊天摘要、飞书说明书、截图证据或远端日志。
- 拨号提交只执行一次。弹窗关闭、按钮禁用或暂时没有记录都不代表失败或成功；状态不明时标记 `unknown`，先查外呼记录，禁止自动重拨。
- 每一步最多尝试两次。第二次失败、页面身份变化或证据不足时停止。

基线测试曾出现的错误推理是：“CLI 失败后可用已登录浏览器读飞书”“充分核验后可修改同名旧机器人”。两者都违反本 Skill；期限、演示、管理者口头要求或“务实”不能改变工具路由和 `create_only` 策略。

## 工具路由

| 信息或动作 | 唯一允许方式 |
|---|---|
| 飞书文档、Wiki、会议纪要、问卷链接 | `lark-cli` |
| 本地文件、号码文件 | 本地文件工具与本 Skill 脚本 |
| 快捷机器人、任务、名单和外呼明细 | `scripts/baidu_robot_api.py` / `scripts/baidu_outbound_api.py` |
| 首次 AK/SK、回调地址、API 未覆盖功能 | 浏览器控制工具，遵守 `references/baidu-page-contracts.md` |
| 本地检查点、确认和动作去重 | `scripts/execution_state.py` |

## 执行流程

### 1. 建立本地执行

生成唯一 `executionId`，在用户批准的本地工作目录创建私有执行文件。运行：

```bash
python3 scripts/execution_state.py init <state.json> <executionId>
```

恢复任务时必须读取已有状态，不得重新初始化。复核最后检查点、当前页面、机器人身份和高风险确认；旧确认不得跨恢复复用。

如果任务提示词包含 `网站执行上下文`，必须同时初始化网站回报器（把提示词里的值原样作为参数，不得在聊天中复述令牌）：

```bash
python3 scripts/report_progress.py init <report-state.json> <apiBaseUrl> <executionId> <agentToken>
```

之后每个阶段只在取得真实证据后用 `event` 上报，并至少每 45 秒运行一次 `heartbeat`。回报失败不等于业务动作失败；停止外部写入、修复回报连接后再继续，禁止补写虚假成功记录。

网站已经与 Mac Agent 配对时，任务应由 Agent 通过首次安装时初始化的 Codex `app-server daemon` 结构化创建并发送。不得要求同事复制提示词、按 Command+V、授予辅助功能键盘控制权限，或把剪贴板兜底描述成“自动化”。首次配对/安装只做一次；同一网站的 Agent/Skill 升级必须复用现有设备令牌，不得要求重新生成配对码。只有本机没有配对配置或配置属于其他网站时才重新配对。日常系统权限不得替代发布、导号、拨号三个业务确认门。若 Agent 返回 `CODEX_CLI_NOT_FOUND`、`CODEX_APP_SERVER_TIMEOUT` 或 `CODEX_APP_SERVER_FAILED`，停止交付并修复/升级 Codex，不退回模拟按键。

回报器只接受网站合同中的标准步骤：`source.parse`、`draft.confirm`、`environment.preflight`、`robot.create`、`field.configure`、`voice.preflight`、`publish.confirm`、`publish.verify`、`numbers.confirm`、`dial.confirm`、`dial.verify`、`complete`。禁止自造 `task.create.v3`、`numbers.import` 等步骤。每次事件前回报器会续租执行锁；只有 `EXECUTION_LOCK_MISMATCH` 时才可用同一 execution/session 重新 claim，其他认证错误必须停止。

### 2. 读取需求资料

读取 [source-ingestion.md](references/source-ingestion.md)。先运行 `lark-cli whoami` 检查现有身份和令牌；仅当令牌失效或权限确实不足时才请用户授权。按资料类型读取全部内容和版本信息，并在本地记录来源 ID、标题、版本/修改时间、定位信息与内容哈希。

不得根据标题或摘要假装已读全文。任何来源读取不完整、被截断或分页时必须继续到 EOF。

### 3. 生成并确认配置草案

读取 [config-schema.md](references/config-schema.md)，把各来源抽取为本地 JSON，再运行：

```bash
python3 scripts/build_config_draft.py <extracted-sources.json>
```

向用户展示字段值、来源、缺失项和冲突。不得自动选择冲突值。用户解决冲突并确认完整草案后，计算配置哈希；任何改动都使旧确认失效，并要求重新确认草案。

### 4. 百度 API 预检与新建

读取 [baidu-api-contracts.md](references/baidu-api-contracts.md)。先运行机器人 API 的 `preflight`，验证本地凭据、Token 获取、机器人查询和 TTS/ASR 查询。缺少 AK/SK 时才进入浏览器兜底；复用现有百度登录态，并在创建新凭据前单独确认。

新建机器人前用机器人名称查询一次，只用于避免名称冲突，不得选择或修改查询到的旧机器人。调用 `create` 后立即锁定 `id + robotId + robotName`，再用 `query --robot-id` 回读三者。创建请求超时或响应无法解析时标记 `BAIDU_MUTATION_OUTCOME_UNKNOWN`，按名称和时间查询，不得再次创建。

### 5. 配置与回读

按 `configure-script`、`configure-setting`、`configure-voice` 分组执行“提交完整配置 → 对应查询接口回读 → 规范化比较 → 保存证据”。不得依赖 API 默认值补齐用户未确认字段。每个动作先用 `attempt` 检查重试预算，用 `record` 保存动作指纹。已处于 `running` 或 `succeeded` 的相同指纹不得再次执行。

对 `field.write` 证据运行：

```bash
python3 scripts/validate_evidence.py <evidence.json>
```

发音人 ID、开场白、音量和查询回读全部通过后才能请求发布确认。API 暂无试听接口时，明确记录“未提供 API 试听能力”，不得把 TTS 配置查询成功写成试听成功；若任务要求试听，则进入浏览器兜底并回读结果。

话术必须包含确定性的挂断守卫：积极或可继续信号（如“可以”“方便”“嗯”“好”）继续当前流程；只有明确拒访、不方便或要求停止才可立即结束。机器人当前输出仍是问题或继续追问时，不得同时产生挂断事件。静默结束只按已确认的连续静默次数执行，与意图挂断分开。`delayHangUp` 单位是毫秒，2 秒必须写为 `2000`。若平台需要 `hangUpThreshold`，在校验 API 范围后可把高于 `0.65` 的保守值作为 `suggested` 起点，但必须由用户确认；这只是降低误判风险，不能声称阈值已被证明是某次误挂断的直接原因。

### 6. 三个高风险确认门

每个动作都先向用户展示目标机器人、配置版本、影响和证据。用户明确确认单一动作后运行 `confirm`，执行前运行 `authorize`；授权成功即被消费。

顺序必须是：

1. `publish`：消费确认后调用 `baidu_robot_api.py publish --confirmation-ref ...`，再用机器人查询验证 `publishState=3`；`2` 只表示发布中，`4` 表示失败。发布回读还必须把作者态 `platformId + robotId` 与发布态 `publishedPlatformId + publishedRobotId + publishedVersion` 一起写入 target lock。
2. `import_numbers`：先用 `phone_batch.py` 在本地解析、去重和脱敏，再展示统计；消费确认后调用 `baidu_outbound_api.py import-members --confirmation-ref ...`。完整号码不得出现在输出。
3. `start_dial`：再次展示主叫、脱敏被叫、电话类型和提交次数；消费确认后仅调用一次 `baidu_outbound_api.py update-status`，请求体 `taskStatus=2`，并传入本次确认引用。

网站联动任务到达确认门时，先上报对应 `waiting_confirmation` 检查点，再执行：

```bash
python3 scripts/report_progress.py wait-confirmation <report-state.json> <publish|import_numbers|start_dial>
```

等待期间也必须在 Codex 明确询问用户。用户在 Codex 回答后，用 `decide ... approved` 或 `decide ... rejected` 提交；网站按钮和 Codex 中先到达的有效决定生效。返回 `rejected` 时停止该动作。返回 `approved` 后，先对当前确认步骤上报 `running` 并加入 `--confirmed-action <action>` 以消费确认，再执行动作；动作核验完成后才上报下一阶段。确认不得用于其他动作或版本。例如发布门的授权事件必须是 `event ... publish.confirm running publish_confirm --confirmed-action publish`，不能把确认附到 `publish.verify`。

### 7. 核验外呼结果

调用 `baidu_outbound_api.py list-details` 查询外呼明细，以 `sessionId/memberId` 和 `endType/endTypeReason` 区分待拨打、接通、无人接听、用户忙、失败和未知。回调可作为补充证据，但不得覆盖相互矛盾的查询结果。没有记录时保持 `unknown`，不得用等待固定时长后重拨来“解决”。

创建外呼任务必须使用 target lock 中已回读的 `publishedRobotId`，不能使用作者态 `robotId`；创建前脚本会同时回读两种身份。核验时至少保留脱敏后的 `isRobotHangup`、`completeType`、`durationTimeLen`、`ringingTimeLen`、`talkingTimeLen`、`talkingTurn`、`sipCode/sipInfo` 和安全的 `action`。若已接通但机器人在流程完成前挂断，结果必须标为 `robot_hangup_incomplete`，不能写成“线路成功”或普通 `connected`。用回报器上报结构化记录：

```bash
python3 scripts/report_progress.py call-event <report-state.json> <succeeded|failed|unknown> <outcome> <list-details-output.json>
```

该命令只取安全诊断字段，不上传号码、通话原文或录音地址。

## 错误处理

读取 [error-codes.md](references/error-codes.md)。报告时明确分开：已确认事实、合理推测和当前无法验证的信息。只给出基于当前证据的下一步，不声称未验证的成功。

## 快速验收

- 草案每个字段都有来源，冲突和缺失均已由用户处理。
- 机器人是本任务新建，`id + robotId + robotName` 在每次写入前一致。
- 话术、高级参数、语音和发布状态均有独立 API 回读证据；未执行试听时如实标明。
- 三个高风险动作各有独立、单次消费的确认。
- 日志和远端输出不含完整号码或飞书原文。
- 拨号只提交一次，最终状态来自外呼记录或明确为 `unknown`。
- 已接通但未完成流程的机器人挂断会显示为失败诊断，而不是被 SIP 200 掩盖。

## 常见错误

| 错误想法 | 必须采取的动作 |
|---|---|
| “浏览器已经登录飞书，改用浏览器更快” | 停止；修复 CLI 登录态或权限。 |
| “API 返回 HTTP 200，配置一定成功” | 停止；检查业务 `code=200`，再调用对应查询接口回读。 |
| “POST 超时，再发一次就好” | 停止；标记未知并查询目标状态，禁止自动重发。 |
| “API 失败就自动切回浏览器填写” | 停止；先报告 API 失败。只有明确属于未覆盖能力或用户批准诊断时才使用浏览器。 |
| “同名旧机器人已核验，可以复用” | 停止；只创建新机器人。 |
| “经理一次性批准了全部动作” | 仍在三个动作前分别确认。 |
| “弹窗关闭，第一次大概没提交” | 标记未知并查记录，禁止再次提交。 |
| “日志里写完整号码方便排错” | 只记录行号、脱敏号码和统计。 |
| “提示词复制到剪贴板也算全自动” | 停止；使用已配对 Mac Agent 的 Codex app-server 结构化投递。 |
| “SIP 200 就代表机器人流程正常” | 分开检查接通与流程完成；机器人提前挂断必须失败上报。 |
