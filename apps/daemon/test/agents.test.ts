import { describe, expect, it } from "vitest";
import { commandFor, noopCommand, programCommandFor, shellFor } from "../src/agents.js";

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

  it("runs Windows Agent CLI shims through COMSPEC", () => {
    const env = { COMSPEC: "C:\\Windows\\System32\\cmd.exe" };
    expect(programCommandFor("codex", ["login", "status"], "win32", env)).toEqual({
      file: env.COMSPEC,
      args: ["/d", "/s", "/c", "codex login status"],
    });
    expect(commandFor("codex", undefined, "win32", env)).toEqual({
      file: env.COMSPEC,
      args: [
        "/d",
        "/s",
        "/c",
        "codex --dangerously-bypass-approvals-and-sandbox",
      ],
    });
  });

  it("refuses unsafe dynamic values in Windows Agent command wrappers", () => {
    expect(() => programCommandFor("codex", ["status & whoami"], "win32")).toThrow(
      "不安全字符",
    );
  });

  it("uses PowerShell argument rules when Windows is configured for PowerShell", () => {
    const env = { COMSPEC: "pwsh.exe" };
    expect(commandFor("custom", "Write-Output hello", "win32", env)).toEqual({
      file: "pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", "Write-Output hello"],
    });
  });

  it("has a portable no-op command for PTY attach fallbacks", () => {
    expect(noopCommand()).toEqual({ file: process.execPath, args: ["-e", ""] });
  });
});
