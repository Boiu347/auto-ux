# 错误分类

| 错误码 | 分类 | 动作 |
|---|---|---|
| `FEISHU_TOKEN_EXPIRED` | 需用户处理 | 请求刷新既有登录；不要重复申请无关权限。 |
| `FEISHU_SCOPE_MISSING` | 需用户处理 | 说明准确缺失 scope。 |
| `SOURCE_INCOMPLETE` | 必须停止 | 补齐分页、截断或缺失来源。 |
| `SOURCE_CONFLICT` | 需用户选择 | 展示来源和值，不自动定优先级。 |
| `CONFIG_FIELD_MISSING` | 需用户选择 | 补充字段后重新确认草案。 |
| `BAIDU_SESSION_EXPIRED` | 需用户处理 | 暂停并请用户恢复登录。 |
| `NAVIGATION_NOT_ALLOWED` | 必须停止 | 离开白名单域名或路由后不得继续。 |
| `TARGET_MISMATCH` | 必须停止 | 当前机器人三元身份不一致。 |
| `READBACK_MISMATCH` | 可重试一次 | 第二次失败后停止。 |
| `CONFIRMATION_REQUIRED` | 等待确认 | 只请求当前单一高风险动作。 |
| `CONFIRMATION_CONSUMED` | 必须停止 | 不复用已消费确认。 |
| `RETRY_BUDGET_EXHAUSTED` | 必须停止 | 报告两次失败证据。 |
| `DIAL_OUTCOME_UNKNOWN` | 必须停止自动动作 | 查询记录或交由用户处理，禁止重拨。 |

错误报告必须包含：已确认事实、证据引用、未验证信息、是否产生外部副作用、最后安全检查点和唯一建议下一步。
