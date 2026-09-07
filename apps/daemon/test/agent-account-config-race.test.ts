import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccountConfig, saveAccountConfig } from "../src/agent-account-config.js";

const homes: string[] = [];
const fault = vi.hoisted(() => ({ path: "", replacement: "", mode: "" as "" | "before" | "after" | "external-before" | "external-after" | "external-fsync" | "external-rollback", armed: false, temporarySyncs: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (descriptor: number) => {
      actual.fsyncSync(descriptor);
      if (fault.armed && fault.mode === "external-fsync" && actual.fstatSync(descriptor).isFile()) {
        fault.temporarySyncs += 1;
        if (fault.temporarySyncs === 2) { fault.armed = false; actual.writeFileSync(fault.path, fault.replacement); }
      }
    },
    renameSync: (source: string, target: string) => {
      if (fault.armed && target === fault.path && fault.mode !== "external-fsync") {
        fault.armed = false;
        if (fault.mode === "external-rollback") {
          actual.renameSync(source, target);
          fault.mode = "external-fsync";
          fault.temporarySyncs = 1;
          fault.armed = true;
          throw new Error("injected post-rename failure");
        }
        if (fault.mode === "after" || fault.mode === "external-after") actual.renameSync(source, target);
        if (fault.mode === "external-before" || fault.mode === "external-after") actual.writeFileSync(target, fault.replacement);
        throw new Error("injected atomic replacement failure");
      }
      actual.renameSync(source, target);
    },
  };
});
afterEach(() => { fault.armed = false; fault.temporarySyncs = 0; for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function setup(withExisting = true) {
    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-config-external-"));
    homes.push(home);
    const rootsDir = path.join(home, "accounts");
    mkdirSync(rootsDir);
    const target = { rootsDir, agent: "codex" as const, accountId: "account-one" };
    const catalog = { currentModel: "model-one", models: [{ id: "model-one", label: "One", supportedEfforts: ["low", "high"] }] };
    const initial = getAccountConfig(target, 0, catalog).documents[0]!;
    const saved = withExisting ? saveAccountConfig(target, { documentId: initial.id, revision: initial.revision, defaultEffort: "low" }, 0, catalog).documents[0]! : initial;
    const file = path.join(realpathSync(rootsDir), "codex", target.accountId, "prospero-overrides.toml");
    const previous = withExisting ? readFileSync(file, "utf8") : undefined;
    const external = 'default_model = "model-one"\ndefault_effort = "high"\n';
    const save = () => saveAccountConfig(target, { documentId: saved.id, revision: saved.revision, defaultEffort: null }, 0, catalog);
    const inject = (mode: typeof fault.mode) => { fault.path = file; fault.replacement = external; fault.mode = mode; fault.armed = true; fault.temporarySyncs = 0; };
    return { file, previous, external, save, inject };
}

describe("account config external writer preservation", () => {
  it.each(["before", "after"] as const)("preserves the prior config and backup when replacement fails %s rename", (mode) => {
    const { file, previous, save, inject } = setup();
    inject(mode);
    expect(save).toThrow(/原配置已保留/);
    expect(readFileSync(file, "utf8")).toBe(previous);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(previous);
    expect(readdirSync(path.dirname(file))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each(["external-before", "external-after", "external-fsync", "external-rollback"] as const)("keeps the external version and reports a conflict for %s", (mode) => {
    const { file, previous, external, save, inject } = setup();
    inject(mode);
    expect(save).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(readFileSync(file, "utf8")).toBe(external);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(previous);
    expect(readdirSync(path.dirname(file))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  });

  it.each(["before", "after"] as const)("cleans up only its own new document after a %s-rename failure", (mode) => {
    const { file, save, inject } = setup(false);
    inject(mode);
    expect(save).toThrow(/原配置已保留/);
    expect(existsSync(file)).toBe(false);
  });

  it.each(["external-before", "external-after"] as const)("never deletes an externally created first version after %s", (mode) => {
    const { file, external, save, inject } = setup(false);
    inject(mode);
    expect(save).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(readFileSync(file, "utf8")).toBe(external);
  });
});
