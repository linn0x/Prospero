import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultBackend, readBackendSelection, readRuntimeSwitch, recordBackendRollback, saveBackendPreference } from "../src/main/runtime-switch";

const roots: string[] = [];

function switchFile(): string {
  const root = mkdtempSync(join(tmpdir(), "prospero-runtime-switch-"));
  roots.push(root);
  return join(root, "runtime-switch.json");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime backend switch", () => {
  it("defaults packaged builds to Rust and development builds to legacy", () => {
    expect(defaultBackend(true)).toBe("rust");
    expect(defaultBackend(false)).toBe("legacy");
    expect(readBackendSelection(switchFile(), true, {})).toEqual({ backend: "rust", reason: "packaged-default", forced: false });
    expect(readBackendSelection(switchFile(), false, {})).toEqual({ backend: "legacy", reason: "development-default", forced: false });
  });

  it("honors environment overrides before persisted preferences", () => {
    const file = switchFile();
    saveBackendPreference(file, "legacy");
    expect(readBackendSelection(file, true, { PROSPERO_BACKEND: "rust" })).toEqual({ backend: "rust", reason: "env", forced: true });
  });

  it("persists selection and rollback evidence", () => {
    const file = switchFile();
    saveBackendPreference(file, "rust");
    expect(readBackendSelection(file, false, {})).toEqual({ backend: "rust", reason: "preference", forced: false });
    recordBackendRollback(file, "rust", "startup failed");
    const selection = readBackendSelection(file, true, {});
    expect(selection).toEqual({ backend: "legacy", reason: "preference", forced: false });
    expect(readRuntimeSwitch(file, "legacy", selection, { rustBinary: "/opt/prosperod-rs", rustAvailable: true, legacyAvailable: true, defaultBackend: "rust" })).toMatchObject({
      backend: "legacy",
      selected: "legacy",
      lastRollbackReason: "startup failed",
      fallbackAvailable: false,
    });
    expect(readFileSync(file, "utf8")).toContain("\"previousBackend\": \"rust\"");
    saveBackendPreference(file, "rust");
    expect(readFileSync(file, "utf8")).not.toContain("startup failed");
  });
});
