import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RuntimeSwitchState } from "../shared/types";

export type BackendPreference = "rust" | "legacy";
export type BackendSelectionReason = "env" | "preference" | "packaged-default" | "development-default";

export type BackendSelection = {
  backend: BackendPreference;
  reason: BackendSelectionReason;
  forced: boolean;
};

export type RuntimeSwitchAvailability = {
  rustBinary: string;
  rustAvailable: boolean;
  legacyAvailable: boolean;
  defaultBackend: BackendPreference;
};

type RuntimeSwitchFile = {
  backend?: unknown;
  previousBackend?: unknown;
  lastRollbackAt?: unknown;
  lastRollbackReason?: unknown;
};

const MAX_REASON = 2000;

function readFile(path: string): RuntimeSwitchFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RuntimeSwitchFile;
  } catch {
    return {};
  }
}

function cleanReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_REASON) : undefined;
}

export function runtimeSwitchPath(appData: string): string {
  return resolve(appData, "Prospero", "runtime-switch.json");
}

export function defaultBackend(packaged: boolean): BackendPreference {
  return packaged ? "rust" : "legacy";
}

export function readBackendSelection(path: string, packaged: boolean, env = process.env): BackendSelection {
  if (env["PROSPERO_BACKEND"] === "rust" || env["PROSPERO_BACKEND"] === "legacy") {
    return { backend: env["PROSPERO_BACKEND"], reason: "env", forced: true };
  }
  const stored = readFile(path).backend;
  if (stored === "rust" || stored === "legacy") return { backend: stored, reason: "preference", forced: false };
  const backend = defaultBackend(packaged);
  return { backend, reason: packaged ? "packaged-default" : "development-default", forced: false };
}

export function readRuntimeSwitch(path: string, active: BackendPreference, selection: BackendSelection, availability: RuntimeSwitchAvailability): RuntimeSwitchState {
  const stored = readFile(path);
  const state: RuntimeSwitchState = {
    backend: active,
    selected: selection.backend,
    selectionReason: selection.reason,
    forced: selection.forced,
    rustAvailable: availability.rustAvailable,
    rustBinary: availability.rustBinary,
    legacyAvailable: availability.legacyAvailable,
    defaultBackend: availability.defaultBackend,
    fallbackAvailable: active === "rust" && !selection.forced && availability.legacyAvailable,
  };
  if (typeof stored.lastRollbackAt === "number" && Number.isFinite(stored.lastRollbackAt)) state.lastRollbackAt = stored.lastRollbackAt;
  const lastRollbackReason = cleanReason(stored.lastRollbackReason);
  if (lastRollbackReason) state.lastRollbackReason = lastRollbackReason;
  return state;
}

export function saveBackendPreference(path: string, backend: BackendPreference): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ backend }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function recordBackendRollback(path: string, previous: BackendPreference, reason: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const lastRollbackReason = cleanReason(reason) ?? "Rust backend failed to start";
  const state = {
    backend: "legacy" as const,
    previousBackend: previous,
    lastRollbackAt: Date.now(),
    lastRollbackReason,
  };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function runtimeBinaryAvailable(path: string): boolean {
  return existsSync(path);
}
