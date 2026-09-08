import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceSummary, workspaceBranch, workspaceSize } from "../src/workspace-summary.js";

const fixtures: string[] = [];
const tempRoot = realpathSync(os.tmpdir());
function fixture() {
  const base = mkdtempSync(path.join(tempRoot, "prospero-summary-"));
  fixtures.push(base);
  const root = path.join(base, "repo");
  mkdirSync(root);
  return { base, root };
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const base of fixtures.splice(0)) {
    const resolved = realpathSync(base);
    if (!resolved.startsWith(tempRoot + path.sep) || !path.basename(resolved).startsWith("prospero-summary-")) throw new Error("Unsafe fixture cleanup");
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe("homepage workspace summary", () => {
  it("counts nested files and hardlinks once without following external or circular junctions", async () => {
    const { root, base } = fixture();
    writeFileSync(path.join(root, "one"), "12345");
    linkSync(path.join(root, "one"), path.join(root, "same"));
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "nested", "two"), "678");
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "large"), Buffer.alloc(10_000));
    symlinkSync(outside, path.join(root, "external"), "junction");
    symlinkSync(root, path.join(root, "cycle"), "junction");
    expect(await workspaceSize(root)).toEqual({ sizeBytes: 8, sizeComplete: true });
  });

  it("distinguishes empty, unavailable and bounded partial scans", async () => {
    const { root } = fixture();
    expect(await workspaceSize(root)).toEqual({ sizeBytes: 0, sizeComplete: true });
    expect(await workspaceSize(path.join(root, "missing"))).toEqual({ sizeBytes: null, sizeComplete: false });
    writeFileSync(path.join(root, "a"), "123");
    writeFileSync(path.join(root, "b"), "123");
    expect(await workspaceSize(root, { maxEntries: 1 })).toEqual({ sizeBytes: 3, sizeComplete: false });
    expect(await workspaceSize(root, { maxMs: 0 })).toEqual({ sizeBytes: 0, sizeComplete: false });
  });

  it("reads unborn branches and detached HEAD while ignoring inherited Git overrides", async () => {
    const { root, base } = fixture();
    expect(await workspaceBranch(root)).toBeNull();
    git(root, "init", "-q", "-b", "feature/home");
    vi.stubEnv("GIT_DIR", path.join(base, "wrong"));
    expect(await workspaceBranch(root)).toBe("feature/home");
    vi.unstubAllEnvs();
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture");
    git(root, "checkout", "-q", "--detach");
    expect(await workspaceBranch(root)).toBe(`detached · ${git(root, "rev-parse", "--short", "HEAD").trim()}`);
  });

  it("coalesces simultaneous scans, caches by path, and refreshes after one minute", async () => {
    const { root } = fixture();
    writeFileSync(path.join(root, "one"), "123");
    const [a, b] = await Promise.all([readWorkspaceSummary(root), readWorkspaceSummary(root)]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ branch: null, sizeBytes: 3, sizeComplete: true });
    writeFileSync(path.join(root, "two"), "456");
    expect(await readWorkspaceSummary(root)).toBe(a);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(a.checkedAt + 60_001);
    expect(await readWorkspaceSummary(root)).toMatchObject({ sizeBytes: 6, sizeComplete: true });
  });
});
