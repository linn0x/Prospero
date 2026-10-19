import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeManifest, verifyRuntimeManifest } from "../scripts/runtime-manifest.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("runtime manifest", () => {
  it("binds daemon CLI and Host bytes and rejects changed artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "prospero-pin-"));
    roots.push(root);
    for (const name of ["prosperod-rs", "prospero", "prospero-execution-host", "prospero-budget-host"]) writeFileSync(join(root, name), name);
    const manifest = runtimeManifest(root, "darwin", "arm64");
    writeFileSync(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
    expect(verifyRuntimeManifest(root)).toEqual(manifest);
    writeFileSync(join(root, "prospero-execution-host"), "changed");
    expect(() => verifyRuntimeManifest(root)).toThrow("differ from pinned manifest");
  });

  it("refuses an incomplete runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "prospero-pin-"));
    roots.push(root);
    writeFileSync(join(root, "prosperod-rs"), "daemon");
    expect(() => runtimeManifest(root, "darwin", "arm64")).toThrow("missing or linked");
  });
});
