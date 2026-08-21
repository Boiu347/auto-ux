export interface RealExecutionPromptInput {
  executionId: string;
  agentToken: string;
  apiBaseUrl: string;
  feishuUrls: string[];
  requirements: string;
  phoneFilePath: string;
  robotName?: string;
}

export type StandaloneCodexPromptInput = Pick<
  RealExecutionPromptInput,
  "feishuUrls" | "requirements" | "phoneFilePath" | "robotName"
>;

const MAX_PROMPT_BYTES = 32 * 1024;
const ExecutionTokenPattern = /^execution_token:[a-f0-9]{64}$/;

export function buildCodexPrompt(input: RealExecutionPromptInput): string {
  validateInput(input);
  const prompt = [
    "请使用 $baidu-cloud-one-click-config 完成下面的真实百度云外呼配置任务。",
    "",
    "网站执行上下文：",
    `- executionId: ${input.executionId}`,
    `- apiBaseUrl: ${input.apiBaseUrl}`,
    `- agentToken: ${input.agentToken}`,
    "- targetPolicy: create_only",
    "",
    "任务输入：",
    ...input.feishuUrls.map((url) => `- 飞书文档: ${url}`),
    `- 补充需求: ${input.requirements.trim()}`,
    `- 本地号码文件: ${input.phoneFilePath}`,
    ...(input.robotName?.trim()
      ? [`- 机器人名称: ${input.robotName.trim()}`]
      : []),
    "",
    "执行要求：",
    "1. 先读取 Skill 和飞书文档，使用现有登录态；百度快捷机器人和外呼任务默认使用官方 API，仅在凭据缺失、API 未覆盖或明确诊断时使用浏览器。",
    "2. 只创建新机器人，不覆盖现有机器人。发布、导入号码、开始外呼必须分别在 Codex 中向我确认。",
    "3. 按 Skill 的网站联动章节初始化回报器，并在每个可验证阶段上报真实事件；不得伪造或推测进度。",
    "4. 三个高风险确认门都要同时等待网站或 Codex 的单项决定，先提交的一端生效；拒绝时立即停止对应动作。",
    "5. 不得输出完整号码、Cookie、飞书令牌或百度登录凭据。号码只能显示掩码。",
    "6. 每次 API 写入后必须查询回读；POST 结果未知时停止并查询状态，禁止自动重发或静默切回浏览器。"
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("PROMPT_TOO_LARGE");
  }
  return prompt;
}

export function buildStandaloneCodexPrompt(
  input: StandaloneCodexPromptInput
): string {
  validateTaskInput(input);
  const prompt = [
    "请使用 $baidu-cloud-one-click-config 完成下面的真实百度云外呼配置任务。",
    "当前为独立模式，不向网站上报进度；必须继续遵守 Skill 的本地状态、隐私和确认规则。",
    "",
    "任务输入：",
    ...input.feishuUrls.map((url) => `- 飞书文档: ${url}`),
    `- 补充需求: ${input.requirements.trim()}`,
    `- 本地号码文件: ${input.phoneFilePath}`,
    ...(input.robotName?.trim()
      ? [`- 机器人名称: ${input.robotName.trim()}`]
      : []),
    "",
    "执行要求：",
    "1. 使用现有飞书 CLI 登录态读取完整文档。百度快捷机器人默认走官方 API，并且只创建新机器人。",
    "2. 发布、导入号码、开始外呼必须分别在 Codex 中向我确认。",
    "3. 不得输出完整号码、Cookie、飞书令牌或百度登录凭据。",
    "4. API 写入后必须查询回读；无法验证的结果标记为 unknown，禁止自动重发或静默切回浏览器。"
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("PROMPT_TOO_LARGE");
  }
  return prompt;
}

function validateInput(input: RealExecutionPromptInput): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.executionId)) {
    throw new Error("INVALID_EXECUTION_ID");
  }
  if (!ExecutionTokenPattern.test(input.agentToken)) {
    throw new Error("INVALID_AGENT_TOKEN");
  }
  validateUrl(input.apiBaseUrl, ["http:", "https:"]);
  validateTaskInput(input);
}

function validateTaskInput(input: StandaloneCodexPromptInput): void {
  if (input.feishuUrls.length === 0) {
    throw new Error("FEISHU_URL_REQUIRED");
  }
  for (const url of input.feishuUrls) {
    validateUrl(url, ["https:"]);
  }
  if (!input.requirements.trim()) {
    throw new Error("REQUIREMENTS_REQUIRED");
  }
  if (
    !input.phoneFilePath.startsWith("/") ||
    /[\r\n\0]/.test(input.phoneFilePath)
  ) {
    throw new Error("INVALID_PHONE_FILE_PATH");
  }
  if (/[\r\n\0]/.test(input.robotName ?? "")) {
    throw new Error("INVALID_ROBOT_NAME");
  }
}

function validateUrl(value: string, protocols: string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_URL");
  }
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new Error("INVALID_URL");
  }
}
