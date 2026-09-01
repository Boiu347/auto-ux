import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { deliverTask, normalizeBaseUrl, pollOnce, startCodexTask } from "./mac-agent.mjs";

const task = {
  id: "Task_1",
  claimToken: `task_claim:${"a".repeat(64)}`,
  prompt: "Use the skill",
  phoneFilePath: "/Users/demo/phones.xlsx"
};

test("deliverTask opens Codex and starts a task without clipboard or keystrokes", async () => {
  const calls = [];
  const result = await deliverTask(task, {
    fileExists: async () => true,
    openCodex: async (workspace) => calls.push(["open", workspace]),
    startCodexTask: async (prompt, workspace) => calls.push(["start", prompt, workspace]),
    setStatus: async (status) => calls.push(["status", status])
  });

  assert.equal(result, "prompt_sent");
  assert.deepEqual(calls, [
    ["open", "/Users/demo"],
    ["status", "codex_opened"],
    ["start", "Use the skill", "/Users/demo"],
    ["status", "prompt_sent"]
  ]);
});

test("deliverTask reports a missing local number file without opening Codex", async () => {
  const calls = [];
  const result = await deliverTask(task, {
    fileExists: async () => false,
    openCodex: async () => calls.push(["open"]),
    startCodexTask: async () => calls.push(["start"]),
    setStatus: async (status, errorCode) =>
      calls.push(["status", status, errorCode])
  });

  assert.equal(result, "failed");
  assert.deepEqual(calls, [["status", "failed", "PHONE_FILE_NOT_FOUND"]]);
});

test("deliverTask reports app-server failure without requesting Mac permissions", async () => {
  const calls = [];
  const result = await deliverTask(task, {
    fileExists: async () => true,
    openCodex: async () => calls.push(["open"]),
    startCodexTask: async () => {
      calls.push(["start"]);
      throw new Error("CODEX_RPC_ERROR:-32601");
    },
    setStatus: async (status, errorCode) => calls.push(["status", status, errorCode])
  });

  assert.equal(result, "failed");
  assert.deepEqual(calls, [
    ["open"],
    ["status", "codex_opened", undefined],
    ["start"],
    ["status", "failed", "CODEX_APP_SERVER_FAILED"]
  ]);
});

test("pollOnce treats an empty queue as healthy idle state", async () => {
  const request = async () => new Response(null, { status: 204 });
  assert.equal(
    await pollOnce(
      { apiBaseUrl: "https://auto-ux.example", deviceToken: `device_token:${"b".repeat(64)}` },
      { request }
    ),
    "idle"
  );
});

test("startCodexTask uses the managed daemon proxy and starts one turn", async () => {
  const messages = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0);
  child.unref = () => undefined;
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (line) => {
    const message = JSON.parse(line.trim());
    messages.push(message);
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
    } else if (message.method === "thread/start") {
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } })}\n`);
    } else if (message.method === "turn/start") {
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } })}\n`);
    }
  });
  const spawned = [];
  const daemon = [];

  const result = await startCodexTask("Use the skill", "/Users/demo", {
    codexPath: "/usr/local/bin/codex",
    ensureDaemon: async (command) => daemon.push(command),
    spawnProcess: (command, args) => {
      spawned.push([command, args]);
      return child;
    }
  });

  assert.deepEqual(result, { threadId: "thread-1" });
  assert.deepEqual(daemon, ["/usr/local/bin/codex"]);
  assert.deepEqual(spawned, [["/usr/local/bin/codex", ["app-server", "proxy"]]]);
  assert.deepEqual(messages.map(({ method }) => method), [
    "initialize", "initialized", "thread/start", "turn/start"
  ]);
  assert.equal(messages.at(-1).params.input[0].text, "Use the skill");
});

test("normalizeBaseUrl preserves the production base path", () => {
  assert.equal(
    normalizeBaseUrl("http://118.196.147.13/auto-ux/"),
    "http://118.196.147.13/auto-ux"
  );
  assert.equal(
    normalizeBaseUrl("https://auto-ux.example/auto-ux/"),
    "https://auto-ux.example/auto-ux"
  );
});

test("normalizeBaseUrl rejects unapproved plaintext hosts", () => {
  assert.throws(() => normalizeBaseUrl("http://auto-ux.example/auto-ux"), /HTTPS_REQUIRED/);
});

test("installer installs both the Mac helper and the Codex skill", async () => {
  const installer = await readFile(new URL("./install-mac-agent.sh", import.meta.url), "utf8");
  assert.match(installer, /\.codex\/skills\/baidu-cloud-one-click-config/);
  assert.match(installer, /SOURCE_ARCHIVE_URL/);
  assert.match(installer, /118\\\.196\\\.147\\\.13/);
  assert.match(installer, /API_BASE_URL%\/.*downloads/);
  assert.doesNotMatch(installer, /github\.com|githubusercontent\.com/);
  assert.doesNotMatch(installer, /\$\{PAIRING_CODE\^\^\}/);
  assert.match(installer, /tr '\[:lower:\]' '\[:upper:\]'/);
  assert.match(installer, /codex app-server daemon bootstrap/);
  assert.match(installer, /codex app-server daemon start/);
  assert.match(installer, /已复用现有 Mac 助手配对/);
  assert.match(installer, /config\.deviceToken/);
});

test("Mac delivery uses structured Codex RPC and no paste automation", async () => {
  const source = await readFile(new URL("./mac-agent.mjs", import.meta.url), "utf8");
  assert.match(source, /"thread\/start"/);
  assert.match(source, /"turn\/start"/);
  assert.match(source, /\["app-server", "proxy"\]/);
  assert.match(source, /\["app-server", "daemon", "start"\]/);
  assert.doesNotMatch(source, /pbcopy|osascript|keystroke|clipboard/i);
});
