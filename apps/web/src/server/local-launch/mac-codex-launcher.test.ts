import { describe, expect, it } from "vitest";

import {
  MacCodexLauncher,
  MacCodexLauncherError,
  type ProcessRunner
} from "./mac-codex-launcher";

class FakeRunner implements ProcessRunner {
  calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  failCommand?: string;

  async run(command: string, args: string[], stdin?: string): Promise<void> {
    this.calls.push({ command, args, stdin });
    if (command === this.failCommand) {
      throw new Error("failed");
    }
  }
}

describe("MacCodexLauncher", () => {
  it("copies via stdin, opens Codex, and pastes with fixed AppleScript", async () => {
    const runner = new FakeRunner();
    const prompt = "飞书任务：不要出现在命令参数里";

    await expect(new MacCodexLauncher(runner).launch(prompt)).resolves.toEqual({
      opened: true,
      pasted: true,
      fallback: "none"
    });
    expect(runner.calls.map(({ command }) => command)).toEqual([
      "pbcopy",
      "open",
      "osascript"
    ]);
    expect(runner.calls[0]).toEqual({ command: "pbcopy", args: [], stdin: prompt });
    expect(runner.calls[1]).toEqual({ command: "open", args: ["-a", "Codex"] });
    expect(runner.calls[2]?.args.join(" ")).not.toContain(prompt);
    expect(runner.calls[2]?.args.join(" ")).toContain("command down");
  });

  it("falls back to manual paste only when AppleScript fails", async () => {
    const runner = new FakeRunner();
    runner.failCommand = "osascript";
    await expect(new MacCodexLauncher(runner).launch("prompt")).resolves.toEqual({
      opened: true,
      pasted: false,
      fallback: "manual_paste"
    });
  });

  it.each(["pbcopy", "open"])("returns a controlled error when %s fails", async (command) => {
    const runner = new FakeRunner();
    runner.failCommand = command;
    await expect(new MacCodexLauncher(runner).launch("prompt")).rejects.toBeInstanceOf(
      MacCodexLauncherError
    );
  });

  it("rejects prompts over 32 KiB before spawning", async () => {
    const runner = new FakeRunner();
    await expect(
      new MacCodexLauncher(runner).launch("界".repeat(11_000))
    ).rejects.toMatchObject({ code: "PROMPT_TOO_LARGE" });
    expect(runner.calls).toEqual([]);
  });
});
