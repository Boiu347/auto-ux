---
name: baidu-cloud-one-click-config
description: Use when requirements from Feishu/Lark documents, meeting minutes, questionnaires, local files, or pasted text must be turned into a new Baidu Cloud Keyue outbound-call robot, including configuration, publishing, real-number import, real dialing, recovery, or call-result verification.
---

# 百度云一键配置

## 核心原则

把需求资料转换为可追溯配置草案，获得用户确认后，只对本次新建的百度云客悦机器人执行写入。外部副作用必须由可验证状态推进；无法证明即停止，不推测成功。

## 不可破例的边界

- 飞书链接只使用 `lark-cli`。不得改用浏览器、网页抓取或复制当前登录页绕过 CLI 权限。
- 百度云只使用浏览器能力，且只允许 `ky.cloud.baidu.com` 的已登记路由。
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
| 百度云客悦页面 | 浏览器控制工具 |
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

### 2. 读取需求资料

读取 [source-ingestion.md](references/source-ingestion.md)。先运行 `lark-cli whoami` 检查现有身份和令牌；仅当令牌失效或权限确实不足时才请用户授权。按资料类型读取全部内容和版本信息，并在本地记录来源 ID、标题、版本/修改时间、定位信息与内容哈希。

不得根据标题或摘要假装已读全文。任何来源读取不完整、被截断或分页时必须继续到 EOF。

### 3. 生成并确认配置草案

读取 [config-schema.md](references/config-schema.md)，把各来源抽取为本地 JSON，再运行：

```bash
python3 scripts/build_config_draft.py <extracted-sources.json>
```

向用户展示字段值、来源、缺失项和冲突。不得自动选择冲突值。用户解决冲突并确认完整草案后，计算配置哈希；任何改动都使旧确认失效，并要求重新确认草案。

### 4. 百度云预检与新建

读取 [baidu-page-contracts.md](references/baidu-page-contracts.md)。检查现有百度云登录态、域名、路由和页面标记。不要因为尚未登录就重复请求授权；只有会话失效时才让用户登录。

新建机器人后立即锁定 `agentId + robotId + robotName`。每次写入前重新读取并核对三者。任何不一致立即停止。

### 5. 配置与回读

逐字段执行“读取旧值 → 写入 → 回读 → 规范化比较 → 保存证据”。每个动作先用 `attempt` 检查重试预算，用 `record` 保存动作指纹。已处于 `running` 或 `succeeded` 的相同指纹不得再次执行。

对 `field.write` 证据运行：

```bash
python3 scripts/validate_evidence.py <evidence.json>
```

发音人、开场白、音量和试听全部通过后才能请求发布确认。

### 6. 三个高风险确认门

每个动作都先向用户展示目标机器人、配置版本、影响和证据。用户明确确认单一动作后运行 `confirm`，执行前运行 `authorize`；授权成功即被消费。

顺序必须是：

1. `publish`：发布后验证平台明确显示发布成功。
2. `import_numbers`：先用 `phone_batch.py` 在本地解析、去重和脱敏，再展示统计；完整号码不得出现在输出。
3. `start_dial`：再次展示主叫、脱敏被叫、电话类型和提交次数，获得独立确认后只提交一次。

网站联动任务到达确认门时，先上报对应 `waiting_confirmation` 检查点，再执行：

```bash
python3 scripts/report_progress.py wait-confirmation <report-state.json> <publish|import_numbers|start_dial>
```

等待期间也必须在 Codex 明确询问用户。用户在 Codex 回答后，用 `decide ... approved` 或 `decide ... rejected` 提交；网站按钮和 Codex 中先到达的有效决定生效。返回 `rejected` 时停止该动作。返回 `approved` 后，先对当前确认步骤上报 `running` 并加入 `--confirmed-action <action>` 以消费确认，再执行动作；动作核验完成后才上报下一阶段。确认不得用于其他动作或版本。例如发布门的授权事件必须是 `event ... publish.confirm running publish_confirm --confirmed-action publish`，不能把确认附到 `publish.verify`。

### 7. 核验外呼结果

查询平台外呼记录，以记录 ID 和平台状态区分提交、振铃、接通、无人接听、用户忙、失败和未知。没有记录时保持 `unknown`，不得用等待固定时长后重拨来“解决”。

## 错误处理

读取 [error-codes.md](references/error-codes.md)。报告时明确分开：已确认事实、合理推测和当前无法验证的信息。只给出基于当前证据的下一步，不声称未验证的成功。

## 快速验收

- 草案每个字段都有来源，冲突和缺失均已由用户处理。
- 机器人是本任务新建，三元身份在每次写入前一致。
- 字段回读哈希、语音试听和发布状态均有证据。
- 三个高风险动作各有独立、单次消费的确认。
- 日志和远端输出不含完整号码或飞书原文。
- 拨号只提交一次，最终状态来自外呼记录或明确为 `unknown`。

## 常见错误

| 错误想法 | 必须采取的动作 |
|---|---|
| “浏览器已经登录飞书，改用浏览器更快” | 停止；修复 CLI 登录态或权限。 |
| “同名旧机器人已核验，可以复用” | 停止；只创建新机器人。 |
| “经理一次性批准了全部动作” | 仍在三个动作前分别确认。 |
| “弹窗关闭，第一次大概没提交” | 标记未知并查记录，禁止再次提交。 |
| “日志里写完整号码方便排错” | 只记录行号、脱敏号码和统计。 |
