import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { deliverTask, normalizeBaseUrl, pollOnce } from "./mac-agent.mjs";

const task = {
  id: "Task_1",
  claimToken: `task_claim:${"a".repeat(64)}`,
  prompt: "Use the skill",
  phoneFilePath: "/Users/demo/phones.xlsx"
};

test("deliverTask opens Codex before pasting and automatically sending", async () => {
  const calls = [];
  const result = await deliverTask(task, {
    fileExists: async () => true,
    copyPrompt: async (prompt) => calls.push(["copy", prompt]),
    openCodex: async () => calls.push(["open"]),
    pasteAndSend: async () => calls.push(["send"]),
    setStatus: async (status) => calls.push(["status", status])
  });

  assert.equal(result, "prompt_sent");
  assert.deepEqual(calls, [
    ["copy", "Use the skill"],
    ["open"],
    ["status", "codex_opened"],
    ["send"],
    ["status", "prompt_sent"]
  ]);
});

test("deliverTask reports a missing local number file without opening Codex", async () => {
  const calls = [];
  const result = await deliverTask(task, {
    fileExists: async () => false,
    copyPrompt: async () => calls.push(["copy"]),
    openCodex: async () => calls.push(["open"]),
    pasteAndSend: async () => calls.push(["send"]),
    setStatus: async (status, errorCode) =>
      calls.push(["status", status, errorCode])
  });

  assert.equal(result, "failed");
  assert.deepEqual(calls, [["status", "failed", "PHONE_FILE_NOT_FOUND"]]);
});

test("deliverTask opens Accessibility settings and retries after permission is granted", async () => {
  const calls = [];
  let attempts = 0;
  const result = await deliverTask(task, {
    fileExists: async () => true,
    copyPrompt: async () => calls.push(["copy"]),
    openCodex: async () => calls.push(["open"]),
    pasteAndSend: async () => {
      calls.push(["send"]);
      attempts += 1;
      if (attempts === 1) {
        throw new Error("osascript is not allowed to send keystrokes. (-1743)");
      }
    },
    requestAccessibility: async () => calls.push(["permission"]),
    sleep: async () => calls.push(["wait"]),
    setStatus: async (status, errorCode) => calls.push(["status", status, errorCode])
  });

  assert.equal(result, "prompt_sent");
  assert.deepEqual(calls, [
    ["copy"],
    ["open"],
    ["status", "codex_opened", undefined],
    ["send"],
    ["status", "waiting_permission", "MAC_ACCESSIBILITY_REQUIRED"],
    ["permission"],
    ["wait"],
    ["send"],
    ["status", "prompt_sent", undefined]
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
});
