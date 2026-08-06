#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "0.1.0";
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "auto-ux", "agent.json");
const PASTE_AND_SEND_SCRIPT = [
  'tell application "Codex" to activate',
  "delay 0.8",
  'tell application "System Events"',
  '  keystroke "n" using {command down}',
  "  delay 0.5",
  '  keystroke "v" using {command down}',
  "  delay 0.2",
  "  key code 36",
  "end tell"
].join("\n");

export async function deliverTask(task, dependencies) {
  const setStatus = dependencies.setStatus;
  if (!(await dependencies.fileExists(task.phoneFilePath))) {
    await setStatus("failed", "PHONE_FILE_NOT_FOUND");
    return "failed";
  }
  try {
    await dependencies.copyPrompt(task.prompt);
  } catch {
    await setStatus("failed", "CLIPBOARD_FAILED");
    return "failed";
  }
  try {
    await dependencies.openCodex();
  } catch {
    await setStatus("failed", "CODEX_OPEN_FAILED");
    return "failed";
  }
  await setStatus("codex_opened");
  try {
    await dependencies.pasteAndSend();
  } catch {
    await setStatus("failed", "CODEX_SEND_FAILED");
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
    copyPrompt: overrides.copyPrompt ?? copyPrompt,
    openCodex: overrides.openCodex ?? openCodex,
    pasteAndSend: overrides.pasteAndSend ?? pasteAndSend,
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

async function copyPrompt(prompt) {
  await runCommand("/usr/bin/pbcopy", [], prompt);
}

async function openCodex() {
  await runCommand("/usr/bin/open", ["-a", "Codex"]);
}

async function pasteAndSend() {
  await runCommand("/usr/bin/osascript", ["-e", PASTE_AND_SEND_SCRIPT]);
}

function runCommand(command, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"]
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? "unknown"}`))
    );
    if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
  });
}

async function writeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("HTTPS_REQUIRED");
  }
  return url.origin;
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
