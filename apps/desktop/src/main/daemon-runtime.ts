import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { app } from "electron";
import { loginPath, resolveNodeExecutable } from "./host-environment.js";
import type { JsonObject } from "../shared/types";
import { StateStore } from "./state-store";

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

export class DaemonRuntime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  private restarting = false;

  constructor(private readonly store: StateStore) {}

  get managed(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.store.snapshot().daemon.running || this.managed) return { ok: true };
    this.store.setStartupProgress(6, "检查 daemon 运行环境");
    const runtime = this.locateRuntime();
    if (!runtime) {
      // 开发模式下有两种失败原因,别都说成"没构建 daemon":GUI 进程的 PATH 里
      // 常常根本没有 node,那是完全不同的一件事,提示错了会让人白查半天。
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
    const args = [runtime.cli, "start", "--port", String(snapshot.daemon.port)];
    const runtimePath = loginPath(runtime.node);
    // 用户在设置里挑的网卡优先;没挑过就沿用 daemon 自己配置里的值。
    const bind = snapshot.settings.daemonBind !== "0.0.0.0" ? snapshot.settings.daemonBind : snapshot.daemon.bind;
    if (bind && bind !== "0.0.0.0") args.push("--bind", bind);
    const child = spawn(runtime.node, args, {
      cwd: runtime.cwd,
      env: {
        ...process.env,
        PROSPERO_HOME: this.store.home,
        // daemon 要靠这份 PATH 去找 claude/codex/opencode 等 CLI。GUI 进程继承到的
        // 是极简 PATH,不补这一步,Mac 上所有 Agent 都会"找不到可执行文件"。
        ...(runtimePath ? { PATH: runtimePath } : {}),
      },
      windowsHide: true,
      stdio: "pipe",
    });
    this.child = child;
    this.store.setStartupProgress(32, "daemon 进程已启动", child.pid);
    let launchPending = true;
    let launchError: string | undefined;
    const reportUnexpectedTermination = (): void => {
      if (launchPending || this.restarting || this.stopping || this.store.snapshot().daemon.running) return;
      this.store.setManagedState(undefined, false, launchError);
    };
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

    const ready = await this.waitUntilReady(30_000, (progress, stage) => {
      this.store.setStartupProgress(progress, stage, child.pid);
    });
    launchPending = false;
    if (!ready) {
      const error = launchError ?? "daemon 启动超时，请查看日志";
      this.store.setManagedState(child.exitCode === null ? child.pid : undefined, false, error);
      return { ok: false, error };
    }
    const daemonPid = this.store.snapshot().daemon.pid ?? (child.exitCode === null ? child.pid : undefined);
    this.store.setStartupProgress(100, "daemon 已就绪", daemonPid);
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
    this.store.setManagedState(daemonPid, false);
    return { ok: true };
  }

  async stop(): Promise<{ ok: boolean; error?: string }> {
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

  async request(path: string, init?: { method?: "GET" | "POST"; body?: JsonObject }): Promise<JsonObject | null> {
    const { port, token } = this.store.controlCredentials();
    const request: RequestInit = {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(path.includes("waitMs=") ? 30_000 : 18_000),
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

  /** 自检用:只回报定位到的 daemon 入口,不启动任何东西。 */
  describeRuntime(): string | undefined {
    return this.locateRuntime()?.cli;
  }

  private locateRuntime(): { node: string; cli: string; cwd: string } | undefined {
    if (app.isPackaged) {
      const runtime = resolve(process.resourcesPath, "runtime");
      const node = resolve(runtime, "node", process.platform === "win32" ? "node.exe" : "node");
      const cli = resolve(runtime, "daemon", "dist", "cli.js");
      return existsSync(node) && existsSync(cli) ? { node, cli, cwd: runtime } : undefined;
    }
    const root = findRepositoryRoot(app.getAppPath()) ?? findRepositoryRoot(process.cwd());
    if (!root) return undefined;
    const cli = resolve(root, "apps", "daemon", "dist", "cli.js");
    // 从 Dock/Finder 启动时 PATH 里没有 mise/nvm 装的 node,"node" 这个名字解析不出来。
    const node = resolveNodeExecutable();
    if (!node) return undefined;
    return { node, cli, cwd: root };
  }
}
