import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writePrivateFileAtomic } from "../filesystem-store.js";
import type { PluginServiceHealth, PluginServiceMode } from "./manifest.js";

export type PluginServiceStatus = "stopped" | "starting" | "running" | "exited" | "failed";

export interface PluginServiceExit {
  code: number | null;
  signal: string | null;
  at: number;
}

export interface PluginServiceState {
  pluginId: string;
  serviceId: string;
  mode: PluginServiceMode;
  status: PluginServiceStatus;
  pid: number | null;
  port: number | null;
  startedAt: number | null;
  updatedAt: number;
  lastExit: PluginServiceExit | null;
  lastError: string | null;
  health: PluginServiceHealth;
  healthCheckedAt: number | null;
  healthError: string | null;
  configKey: string;
}

interface StateFile {
  items: Record<string, PluginServiceState>;
}

export function pluginServiceKey(pluginId: string, serviceId: string): string {
  return `${pluginId}/${serviceId}`;
}

function emptyState(): StateFile {
  return { items: {} };
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readState(file: string): StateFile {
  const raw = safeObject(readJson(file));
  const items = safeObject(raw?.["items"]);
  if (!items) return emptyState();
  const out: Record<string, PluginServiceState> = {};
  for (const [key, value] of Object.entries(items)) {
    const state = safeObject(value);
    if (!state) continue;
    if (typeof state["pluginId"] !== "string" || typeof state["serviceId"] !== "string") continue;
    out[key] = {
      pluginId: state["pluginId"],
      serviceId: state["serviceId"],
      mode: state["mode"] === "auto" ? "auto" : "manual",
      status: ["stopped", "starting", "running", "exited", "failed"].includes(String(state["status"]))
        ? state["status"] as PluginServiceStatus
        : "stopped",
      pid: Number.isSafeInteger(state["pid"]) ? state["pid"] as number : null,
      port: Number.isSafeInteger(state["port"]) ? state["port"] as number : null,
      startedAt: Number.isSafeInteger(state["startedAt"]) ? state["startedAt"] as number : null,
      updatedAt: Number.isSafeInteger(state["updatedAt"]) ? state["updatedAt"] as number : 0,
      lastExit: safeObject(state["lastExit"]) &&
        (Number.isSafeInteger(safeObject(state["lastExit"])?.["at"]))
        ? {
            code: Number.isSafeInteger(safeObject(state["lastExit"])?.["code"]) ? safeObject(state["lastExit"])?.["code"] as number : null,
            signal: typeof safeObject(state["lastExit"])?.["signal"] === "string" ? safeObject(state["lastExit"])?.["signal"] as string : null,
            at: safeObject(state["lastExit"])?.["at"] as number,
          }
        : null,
      lastError: typeof state["lastError"] === "string" ? state["lastError"] : null,
      health: ["unknown", "healthy", "unhealthy"].includes(String(state["health"]))
        ? state["health"] as PluginServiceHealth
        : "unknown",
      healthCheckedAt: Number.isSafeInteger(state["healthCheckedAt"]) ? state["healthCheckedAt"] as number : null,
      healthError: typeof state["healthError"] === "string" ? state["healthError"] : null,
      configKey: typeof state["configKey"] === "string" ? state["configKey"] : "",
    };
  }
  return { items: out };
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(dir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${dir} is not a safe directory`);
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

export class PluginServiceStore {
  readonly root: string;
  readonly logsRoot: string;
  private readonly stateFile: string;

  constructor(home: string) {
    this.root = path.join(home, "plugin-services");
    this.logsRoot = path.join(this.root, "logs");
    this.stateFile = path.join(this.root, "state.json");
    ensurePrivateDirectory(this.root);
    ensurePrivateDirectory(this.logsRoot);
  }

  list(): PluginServiceState[] {
    return Object.values(readState(this.stateFile).items).sort((a, b) =>
      pluginServiceKey(a.pluginId, a.serviceId).localeCompare(pluginServiceKey(b.pluginId, b.serviceId)),
    );
  }

  get(pluginId: string, serviceId: string): PluginServiceState | null {
    return readState(this.stateFile).items[pluginServiceKey(pluginId, serviceId)] ?? null;
  }

  update(state: PluginServiceState): void {
    const file = readState(this.stateFile);
    file.items[pluginServiceKey(state.pluginId, state.serviceId)] = state;
    writePrivateFileAtomic(this.stateFile, `${JSON.stringify(file, null, 2)}\n`);
  }
}
