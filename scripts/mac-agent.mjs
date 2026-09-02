#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "0.4.4";
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
    headers: {
      authorization: `Bearer ${config.deviceToken}`,
      "x-auto-ux-agent-version": VERSION
    }
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
  const rpc = createJsonRpcClient(
    child,
    options.timeoutMs ?? CODEX_RPC_TIMEOUT_MS,
    options.webSocketKey
  );
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

export async function inspectCodexDaemon(options = {}) {
  const command = options.codexPath ?? findCodexCli();
  await (options.ensureDaemon ?? ensureCodexDaemon)(command);
  const child = (options.spawnProcess ?? spawn)(
    command,
    ["app-server", "proxy"],
    { shell: false, stdio: ["pipe", "pipe", "pipe"] }
  );
  const rpc = createJsonRpcClient(
    child,
    options.timeoutMs ?? CODEX_RPC_TIMEOUT_MS,
    options.webSocketKey
  );
  try {
    await rpc.request("initialize", {
      clientInfo: {
        name: "auto-ux-mac-agent",
        title: "Auto UX Mac Agent",
        version: VERSION
      }
    });
    rpc.notify("initialized");
    const listed = await rpc.request("thread/list", {
      limit: 1,
      useStateDbOnly: true
    });
    if (!Array.isArray(listed?.data)) {
      throw new Error("CODEX_INVALID_RESPONSE");
    }
    return { threadCount: listed.data.length };
  } finally {
    rpc.close();
  }
}

export function createJsonRpcClient(child, timeoutMs, webSocketKey) {
  let nextId = 1;
  const pending = new Map();
  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  const transport = createWebSocketTransport(child, (message) => {
    if (message.id === undefined) return;
    const entry = pending.get(String(message.id));
    if (!entry) return;
    pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(`CODEX_RPC_ERROR:${message.error.code ?? "unknown"}`));
    } else {
      entry.resolve(message.result);
    }
  }, failAll, webSocketKey);
  child.once("error", failAll);
  child.once("close", (code) =>
    failAll(new Error(`CODEX_APP_SERVER_EXITED:${code ?? "unknown"}`))
  );
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error("CODEX_RPC_TIMEOUT"));
        }, timeoutMs);
        pending.set(String(id), { resolve, reject, timer });
        transport.send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      transport.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
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

function createWebSocketTransport(child, onMessage, onError, providedKey) {
  const key = providedKey ?? randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let fragmentedOpcode = null;
  let fragments = [];
  const queued = [];

  const sendFrame = (opcode, payload) => {
    child.stdin.write(encodeWebSocketFrame(opcode, Buffer.from(payload)));
  };
  const deliverText = (payload) => {
    for (const line of payload.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        onError(new Error("CODEX_INVALID_RESPONSE"));
      }
    }
  };
  const processFrames = () => {
    for (;;) {
      const frame = readWebSocketFrame(buffer);
      if (!frame) return;
      buffer = buffer.subarray(frame.bytesConsumed);
      if (frame.opcode === 0x8) {
        onError(new Error("CODEX_APP_SERVER_CLOSED"));
        return;
      }
      if (frame.opcode === 0x9) {
        sendFrame(0xA, frame.payload);
        continue;
      }
      if (frame.opcode === 0xA) continue;
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        fragmentedOpcode = frame.opcode;
        fragments = [frame.payload];
      } else if (frame.opcode === 0x0 && fragmentedOpcode !== null) {
        fragments.push(frame.payload);
      } else {
        onError(new Error("CODEX_INVALID_RESPONSE"));
        return;
      }
      if (frame.fin) {
        const payload = Buffer.concat(fragments);
        const opcode = fragmentedOpcode;
        fragmentedOpcode = null;
        fragments = [];
        if (opcode === 0x1) deliverText(payload);
      }
    }
  };

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (!upgraded) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const response = buffer.subarray(0, headerEnd).toString("utf8");
      buffer = buffer.subarray(headerEnd + 4);
      const accept = response.match(/^sec-websocket-accept:\s*(.+)$/im)?.[1]?.trim();
      if (!/^HTTP\/1\.[01] 101\b/.test(response) || accept !== expectedAccept) {
        onError(new Error("CODEX_WEBSOCKET_HANDSHAKE_FAILED"));
        return;
      }
      upgraded = true;
      for (const message of queued.splice(0)) sendFrame(0x1, message);
    }
    processFrames();
  });
  child.stdin.write(
    `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );

  return {
    send(message) {
      const payload = JSON.stringify(message);
      if (upgraded) sendFrame(0x1, payload);
      else queued.push(payload);
    }
  };
}

function encodeWebSocketFrame(opcode, payload) {
  const mask = randomBytes(4);
  const length = payload.length;
  const extendedLengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const frame = Buffer.alloc(2 + extendedLengthBytes + 4 + length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (extendedLengthBytes === 0 ? length : extendedLengthBytes === 2 ? 126 : 127);
  let offset = 2;
  if (extendedLengthBytes === 2) {
    frame.writeUInt16BE(length, offset);
    offset += 2;
  } else if (extendedLengthBytes === 8) {
    frame.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }
  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < length; index += 1) {
    frame[offset + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function readWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const longLength = buffer.readBigUInt64BE(offset);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("CODEX_INVALID_RESPONSE");
    }
    length = Number(longLength);
    offset += 8;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskBytes;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { fin, opcode, payload, bytesConsumed: offset + length };
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
  if (/CODEX_RPC_ERROR|CODEX_INVALID_RESPONSE|CODEX_APP_SERVER_(EXITED|CLOSED)|CODEX_WEBSOCKET_HANDSHAKE_FAILED/.test(message)) {
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
  if (command === "doctor") {
    const result = await inspectCodexDaemon();
    process.stdout.write(`Codex app-server 可用，thread/list 返回 ${result.threadCount} 条。\n`);
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
