import { describe, expect, it } from "vitest";
import {
  commandFor,
  defaultKindFor,
  noopCommand,
  programCommandFor,
  shellFor,
  spawnEnv,
} from "../src/agents.js";

function decodedWindowsArgv(spec: { file: string; args: string[] }): string[] {
  const encodedScript = spec.args.at(-1);
  expect(encodedScript).toBeTruthy();
  const script = Buffer.from(encodedScript ?? "", "base64").toString("utf16le");
  const payload = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  expect(payload).toBeTruthy();
  return JSON.parse(Buffer.from(payload ?? "", "base64").toString("utf8")) as string[];
}

describe("PTY agent startup commands", () => {
  it("starts Codex with approvals and sandboxing bypassed", () => {
    expect(commandFor("codex", undefined, "linux")).toEqual({
      file: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
    });
  });

  it("starts Claude with permission checks skipped", () => {
    expect(commandFor("claude", undefined, "linux")).toEqual({
      file: "claude",
      args: ["--dangerously-skip-permissions"],
    });
  });

  it("routes DeepSeek Harness through its structured web API", () => {
    expect(() => commandFor("deepseek", undefined, "linux")).toThrow("structured");
    expect(defaultKindFor("deepseek")).toBe("structured");
  });

  it("does not add agent bypass flags to Shell or custom commands", () => {
    const env = { SHELL: "/bin/zsh" };
    expect(commandFor("shell", undefined, "linux", env).args).toEqual(["-il"]);
    expect(commandFor("custom", "printf hello", "linux", env)).toEqual({
      file: "/bin/zsh",
      args: ["-c", "printf hello"],
    });
  });

  it("uses COMSPEC for Windows shell sessions and custom commands", () => {
    const env = { COMSPEC: "C:\\Windows\\System32\\cmd.exe" };
    expect(shellFor("win32", env)).toEqual({
      file: env.COMSPEC,
      args: ["/d"],
    });
    expect(commandFor("custom", "echo hello", "win32", env)).toEqual({
      file: env.COMSPEC,
      args: ["/d", "/s", "/c", "echo hello"],
    });
  });

  it("runs Windows Agent CLI shims through an encoded PowerShell argv", () => {
    const env = { COMSPEC: "C:\\Windows\\System32\\cmd.exe" };
    const login = programCommandFor("codex", ["login", "status"], "win32", env);
    expect(login.file).toBe("powershell.exe");
    expect(login.args.slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-EncodedCommand"]);
    expect(decodedWindowsArgv(login)).toEqual(["codex", "login", "status"]);

    const session = commandFor("codex", undefined, "win32", env);
    expect(decodedWindowsArgv(session)).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(() => commandFor("deepseek", undefined, "win32", env)).toThrow("structured");
  });

  it("preserves dynamic Windows arguments without interpreting shell syntax", () => {
    const spec = commandFor(
      "codex",
      undefined,
      "win32",
      { COMSPEC: "cmd.exe" },
      ["-c", 'model_provider="prospero"', "-c", 'model="foo & whoami"'],
    );
    expect(decodedWindowsArgv(spec)).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_provider="prospero"',
      "-c",
      'model="foo & whoami"',
    ]);
  });

  it("refuses NUL bytes that Windows cannot represent in argv", () => {
    expect(() => programCommandFor("codex", ["bad\0arg"], "win32")).toThrow("NUL");
  });

  it("uses PowerShell argument rules when Windows is configured for PowerShell", () => {
    const env = { COMSPEC: "pwsh.exe" };
    expect(commandFor("custom", "Write-Output hello", "win32", env)).toEqual({
      file: "pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", "Write-Output hello"],
    });
    const agent = programCommandFor("claude", ["auth", "login"], "win32", env);
    expect(agent.file).toBe("pwsh.exe");
    expect(decodedWindowsArgv(agent)).toEqual(["claude", "auth", "login"]);
  });

  it("has a portable no-op command for PTY attach fallbacks", () => {
    expect(noopCommand()).toEqual({ file: process.execPath, args: ["-e", ""] });
  });

  it("advertises truecolor and removes inherited no-color flags for interactive PTYs", () => {
    const previousNoColor = process.env["NO_COLOR"];
    const previousForceColor = process.env["FORCE_COLOR"];
    try {
      process.env["NO_COLOR"] = "1";
      process.env["FORCE_COLOR"] = "0";
      const env = spawnEnv({
        TERM: "dumb",
        COLORTERM: "",
        CLICOLOR: "0",
        TERM_PROGRAM: "unknown",
      });
      expect(env["NO_COLOR"]).toBeUndefined();
      expect(env["FORCE_COLOR"]).toBeUndefined();
      expect(env["TERM"]).toBe("xterm-256color");
      expect(env["COLORTERM"]).toBe("truecolor");
      expect(env["CLICOLOR"]).toBe("1");
      expect(env["TERM_PROGRAM"]).toBe("Prospero");
    } finally {
      if (previousNoColor === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = previousNoColor;
      if (previousForceColor === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = previousForceColor;
    }
  });
});
