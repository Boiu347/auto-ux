#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "0.4.0";
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "auto-ux", "agent.json");
const CODEX_RPC_TIMEOUT_MS = 20_000;

export async function deliverTask(task, dependencies) {
  const setStatus = dependencies.setStatus;
  if (!(await dependencies.fileExists(task.phoneFilePath))) {
    await setStatus("failed", "PHONE_FILE_NOT_FOUND");
    return "failed";
  }
  const workspacePath = dirname(task.phoneFilePath);
  try {
    await dependencies.openCodex(workspacePath);
  } catch {
    await setStatus("failed", "CODEX_OPEN_FAILED");
    return "failed";
  }
  await setStatus("codex_opened");
  try {
    await dependencies.startCodexTask(task.prompt, workspacePath);
  } catch (error) {
    await setStatus("failed", codexDeliveryErrorCode(error));
    return "failed";
  }
  await setStatus("prompt_sent");
  return "prompt_sent";
}

export async function pollOnce(config, overrides = {}) {
  const request = overrides.request ?? fetch;
  const response = await request(`${config.apiBaseUrl}/api/devices/tasks/next`, {
    headers: { authorization: `Bearer ${config.deviceToken}` }
  });
  if (response.status === 204) return "idle";
  if (!response.ok) throw new Error(`TASK_POLL_HTTP_${response.status}`);
  const payload = await response.json();
  const task = payload?.task;
  if (
    !task ||
    typeof task.id !== "string" ||
    typeof task.claimToken !== "string" ||
    typeof task.prompt !== "string" ||
    typeof task.phoneFilePath !== "string"
  ) {
    throw new Error("INVALID_TASK_PAYLOAD");
  }
  const setStatus = async (status, errorCode) => {
    const statusResponse = await request(
      `${config.apiBaseUrl}/api/devices/tasks/${encodeURIComponent(task.id)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.deviceToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          claimToken: task.claimToken,
          status,
          ...(errorCode ? { errorCode } : {})
        })
      }
    );
    if (!statusResponse.ok) {
      throw new Error(`TASK_STATUS_HTTP_${statusResponse.status}`);
    }
  };
  return deliverTask(task, {
    fileExists: overrides.fileExists ?? fileExists,
    openCodex: overrides.openCodex ?? openCodex,
    startCodexTask: overrides.startCodexTask ?? startCodexTask,
    setStatus
  });
}

export async function claimPairing(apiBaseUrl, code, options = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(apiBaseUrl);
  const agentId = options.agentId ?? stableAgentId();
  const request = options.request ?? fetch;
  const response = await request(`${normalizedBaseUrl}/api/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.toUpperCase(), agentId, version: VERSION })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.deviceToken !== "string") {
    throw new Error(payload.code ?? `PAIRING_HTTP_${response.status}`);
  }
  const config = {
    apiBaseUrl: normalizedBaseUrl,
    deviceToken: payload.deviceToken,
    agentId
  };
  await writeConfig(options.configPath ?? DEFAULT_CONFIG_PATH, config);
  return config;
}

async function runForever(configPath = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  for (;;) {
    try {
      await pollOnce(config);
    } catch (error) {
      process.stderr.write(
        `[auto-ux] ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}\n`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function openCodex(workspacePath) {
  await runCommand(findCodexCli(), ["app", workspacePath]);
}

export async function startCodexTask(prompt, workspacePath, options = {}) {
  const command = options.codexPath ?? findCodexCli();
  await (options.ensureDaemon ?? ensureCodexDaemon)(command);
  const child = (options.spawnProcess ?? spawn)(
    command,
    ["app-server", "proxy"],
    { shell: false, stdio: ["pipe", "pipe", "pipe"] }
  );
  const rpc = createJsonRpcClient(child, options.timeoutMs ?? CODEX_RPC_TIMEOUT_MS);
  try {
    await rpc.request("initialize", {
      clientInfo: {
        name: "auto-ux-mac-agent",
        title: "Auto UX Mac Agent",
        version: VERSION
      }
    });
    rpc.notify("initialized");
    const started = await rpc.request("thread/start", {
      cwd: workspacePath,
      approvalPolicy: "on-request",
      serviceName: "auto-ux",
      threadSource: "auto-ux-mac-agent"
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new Error("CODEX_INVALID_RESPONSE");
    }
    await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }]
    });
    rpc.detach();
    return { threadId };
  } catch (error) {
    rpc.close();
    throw error;
  }
}

function createJsonRpcClient(child, timeoutMs) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined) {
        continue;
      }
      const entry = pending.get(String(message.id));
      if (!entry) continue;
      pending.delete(String(message.id));
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`CODEX_RPC_ERROR:${message.error.code ?? "unknown"}`));
      } else {
        entry.resolve(message.result);
      }
    }
  });
  child.once("error", failAll);
  child.once("close", (code) =>
    failAll(new Error(`CODEX_APP_SERVER_EXITED:${code ?? "unknown"}`))
  );
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error("CODEX_RPC_TIMEOUT"));
        }, timeoutMs);
        pending.set(String(id), { resolve, reject, timer });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    detach() {
      child.stdin.end();
      child.stdout.resume();
      child.stderr?.resume();
      child.unref?.();
    },
    close() {
      child.kill();
    }
  };
}

async function ensureCodexDaemon(command) {
  await runCommand(command, ["app-server", "daemon", "start"]);
}

function findCodexCli() {
  return process.env.AUTO_UX_CODEX_PATH || "codex";
}

function codexDeliveryErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found/i.test(message)) return "CODEX_CLI_NOT_FOUND";
  if (/CODEX_RPC_TIMEOUT/.test(message)) return "CODEX_APP_SERVER_TIMEOUT";
  if (/CODEX_RPC_ERROR|CODEX_INVALID_RESPONSE|CODEX_APP_SERVER_EXITED/.test(message)) {
    return "CODEX_APP_SERVER_FAILED";
  }
  return "CODEX_SEND_FAILED";
}

function runCommand(command, args, stdin) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(command, args, {
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"]
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code ?? "unknown"}: ${stderr.trim()}`))
    );
    if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
  });
}

async function writeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function normalizeBaseUrl(value) {
  const url = new URL(value);
  const insecureHostAllowed = ["118.196.147.13", "localhost", "127.0.0.1"].includes(
    url.hostname
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && insecureHostAllowed)) {
    throw new Error("HTTPS_REQUIRED");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("INVALID_BASE_URL");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function stableAgentId() {
  const safeHost = hostname().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return `Mac_${safeHost || "Codex"}`;
}

async function main() {
  const [command = "run", first, second] = process.argv.slice(2);
  if (command === "pair") {
    if (!first || !second) throw new Error("usage: mac-agent.mjs pair <url> <code>");
    await claimPairing(first, second);
    process.stdout.write("Mac 助手配对成功。\n");
    return;
  }
  if (command !== "run") throw new Error(`unknown command: ${command}`);
  await runForever(process.env.AUTO_UX_AGENT_CONFIG ?? DEFAULT_CONFIG_PATH);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "UNKNOWN_ERROR"}\n`);
    process.exitCode = 1;
  });
}
