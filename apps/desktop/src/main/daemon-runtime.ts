import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { app } from "electron";
import { loginPath, resolveNodeExecutable } from "./host-environment.js";
import type { JsonObject } from "../shared/types";
import { StateStore } from "./state-store";

const DAEMON_START_TIMEOUT_MS = 90_000;

function findRepositoryRoot(start: string): string | undefined {
  let current = resolve(start);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(resolve(current, "apps", "daemon", "dist", "cli.js"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function quoteWindowsArgument(value: string): string {
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += `${"\\".repeat(backslashes * 2 + 1)}"`;
    } else {
      result += `${"\\".repeat(backslashes)}${character}`;
    }
    backslashes = 0;
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export class DaemonRuntime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private elevatedManaged = false;
  private stopping = false;
  private restarting = false;

  constructor(private readonly store: StateStore) {}

  get managed(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null) || (this.elevatedManaged && this.store.snapshot().daemon.managed);
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.store.snapshot().daemon.running || this.managed) return { ok: true };
    this.store.setStartupProgress(6, "检查 daemon 运行环境");
    const runtime = this.locateRuntime();
    if (!runtime) {
      const error = app.isPackaged
        ? "安装包缺少 daemon 运行时，请重新安装 Prospero"
        : resolveNodeExecutable()
          ? "请先构建 daemon：npm run build -w @prospero/daemon"
          : "找不到 node。安装 Node 22+，或用 PROSPERO_NODE 环境变量指定解释器路径。";
      this.store.setManagedState(undefined, false, error);
      return { ok: false, error };
    }

    this.stopping = false;
    this.store.setStartupProgress(18, "准备本地控制服务");
    const snapshot = this.store.snapshot();
    const fullAccess = process.platform === "win32" && snapshot.settings.fullAccessPermission;
    const args = [runtime.cli, "start", "--home", this.store.home, "--port", String(snapshot.daemon.port)];
    // SwiftUI Shell 在 macOS 上始终请求 tmux 托管：滚轮 copy-mode、完整
    // 历史和 daemon 重启后的进程语义都依赖这层。daemon 会在 tmux 缺失时
    // 自动退回 detached PTY supervisor，不把它变成 Electron 启动硬依赖。
    if (process.platform === "darwin") args.push("--tmux");
    const bind = snapshot.settings.daemonBind !== "0.0.0.0" ? snapshot.settings.daemonBind : snapshot.daemon.bind;
    if (bind && bind !== "0.0.0.0") args.push("--bind", bind);
    if (fullAccess) args.push("--full-access");
    let launchedPid: number | undefined;
    let launchPending = true;
    let launchError: string | undefined;
    const reportUnexpectedTermination = (): void => {
      if (launchPending || this.restarting || this.stopping || this.store.snapshot().daemon.running) return;
      this.store.setManagedState(undefined, false, launchError);
    };
    if (fullAccess) {
      try {
        this.store.setStartupProgress(24, "等待 Windows 管理员授权");
        const elevatedPid = await this.launchElevated(runtime, args);
        launchedPid = elevatedPid;
        this.elevatedManaged = true;
        this.store.setStartupProgress(32, "管理员 daemon 进程已启动", elevatedPid);
      } catch (reason) {
        const error = reason instanceof Error ? reason.message : String(reason);
        this.elevatedManaged = false;
        this.store.setManagedState(undefined, false, error);
        return { ok: false, error };
      }
    } else {
      const child = spawn(runtime.node, args, {
        cwd: runtime.cwd,
        env: {
          ...process.env,
          PROSPERO_HOME: this.store.home,
          ...(loginPath(runtime.node) ? { PATH: loginPath(runtime.node) as string } : {}),
        },
        windowsHide: true,
        stdio: "pipe",
      });
      this.child = child;
      launchedPid = child.pid;
      this.store.setStartupProgress(32, "daemon 进程已启动", child.pid);
      child.stdout.on("data", (chunk: Buffer) => this.store.appendLog(chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => this.store.appendLog(chunk.toString("utf8")));
      child.once("error", (error) => {
        if (this.child === child) this.child = undefined;
        launchError = error.message;
        reportUnexpectedTermination();
      });
      child.once("exit", (code) => {
        if (this.child === child) this.child = undefined;
        if (!this.restarting && !this.stopping && code !== 0) launchError = `daemon 已退出（${String(code)}）`;
        reportUnexpectedTermination();
      });
    }

    const ready = await this.waitUntilReady(DAEMON_START_TIMEOUT_MS, (progress, stage) => {
      this.store.setStartupProgress(progress, stage, launchedPid);
    });
    launchPending = false;
    if (!ready) {
      const error = launchError ?? "daemon 启动超时，请查看日志";
      this.store.setManagedState(this.child?.exitCode === null ? this.child.pid : undefined, false, error);
      return { ok: false, error };
    }
    const daemonPid = this.store.snapshot().daemon.pid ?? launchedPid;
    this.store.setStartupProgress(100, "daemon 已就绪", daemonPid);
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
    this.store.setManagedState(daemonPid, false);
    return { ok: true };
  }

  async stop(): Promise<{ ok: boolean; error?: string }> {
    if (this.elevatedManaged && this.store.snapshot().daemon.running) {
      this.stopping = true;
      try {
        await this.request("/_prospero/control/shutdown", { method: "POST" });
        const stopped = await this.waitUntilStopped(8_000);
        if (!stopped) return { ok: false, error: "管理员 daemon 停止超时" };
        this.elevatedManaged = false;
        this.store.setManagedState(undefined, this.restarting);
        return { ok: true };
      } catch (reason) {
        return { ok: false, error: reason instanceof Error ? reason.message : String(reason) };
      } finally {
        this.stopping = false;
      }
    }
    if (!this.managed || !this.child) {
      if (this.store.snapshot().daemon.running) return { ok: false, error: "daemon 由外部进程管理，桌面端不会强制结束它" };
      return { ok: true };
    }
    const child = this.child;
    this.stopping = true;
    child.kill("SIGTERM");
    const exited = await new Promise<boolean>((complete) => {
      const timer = setTimeout(() => complete(false), 8_000);
      child.once("exit", () => { clearTimeout(timer); complete(true); });
    });
    if (!exited && child.exitCode === null) child.kill("SIGKILL");
    this.child = undefined;
    this.store.setManagedState(undefined, this.restarting);
    return { ok: true };
  }

  async restart(): Promise<{ ok: boolean; error?: string }> {
    this.restarting = true;
    this.store.setManagedState(this.child?.pid, true);
    try {
      const stopped = await this.stop();
      if (!stopped.ok) {
        this.store.setManagedState(this.store.snapshot().daemon.pid, false);
        return stopped;
      }
      return await this.start();
    } finally {
      this.restarting = false;
    }
  }

  async runCli(args: string[]): Promise<{ code: number; output: string }> {
    const runtime = this.locateRuntime();
    if (!runtime) return { code: 1, output: "找不到 daemon 运行时" };
    return new Promise((complete) => {
      const child = spawn(runtime.node, [runtime.cli, ...args], {
        cwd: runtime.cwd,
        env: {
          ...process.env,
          PROSPERO_HOME: this.store.home,
          ...(loginPath(runtime.node) ? { PATH: loginPath(runtime.node) as string } : {}),
        },
        windowsHide: true,
        stdio: "pipe",
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.once("error", (error) => complete({ code: 1, output: error.message }));
      child.once("exit", (code) => complete({ code: code ?? 1, output }));
    });
  }

  async request(path: string, init?: { method?: "GET" | "POST"; body?: JsonObject; signal?: AbortSignal; timeoutMs?: number }): Promise<JsonObject | null> {
    const { port, token } = this.store.controlCredentials();
    const request: RequestInit = {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? (path.includes("waitMs=") ? 30_000 : 18_000))])
        : AbortSignal.timeout(init?.timeoutMs ?? (path.includes("waitMs=") ? 30_000 : 18_000)),
    };
    if (init?.body) request.body = JSON.stringify(init.body);
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, request);
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(text || `daemon 请求失败（${String(response.status)}）`);
    if (!text) return {};
    try { return JSON.parse(text) as JsonObject; } catch { return { output: text }; }
  }

  private async waitUntilReady(
    timeoutMs: number,
    onProgress: (progress: number, stage: string) => void,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    let lastProgress = 32;
    while (Date.now() < deadline) {
      try {
        const result = await this.request("/_prospero/control/health");
        if (result?.["ok"] === true) return true;
      } catch {
        // status.json/control token may not exist yet.
      }
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(94, 38 + Math.round((elapsed / timeoutMs) * 56));
      if (progress >= lastProgress + 3) {
        lastProgress = progress;
        onProgress(
          progress,
          progress < 62 ? "等待本地控制接口" : progress < 84 ? "加载会话状态" : "完成健康检查",
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 180));
    }
    return false;
  }

  private async waitUntilStopped(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.store.snapshot().daemon.running) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    }
    return !this.store.snapshot().daemon.running;
  }

  /** Self-check helper that reports the selected daemon entry without starting it. */
  describeRuntime(): string | undefined {
    return this.locateRuntime()?.cli;
  }

  private async launchElevated(
    runtime: { node: string; cli: string; cwd: string },
    args: string[],
  ): Promise<number> {
    const powershell = resolve(process.env["SystemRoot"] || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const argumentLine = args.map(quoteWindowsArgument).join(" ");
    const script = `$ErrorActionPreference='Stop'; $process = Start-Process -FilePath ${quotePowerShellLiteral(runtime.node)} -ArgumentList ${quotePowerShellLiteral(argumentLine)} -WorkingDirectory ${quotePowerShellLiteral(runtime.cwd)} -Verb RunAs -WindowStyle Hidden -PassThru; [Console]::Out.Write($process.Id)`;
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    return new Promise((complete, reject) => {
      const launcher = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
        cwd: runtime.cwd,
        windowsHide: true,
        stdio: "pipe",
      });
      let output = "";
      let errorOutput = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        launcher.kill();
        reject(new Error("等待 Windows 管理员授权超时"));
      }, 120_000);
      launcher.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      launcher.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
      launcher.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      launcher.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const pid = Number.parseInt(output.trim(), 10);
        if (code === 0 && Number.isInteger(pid) && pid > 0) complete(pid);
        else reject(new Error(errorOutput.trim() || "Windows 管理员授权已取消"));
      });
    });
  }

  private locateRuntime(): { node: string; cli: string; cwd: string } | undefined {
    if (app.isPackaged) {
      const runtime = resolve(process.resourcesPath, "runtime");
      const node = resolve(runtime, "node", process.platform === "win32" ? "node.exe" : "node");
      const candidates = [
        resolve(runtime, "node_modules", "@prospero", "daemon", "dist", "cli.js"),
        resolve(runtime, "daemon", "dist", "cli.js"),
      ];
      const cli = candidates.find((candidate) => existsSync(candidate));
      return existsSync(node) && cli ? { node, cli, cwd: runtime } : undefined;
    }
    const root = findRepositoryRoot(app.getAppPath()) ?? findRepositoryRoot(process.cwd());
    if (!root) return undefined;
    const cli = resolve(root, "apps", "daemon", "dist", "cli.js");
    const node = resolveNodeExecutable();
    if (!node) return undefined;
    return { node, cli, cwd: root };
  }
}
