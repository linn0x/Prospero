import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { ControlSocketError } from "../control-socket.js";
import { discoverProsperoPlugins, type PluginDiscoveryError } from "./discovery.js";
import type { PluginServiceManifest, ProsperoPluginManifest } from "./manifest.js";
import {
  PluginServiceStore,
  pluginServiceKey,
  type PluginServiceState,
  type PluginServiceStatus,
} from "./service-store.js";

export interface PluginServiceSupervisorOptions {
  home: string;
  daemonPort: number;
  controlTokenPath: string;
  controlSocketPath: string;
}

export interface PluginServiceView extends PluginServiceState {
  configured: boolean;
  pluginRoot: string | null;
  command: string[] | null;
  cwd: string | null;
  logFiles: { stdout: string; stderr: string };
}

interface Runtime {
  child: ChildProcess;
  plugin: ProsperoPluginManifest;
  service: PluginServiceManifest;
  port: number;
  startedAt: number;
  stopping: boolean;
  exit: Promise<void>;
}

function processAlive(pid: number | null): boolean {
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 1) return false;
  try {
    process.kill(pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processCommand(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1_000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function commandNeedles(service: PluginServiceManifest): string[] {
  const needles = new Set<string>();
  for (const part of service.command) {
    if (!path.isAbsolute(part)) continue;
    needles.add(part);
    try { needles.add(realpathSync(part)); } catch {}
  }
  return [...needles];
}

function processMatchesService(pid: number | null, service: PluginServiceManifest): boolean {
  if (!processAlive(pid)) return false;
  const command = processCommand(pid!);
  if (!command) return false;
  const needles = commandNeedles(service);
  return needles.length > 0 && needles.some((needle) => command.includes(needle));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error("failed to allocate plugin service port");
  return port;
}

function baseEnv(): Record<string, string> {
  const keep = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function withNow(state: Omit<PluginServiceState, "updatedAt">): PluginServiceState {
  return { ...state, updatedAt: Date.now() };
}

function statusFromState(state: PluginServiceState | null, plugin: ProsperoPluginManifest, service: PluginServiceManifest): PluginServiceState {
  if (state && state.configKey === service.configKey) {
    return state.status === "running" && !processMatchesService(state.pid, service)
      ? { ...state, status: "exited", pid: null, port: null, updatedAt: Date.now() }
      : state;
  }
  return withNow({
    pluginId: plugin.name,
    serviceId: service.id,
    mode: service.mode,
    status: "stopped",
    pid: null,
    port: null,
    startedAt: null,
    lastExit: null,
    lastError: null,
    health: "unknown",
    healthCheckedAt: null,
    healthError: null,
    configKey: service.configKey,
  });
}

function logFiles(root: string, pluginId: string, serviceId: string): { stdout: string; stderr: string } {
  const base = `${pluginId}.${serviceId}`;
  return {
    stdout: path.join(root, `${base}.out.log`),
    stderr: path.join(root, `${base}.err.log`),
  };
}

export class PluginServiceSupervisor {
  private readonly store: PluginServiceStore;
  private readonly running = new Map<string, Runtime>();
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: PluginServiceSupervisorOptions) {
    this.store = new PluginServiceStore(opts.home);
  }

  list(): { items: PluginServiceView[]; errors: PluginDiscoveryError[] } {
    const discovered = discoverProsperoPlugins(this.opts.home);
    const configured = new Set<string>();
    const items: PluginServiceView[] = [];
    for (const plugin of discovered.plugins) {
      for (const service of plugin.services) {
        const key = pluginServiceKey(plugin.name, service.id);
        configured.add(key);
        const state = statusFromState(this.store.get(plugin.name, service.id), plugin, service);
        if (state.status === "exited") this.store.update(state);
        items.push({
          ...state,
          configured: true,
          pluginRoot: plugin.root,
          command: [...service.command],
          cwd: service.cwd,
          logFiles: logFiles(this.store.logsRoot, plugin.name, service.id),
        });
      }
    }
    for (const state of this.store.list()) {
      if (configured.has(pluginServiceKey(state.pluginId, state.serviceId))) continue;
      items.push({
        ...state,
        configured: false,
        pluginRoot: null,
        command: null,
        cwd: null,
        logFiles: logFiles(this.store.logsRoot, state.pluginId, state.serviceId),
      });
    }
    return {
      items: items.sort((a, b) => pluginServiceKey(a.pluginId, a.serviceId).localeCompare(pluginServiceKey(b.pluginId, b.serviceId))),
      errors: discovered.errors,
    };
  }

  async startAuto(): Promise<void> {
    const discovered = discoverProsperoPlugins(this.opts.home);
    for (const plugin of discovered.plugins) {
      for (const service of plugin.services) {
        if (service.mode !== "auto") continue;
        try {
          await this.start(plugin.name, service.id);
        } catch (error) {
          const state = withNow({
            pluginId: plugin.name,
            serviceId: service.id,
            mode: service.mode,
            status: "failed",
            pid: null,
            port: null,
            startedAt: null,
            lastExit: null,
            lastError: error instanceof Error ? error.message : String(error),
            health: "unknown",
            healthCheckedAt: null,
            healthError: null,
            configKey: service.configKey,
          });
          this.store.update(state);
        }
      }
    }
  }

  async start(pluginId: string, serviceId: string): Promise<PluginServiceView> {
    return await this.serial(pluginId, serviceId, () => this.startUnlocked(pluginId, serviceId));
  }

  async stop(pluginId: string, serviceId: string): Promise<PluginServiceView> {
    return await this.serial(pluginId, serviceId, () => this.stopUnlocked(pluginId, serviceId));
  }

  async restart(pluginId: string, serviceId: string): Promise<PluginServiceView> {
    return await this.serial(pluginId, serviceId, async () => {
      await this.stopUnlocked(pluginId, serviceId);
      return await this.startUnlocked(pluginId, serviceId);
    });
  }

  private async startUnlocked(pluginId: string, serviceId: string): Promise<PluginServiceView> {
    const { plugin, service } = this.requireService(pluginId, serviceId);
    const key = pluginServiceKey(plugin.name, service.id);
    const current = this.running.get(key);
    if (current && current.child.exitCode === null && current.service.configKey === service.configKey) {
      return this.viewFor(plugin, service, this.store.get(plugin.name, service.id));
    }
    if (current) await this.stopRuntime(current);
    const existing = statusFromState(this.store.get(plugin.name, service.id), plugin, service);
    if (existing.status === "running" && existing.pid !== null && processMatchesService(existing.pid, service)) {
      this.store.update(existing);
      return this.viewFor(plugin, service, existing);
    }
    const port = await loopbackPort();
    const startedAt = Date.now();
    this.store.update(withNow({
      pluginId: plugin.name,
      serviceId: service.id,
      mode: service.mode,
      status: "starting",
      pid: null,
      port,
      startedAt,
      lastExit: null,
      lastError: null,
      health: "unknown",
      healthCheckedAt: null,
      healthError: null,
      configKey: service.configKey,
    }));
    const logs = logFiles(this.store.logsRoot, plugin.name, service.id);
    const stdout = openSync(logs.stdout, "a", 0o600);
    const stderr = openSync(logs.stderr, "a", 0o600);
    let child: ChildProcess;
    try {
      const command = service.command[0] === "node" ? process.execPath : service.command[0]!;
      child = spawn(command, service.command.slice(1), {
        cwd: service.cwd,
        env: {
          ...baseEnv(),
          ...service.env,
          PROSPERO_HOME: this.opts.home,
          PROSPERO_PLUGIN_ID: plugin.name,
          PROSPERO_PLUGIN_DIR: plugin.root,
          PROSPERO_PLUGIN_RUNTIME: plugin.runtimeRoot ?? path.join(plugin.root, "runtime"),
          PROSPERO_CONTROL_TOKEN_PATH: this.opts.controlTokenPath,
          PROSPERO_CONTROL_SOCKET_PATH: this.opts.controlSocketPath,
          PROSPERO_CONTROL_HTTP: `http://127.0.0.1:${String(this.opts.daemonPort)}`,
          [service.portEnv]: String(port),
        },
        stdio: ["ignore", stdout, stderr],
        windowsHide: true,
      });
    } catch (error) {
      this.store.update(withNow({
        pluginId: plugin.name,
        serviceId: service.id,
        mode: service.mode,
        status: "failed",
        pid: null,
        port: null,
        startedAt,
        lastExit: null,
        lastError: error instanceof Error ? error.message : String(error),
        health: "unknown",
        healthCheckedAt: null,
        healthError: null,
        configKey: service.configKey,
      }));
      throw error;
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    const runtime: Runtime = {
      child,
      plugin,
      service,
      port,
      startedAt,
      stopping: false,
      exit: new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      }),
    };
    this.running.set(key, runtime);
    child.once("error", (error) => {
      this.running.delete(key);
      this.store.update(withNow({
        pluginId: plugin.name,
        serviceId: service.id,
        mode: service.mode,
        status: "failed",
        pid: null,
        port: null,
        startedAt,
        lastExit: null,
        lastError: error.message,
        health: "unknown",
        healthCheckedAt: null,
        healthError: null,
        configKey: service.configKey,
      }));
    });
    child.once("exit", (code, signal) => {
      this.running.delete(key);
      const previous = this.store.get(plugin.name, service.id);
      this.store.update(withNow({
        pluginId: plugin.name,
        serviceId: service.id,
        mode: service.mode,
        status: runtime.stopping ? "stopped" : "exited",
        pid: null,
        port: null,
        startedAt: previous?.startedAt ?? startedAt,
        lastExit: { code, signal, at: Date.now() },
        lastError: runtime.stopping ? null : previous?.lastError ?? null,
        health: "unknown",
        healthCheckedAt: previous?.healthCheckedAt ?? null,
        healthError: previous?.healthError ?? null,
        configKey: service.configKey,
      }));
    });
    this.store.update(withNow({
      pluginId: plugin.name,
      serviceId: service.id,
      mode: service.mode,
      status: "running",
      pid: child.pid ?? null,
      port,
      startedAt,
      lastExit: null,
      lastError: null,
      health: "unknown",
      healthCheckedAt: null,
      healthError: null,
      configKey: service.configKey,
    }));
    if (service.healthPath) {
      void this.checkHealth(plugin.name, service.id).catch(() => undefined);
    }
    const earlyFailure = await this.earlyFailure(child, 75);
    if (earlyFailure) {
      this.running.delete(key);
      const failed = withNow({
        pluginId: plugin.name,
        serviceId: service.id,
        mode: service.mode,
        status: earlyFailure.type === "error" ? "failed" : "exited",
        pid: null,
        port: null,
        startedAt,
        lastExit: earlyFailure.type === "exit" ? { code: earlyFailure.code, signal: earlyFailure.signal, at: Date.now() } : null,
        lastError: earlyFailure.type === "error" ? earlyFailure.message : null,
        health: "unknown",
        healthCheckedAt: null,
        healthError: null,
        configKey: service.configKey,
      } satisfies Omit<PluginServiceState, "updatedAt">);
      this.store.update(failed);
      return this.viewFor(plugin, service, failed);
    }
    await sleep(5);
    return this.viewFor(plugin, service, this.store.get(plugin.name, service.id));
  }

  private async stopUnlocked(pluginId: string, serviceId: string): Promise<PluginServiceView> {
    const key = pluginServiceKey(pluginId, serviceId);
    const runtime = this.running.get(key);
    if (runtime) {
      const stopped = await this.stopRuntime(runtime);
      return this.findService(pluginId, serviceId) ? stopped : this.orphanView(stopped);
    }
    const found = this.findService(pluginId, serviceId);
    const state = found
      ? statusFromState(this.store.get(pluginId, serviceId), found.plugin, found.service)
      : this.store.get(pluginId, serviceId);
    if (!found && !state) throw new ControlSocketError("plugin service not found", "plugin_service_not_found");
    if (found && state && state.pid !== null && processMatchesService(state.pid, found.service)) {
      await this.terminatePid(state.pid);
    }
    const stopped = withNow({
      pluginId,
      serviceId,
      mode: found?.service.mode ?? state?.mode ?? "manual",
      status: "stopped",
      pid: null,
      port: null,
      startedAt: state?.startedAt ?? null,
      lastExit: state?.pid !== null ? { code: null, signal: "SIGTERM", at: Date.now() } : state?.lastExit ?? null,
      lastError: null,
      health: "unknown",
      healthCheckedAt: null,
      healthError: null,
      configKey: found?.service.configKey ?? state?.configKey ?? "",
    } satisfies Omit<PluginServiceState, "updatedAt">);
    this.store.update(stopped);
    return found ? this.viewFor(found.plugin, found.service, stopped) : this.orphanView(stopped);
  }

  private async stopRuntime(runtime: Runtime): Promise<PluginServiceView> {
    const { plugin, service } = runtime;
    if (!runtime.child.killed) {
      runtime.stopping = true;
      runtime.child.kill("SIGTERM");
    }
    if (!(await this.waitExit(runtime, 5_000))) {
      runtime.child.kill("SIGKILL");
      await this.waitExit(runtime, 3_000);
    }
    const state = withNow({
      pluginId: plugin.name,
      serviceId: service.id,
      mode: service.mode,
      status: "stopped",
      pid: null,
      port: null,
      startedAt: runtime.startedAt,
      lastExit: this.store.get(plugin.name, service.id)?.lastExit ?? null,
      lastError: null,
      health: "unknown",
      healthCheckedAt: null,
      healthError: null,
      configKey: service.configKey,
    } satisfies Omit<PluginServiceState, "updatedAt">);
    this.store.update(state);
    return this.viewFor(plugin, service, state);
  }

  private orphanView(state: PluginServiceState): PluginServiceView {
    return {
      ...state,
      configured: false,
      pluginRoot: null,
      command: null,
      cwd: null,
      logFiles: logFiles(this.store.logsRoot, state.pluginId, state.serviceId),
    };
  }

  async checkHealth(pluginId: string, serviceId: string): Promise<PluginServiceView> {
    const found = this.findService(pluginId, serviceId);
    if (!found) {
      const state = this.store.get(pluginId, serviceId);
      if (!state) throw new ControlSocketError("plugin service not found", "plugin_service_not_found");
      const next = withNow({
        ...state,
        health: "unknown" as const,
        healthCheckedAt: Date.now(),
        healthError: "service is not configured",
      });
      this.store.update(next);
      return this.orphanView(next);
    }
    const { plugin, service } = found;
    const state = statusFromState(this.store.get(plugin.name, service.id), plugin, service);
    if (!service.healthPath || state.port === null || state.status !== "running") {
      const next = withNow({
        ...state,
        health: "unknown" as const,
        healthCheckedAt: Date.now(),
        healthError: service.healthPath ? "service is not running" : null,
      });
      this.store.update(next);
      return this.viewFor(plugin, service, next);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(state.port)}${service.healthPath}`, {
        signal: AbortSignal.timeout(2_000),
      });
      const next = withNow({
        ...state,
        health: response.ok ? "healthy" as const : "unhealthy" as const,
        healthCheckedAt: Date.now(),
        healthError: response.ok ? null : `status ${String(response.status)}`,
      });
      this.store.update(next);
      return this.viewFor(plugin, service, next);
    } catch (error) {
      const next = withNow({
        ...state,
        health: "unhealthy" as const,
        healthCheckedAt: Date.now(),
        healthError: error instanceof Error ? error.message : String(error),
      });
      this.store.update(next);
      return this.viewFor(plugin, service, next);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((runtime) => this.stopRuntime(runtime).then(() => undefined)));
    await Promise.all(this.list().items
      .filter((item) => item.configured && item.status === "running" && item.pid !== null)
      .map((item) => this.stop(item.pluginId, item.serviceId).then(() => undefined)));
  }

  private async serial<T>(pluginId: string, serviceId: string, run: () => Promise<T>): Promise<T> {
    const key = pluginServiceKey(pluginId, serviceId);
    const previous = this.operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    this.operations.set(key, current.catch(() => undefined));
    try {
      return await current;
    } finally {
      if (this.operations.get(key) === current) this.operations.delete(key);
    }
  }

  private async earlyFailure(child: ChildProcess, timeoutMs: number): Promise<
    { type: "error"; message: string } | { type: "exit"; code: number | null; signal: string | null } | null
  > {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { type: "exit", code: child.exitCode, signal: child.signalCode };
    }
    return await new Promise((resolve) => {
      const finish = (value: { type: "error"; message: string } | { type: "exit"; code: number | null; signal: string | null } | null): void => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        resolve(value);
      };
      const onError = (error: Error): void => finish({ type: "error", message: error.message });
      const onExit = (code: number | null, signal: string | null): void => finish({ type: "exit", code, signal });
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  private async terminatePid(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!processAlive(pid)) return;
      await sleep(25);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private async waitExit(runtime: Runtime, timeoutMs: number): Promise<boolean> {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return true;
    return await Promise.race([
      runtime.exit.then(() => true),
      sleep(timeoutMs).then(() => false),
    ]);
  }

  private viewFor(plugin: ProsperoPluginManifest, service: PluginServiceManifest, state: PluginServiceState | null): PluginServiceView {
    return {
      ...statusFromState(state, plugin, service),
      configured: true,
      pluginRoot: plugin.root,
      command: [...service.command],
      cwd: service.cwd,
      logFiles: logFiles(this.store.logsRoot, plugin.name, service.id),
    };
  }

  private findService(pluginId: string, serviceId: string): { plugin: ProsperoPluginManifest; service: PluginServiceManifest } | null {
    const discovered = discoverProsperoPlugins(this.opts.home);
    const plugin = discovered.plugins.find((item) => item.name === pluginId);
    const service = plugin?.services.find((item) => item.id === serviceId);
    return plugin && service ? { plugin, service } : null;
  }

  private requireService(pluginId: string, serviceId: string): { plugin: ProsperoPluginManifest; service: PluginServiceManifest } {
    const found = this.findService(pluginId, serviceId);
    if (!found) throw new ControlSocketError("plugin service not found", "plugin_service_not_found");
    return found;
  }
}
