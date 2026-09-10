import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopWindowsCodexProcess, windowsCodexCommand } from "../src/adapters/codex-windows-process.js";

const roots: string[] = [];
function temp() {
  const root = mkdtempSync(path.join(os.tmpdir(), "prospero codex launcher "));
  roots.push(root);
  return root;
}
function file(name: string, value = "") {
  mkdirSync(path.dirname(name), { recursive: true });
  writeFileSync(name, value);
  return name;
}
function install(base: string, arch = "x64", layout = "modern") {
  const root = path.join(base, "node_modules", "@openai", "codex");
  file(path.join(base, "codex.cmd"), '@ECHO off\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n');
  file(path.join(root, "bin", "codex.js"), "// Synthetic official launcher");
  file(path.join(root, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  const nativeRoot = layout === "modern" ? path.join(root, "node_modules", "@openai", `codex-win32-${arch}`) : root;
  if (layout === "modern") file(path.join(nativeRoot, "package.json"), JSON.stringify({ name: `@openai/codex-win32-${arch}` }));
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const vendor = path.join(nativeRoot, "vendor", target);
  const exe = file(path.join(vendor, layout === "modern" ? "bin" : "codex", "codex.exe"));
  return { root, exe, vendor };
}

afterEach(() => {
  vi.useRealTimers();
  // Only directories created by this fixture; never installed Codex or user data.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Windows Codex executable selection", () => {
  it.each(["x64", "arm64"])("resolves the official %s native package through a spaced npm prefix", (arch) => {
    const base = temp();
    const pkg = install(base, arch);
    const env = { Path: `"${base}"`, CODEX_HOME: "selected-account" };
    const result = windowsCodexCommand(env, base, arch as NodeJS.Architecture);
    expect(result.file).toBe(pkg.exe);
    expect(result.env).toMatchObject({ CODEX_HOME: "selected-account", CODEX_MANAGED_PACKAGE_ROOT: pkg.root });
    expect(env).not.toHaveProperty("CODEX_MANAGED_PACKAGE_ROOT");
  });

  it("supports older bundled vendor layout and preserves its helper PATH", () => {
    const base = temp();
    const pkg = install(base, "x64", "legacy");
    const helpers = path.join(pkg.vendor, "path");
    file(path.join(helpers, "rg.exe"));
    const env = { Path: base };
    const result = windowsCodexCommand(env, base, "x64");
    expect(result.file).toBe(pkg.exe);
    expect(result.env.Path).toBe(`${helpers};${base}`);
    expect(env.Path).toBe(base);
  });

  it("resolves pnpm's relative node_modules/.bin launcher", () => {
    const base = temp();
    const pkg = install(base);
    const bin = path.join(base, "node_modules", ".bin");
    file(path.join(bin, "codex.cmd"), '@ECHO off\n"%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\n');
    expect(windowsCodexCommand({ PATH: bin }, bin, "x64").file).toBe(pkg.exe);
  });

  it("honors the first PATH shim instead of choosing an unrelated native installation", () => {
    const base = temp();
    const first = path.join(base, "custom");
    const second = path.join(base, "official");
    const shim = file(path.join(first, "codex.cmd"), "@echo custom wrapper\n");
    install(second);
    expect(windowsCodexCommand({ PATH: `${first};${second}` }, base, "x64").file).toBe(shim);
  });

  it("keeps Windows cwd precedence and explicit PATHEXT ordering", () => {
    const base = temp();
    const elsewhere = path.join(base, "installed");
    install(elsewhere);
    const shim = file(path.join(base, "codex.cmd"), "@echo custom\n");
    const exe = file(path.join(base, "codex.exe"));
    expect(windowsCodexCommand({ PATH: elsewhere, PATHEXT: ".CMD;.EXE" }, base).file).toBe(shim);
    expect(windowsCodexCommand({ PATH: elsewhere, PATHEXT: ".EXE;.CMD" }, base).file).toBe(exe);
  });

  it("keeps a standalone exe and selected account environment", () => {
    const base = temp();
    const exe = file(path.join(base, "codex.exe"));
    const env = { PATH: base, CODEX_HOME: "isolated" };
    expect(windowsCodexCommand(env, base)).toEqual({ file: exe, env });
  });

  it("falls back to the selected npm shim when the native dependency is absent", () => {
    const base = temp();
    const pkg = install(base);
    rmSync(pkg.exe);
    const env = { PATH: base };
    expect(windowsCodexCommand(env, base, "x64")).toEqual({ file: path.join(base, "codex.cmd"), env });
  });

  it("does not bypass a launcher for an unrecognized package", () => {
    const base = temp();
    const pkg = install(base);
    file(path.join(pkg.root, "package.json"), JSON.stringify({ name: "custom-codex" }));
    expect(windowsCodexCommand({ PATH: base }, base).file).toBe(path.join(base, "codex.cmd"));
  });

  it("keeps a customized npm wrapper that adds CLI arguments", () => {
    const base = temp();
    install(base);
    const shim = file(path.join(base, "codex.cmd"), '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" --profile custom %*\n');
    expect(windowsCodexCommand({ PATH: base }, base).file).toBe(shim);
  });

  it("preserves the normal command-not-found path when Codex is missing", () => {
    const base = temp();
    const env = { PATH: base };
    expect(windowsCodexCommand(env, base)).toEqual({ file: "codex", env });
  });
});

describe("Windows app-server shutdown", () => {
  function child() {
    const proc = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const kill = vi.fn(() => { proc.emit("exit", null, "SIGTERM"); return true; });
    Object.assign(proc, { pid: 42, exitCode: null, signalCode: null, stdin, kill });
    return { proc, stdin, kill };
  }

  it("sends EOF and waits for exit without forcing a healthy app-server", async () => {
    const f = child();
    const stop = stopWindowsCodexProcess(f.proc);
    expect(f.stdin.writableEnded).toBe(true);
    f.proc.emit("exit", 0, null);
    await stop;
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.proc.listenerCount("exit")).toBe(0);
  });

  it("bounds a hung shutdown, kills only once, and shares cleanup across callers", async () => {
    vi.useFakeTimers();
    const f = child();
    const stop = stopWindowsCodexProcess(f.proc);
    expect(stopWindowsCodexProcess(f.proc)).toBe(stop);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(f.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stop;
    expect(f.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes even if force-kill cannot emit exit", async () => {
    vi.useFakeTimers();
    const f = child();
    f.kill.mockImplementation(() => { throw new Error("synthetic kill error"); });
    const stop = stopWindowsCodexProcess(f.proc);
    await vi.advanceTimersByTimeAsync(2_000);
    await stop;
    expect(f.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not kill an exited process or a failed spawn without a PID", async () => {
    for (const fields of [{ exitCode: 1 }, { pid: undefined }]) {
      const f = child();
      Object.assign(f.proc, fields);
      await stopWindowsCodexProcess(f.proc);
      expect(f.kill).not.toHaveBeenCalled();
      expect(f.stdin.writableEnded).toBe(false);
    }
  });
});
