# 百度客悦 API 合同

## 适用范围

本合同只覆盖快捷场景机器人、批量外呼任务、名单导入和外呼明细。官方文档明确说明机器人 API 暂不支持画布配置。主机固定为 `https://aiob-open.baidu.com`；旧主机 `aicc.bce.baidu.com` 已标记即将下线，不得使用。

## 凭据与 Token

- 在客悦“系统管理 → API 配置”创建 AK/SK；这是一次性浏览器操作，创建前需用户确认。
- 调用 `POST /api/v2/getToken` 获取 Access Token，官方文档标注默认有效期约 30 天。
- AK/SK 从 `BAIDU_KY_ACCESS_KEY` / `BAIDU_KY_SECRET_KEY` 或 macOS Keychain 服务 `baidu-keyue-access-key`、`baidu-keyue-secret-key` 读取。
- 推荐运行 `python3 scripts/baidu_credentials.py set` 交互写入 Keychain，避免密钥进入 shell 历史。`delete` 属于凭据删除，必须显式传 `--yes`。
- Token 缓存不得包含 SK，权限必须为 `0600`，到期前 5 分钟视为失效。
- 业务接口使用 `Authorization` Header。官方页面同时展示 Access Token 流程和旧式签名示例；真实账号预检未通过前不得假定二者等价。

## 机器人端点

| 操作 | 方法与路径 | 写后回读 |
|---|---|---|
| 新增机器人 | `POST /api/v1/robot/manage/create` | `GET /api/v1/robot/query/list` |
| 编辑名称与描述 | `POST /api/v1/robot/manage/edit` | 机器人查询 |
| 配置话术 | `POST /api/v1/robot/config/script` | `GET /api/v1/robot/query/listscript` |
| 配置高级参数 | `POST /api/v1/robot/config/setting` | `GET /api/v1/robot/query/listsetting` |
| 配置 TTS/ASR | `POST /api/v1/robot/config/voice` | 机器人查询；可选项来自 `GET /api/v1/robot/ttsasr` |
| 发布 | `POST /api/v1/robot/manage/publish` | 机器人查询中的 `publishState` |

话术必填字段是 `robotId`、`role`、`audience`、`taskAndGoal`。`welcome` 对应开场白。配置前根据官方范围校验 `maxSilenceCount`、`maxCallRounds`、`delayHangUp` 等数值，不得截断或自动纠正。

发布状态：`1` 未发布、`2` 发布中、`3` 成功、`4` 失败。只有 `3` 能进入号码流程。发布成功会产生供外呼运行的发布态身份；target lock 必须同时记录作者态 `platformId/robotId` 和发布态 `publishedPlatformId/publishedRobotId/publishedVersion`，两者不得混用。

## 外呼端点

| 操作 | 方法与路径 | 说明 |
|---|---|---|
| 获取主叫号码 | `GET /api/v1/did/list` | 只选启用且支持呼出的号码 |
| 创建任务 | `POST /api/v4/console/apitask/create` | 当前文档版本为 V4 |
| 查询任务 | `POST /api/v3/console/apitask/gettask` | 创建后及状态变更后回读 |
| 导入名单 | `POST /api/v3/console/apitask/import` | 每次最多 1000 个号码组 |
| 启停任务 | `POST /api/v3/console/apitask/task/status/update` | `2` 执行、`3` 暂停、`4` 完成 |
| 查询外呼明细 | `POST /api/v3/console/apitask/member/list` | 使用 `nextCursor` 分页，单页最多 200 |

创建任务时 `taskName` 不得重复，`robotId` 必须是发布回读中的 `publishedRobotId`，不是作者态 `robotId`。创建前同时查询作者态与发布态记录，校验机器人名称、发布状态和发布版本。`isOpenEmptyNum`、`isOpenPhoneDown` 是必填布尔值，必须来自已确认草案。名单 `secretType=2` 会发送明文号码；除非用户明确选择且本地隐私规则允许，否则优先使用平台系统加密并要求有效 `secretId`。

## 重试与未知状态

- 只读 GET、任务查询和外呼明细查询最多自动重试一次。
- 创建、配置、发布、导号和任务状态变更均不得自动重试。
- 变更请求发生超时、连接中断或响应无法解析时返回 `BAIDU_MUTATION_OUTCOME_UNKNOWN`。随后用名称、`robotId`、`taskId` 或明细记录查询；没有证据时保持 `unknown`。
- HTTP 成功不等于业务成功。必须同时满足业务 `code=200`，并完成对应回读。

## 输出与证据

证据允许保存：`requestId`、目标作者态/发布态 ID、机器人名称、任务 ID、脱敏号码、配置输入哈希、回读哈希、发布状态、外呼结果枚举，以及 `isRobotHangup`、`completeType`、通话/振铃/接通时长、有效轮次、SIP 状态和安全的动作枚举。

禁止保存：AK/SK、Access Token、完整主被叫号码、`extJson` 原文、对话 `record/contextText`、录音地址和 API 返回中的其他 Token。

## 官方文档

- [调用说明](https://cloud.baidu.com/doc/ky/s/rmfnjpj48)
- [获取认证](https://cloud.baidu.com/doc/ky/s/hmfnjpj6h)
- [机器人配置概述](https://cloud.baidu.com/doc/ky/s/imfnlwi5j)
- [创建任务 V4](https://cloud.baidu.com/doc/ky/s/8mfnjpkk4)
- [导入客户名单](https://cloud.baidu.com/doc/ky/s/Wmfnjpk3v)
- [批量获取外呼明细](https://cloud.baidu.com/doc/ky/s/Kmfnjpkos)
