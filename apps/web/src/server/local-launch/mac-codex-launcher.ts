import { spawn } from "node:child_process";

export interface ProcessRunner {
  run(command: string, args: string[], stdin?: string): Promise<void>;
}

export type MacCodexLaunchResult = {
  opened: true;
  pasted: boolean;
  fallback: "none" | "manual_paste";
};

export class MacCodexLauncherError extends Error {
  constructor(readonly code: "PROMPT_TOO_LARGE" | "CLIPBOARD_FAILED" | "OPEN_FAILED") {
    super(code);
  }
}

const MAX_PROMPT_BYTES = 32 * 1024;
const PASTE_SCRIPT = [
  'tell application "Codex" to activate',
  "delay 0.8",
  'tell application "System Events"',
  '  keystroke "v" using {command down}',
  "end tell"
].join("\n");

export class MacCodexLauncher {
  constructor(private readonly runner: ProcessRunner = new SpawnProcessRunner()) {}

  async launch(prompt: string): Promise<MacCodexLaunchResult> {
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw new MacCodexLauncherError("PROMPT_TOO_LARGE");
    }
    try {
      await this.runner.run("pbcopy", [], prompt);
    } catch {
      throw new MacCodexLauncherError("CLIPBOARD_FAILED");
    }
    try {
      await this.runner.run("open", ["-a", "Codex"]);
    } catch {
      throw new MacCodexLauncherError("OPEN_FAILED");
    }
    try {
      await this.runner.run("osascript", ["-e", PASTE_SCRIPT]);
      return { opened: true, pasted: true, fallback: "none" };
    } catch {
      return { opened: true, pasted: false, fallback: "manual_paste" };
    }
  }
}

class SpawnProcessRunner implements ProcessRunner {
  run(command: string, args: string[], stdin?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"]
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
        }
      });
      if (stdin !== undefined) {
        child.stdin?.end(stdin, "utf8");
      }
    });
  }
}
