# 需求资料读取

## 总则

1. 对飞书内容先运行 `lark-cli whoami`，复用当前用户身份。
2. 每个飞书域命令都先读取其版本匹配的内置指南，例如 `lark-cli skills read lark-doc`、`lark-cli skills read lark-wiki`、`lark-cli skills read lark-minutes`。
3. 优先使用 `+` 快捷命令；运行写操作前检查命令帮助中的风险等级。
4. URL 先用 `lark-cli drive +inspect` 或 Wiki 节点解析能力确定真实对象类型，再调用对应读取命令。
5. 分页或截断必须继续读取至 EOF。保存 canonical token、版本/修改时间和内容哈希，不能只保存标题。

## 来源路由

| 来源 | 读取方式 | 必须保留的定位信息 |
|---|---|---|
| 飞书文档/Docx | `lark-cli docs +fetch` | document token、block/selector、版本 |
| 飞书 Wiki | 先解析 Wiki 节点，再读取底层对象 | node token、object token、节点路径 |
| 飞书会议纪要 | `lark-cli minutes +detail`，按需包含 summary、chapter、transcript | minute token、章节或时间戳、讲者 |
| 独立问卷链接 | 用 CLI 识别其 Drive/Docs/Sheets/Base 类型后读取 | 对象 token、记录/行/块定位 |
| 本地文件 | 本地读取；必要时调用对应文档、表格或 PDF 能力 | 绝对路径、文件哈希、页/段/行 |
| 粘贴文本 | 直接作为本地来源 | 输入时间、内容哈希、段落号 |

不要猜测 CLI 参数。运行对应 `lark-cli <domain> <command> --help` 或 `lark-cli schema ...` 后再调用。

## 抽取合同

每个来源输出本地结构：

```json
{
  "sourceId": "doc-token-or-local-hash",
  "title": "需求标题",
  "version": "source-version",
  "locator": "块、章节、时间戳、页码或行号",
  "sourceHash": "sha256:...",
  "fields": {
    "robotName": "回访机器人",
    "openingLine": "您好……"
  }
}
```

只提取来源明确表达的内容。推测值必须单独标为建议，不能放入已确认字段。

## 登录与权限

- `available=true` 且令牌有效：直接读取，不要求重复授权。
- `tokenStatus=needs_refresh`、令牌失效：说明事实并请求用户刷新登录。
- 明确缺少 scope：报告缺少的权限；不要笼统要求“全部授权”。
- 文档无权访问：保留错误信息，停止该来源；不要改用浏览器绕过。
