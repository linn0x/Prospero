import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStructuredSupervisorHostLease } from "../src/structured-supervisor-runtime-lease.js";
import { createStructuredSupervisorRuntimeSnapshot } from "../src/structured-supervisor-runtime.js";

const temporary: string[] = [];

function temp(prefix: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function runtimeFixture(prefix: string): { source: string; runtimeRoot: string; runner: string } {
  const source = temp(`${prefix}-source-`);
  const runtimeRoot = path.join(temp(`${prefix}-home-`), "structured-supervisor-runtime");
  const runner = path.join(source, "runner.mjs");
  return { source, runtimeRoot, runner };
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("structured supervisor immutable runtime", () => {
  it("prefers CoW cloning without weakening digest verification or using hardlinks", () => {
    const implementation = readFileSync(path.join(import.meta.dirname, "..", "src", "structured-supervisor-runtime.ts"), "utf8");
    expect(implementation).toContain("constants as fsConstants");
    expect(implementation).toContain("copyFileSync(file.source, destination, fsConstants.COPYFILE_FICLONE)");
    expect(implementation).not.toContain("linkSync(");
    expect(implementation).toContain("digestFiles(image.files, staging) !== contentDigest");
    expect(implementation).toContain("digestFiles(current.files) !== contentDigest");
  });

  it("uses a daemon-private content-addressed image and preserves bare ESM package resolution", () => {
    const fixture = runtimeFixture("prospero-runtime-bare");
    const packageRoot = path.join(fixture.source, "node_modules", "@fixture", "value");
    const dependencyRoot = path.join(fixture.source, "node_modules", "@fixture", "dependency");
    // Fixture setup only; production rejects symlinks and makes every image
    // directory 0700 before it accepts a copied file.
    mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
    mkdirSync(dependencyRoot, { recursive: true, mode: 0o700 });
    writePrivate(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@fixture/value", type: "module", exports: "./dist/index.mjs", dependencies: { "@fixture/dependency": "1.0.0" },
    }));
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true, mode: 0o700 });
    writePrivate(path.join(packageRoot, "dist", "index.mjs"), "import { dependency } from '@fixture/dependency'; export const value = `package:${dependency}`;\n");
    writePrivate(path.join(packageRoot, "asset.txt"), "full package asset\n");
    writePrivate(path.join(dependencyRoot, "package.json"), JSON.stringify({ name: "@fixture/dependency", type: "module", exports: "./index.mjs" }));
    writePrivate(path.join(dependencyRoot, "index.mjs"), "export const dependency = 'dependency';\n");
    writePrivate(path.join(fixture.source, "local.mjs"), "export const local = 'local';\n");
    writePrivate(fixture.runner, "import { local } from './local.mjs'; import { value } from '@fixture/value'; console.log(`${local}:${value}`);\n");

    const first = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
    const second = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
    try {
      expect(first.directory).toBe(second.directory);
      expect(first.directory.startsWith(fixture.runtimeRoot)).toBe(true);
      const packageImage = path.join(first.directory, "dist", "node_modules", "@fixture", "value");
      expect(existsSync(path.join(packageImage, "asset.txt"))).toBe(true);
      expect(existsSync(path.join(packageImage, "node_modules", "@fixture", "dependency", "index.mjs"))).toBe(true);
      expect(existsSync(path.join(packageImage, "dist", "node_modules", "@fixture", "dependency", "index.mjs"))).toBe(false);
      expect(execFileSync(process.execPath, [first.runnerPath], { encoding: "utf8" }).trim()).toBe("local:package:dependency");
    } finally {
      first.release();
      second.release();
    }
  });

  it("retries a changed source graph rather than publishing a mixed image", () => {
    const fixture = runtimeFixture("prospero-runtime-race");
    const firstDependency = path.join(fixture.source, "first.mjs");
    const secondDependency = path.join(fixture.source, "second.mjs");
    writePrivate(firstDependency, "export const first = 'first';\n");
    writePrivate(secondDependency, "export const second = 'old';\n");
    writePrivate(fixture.runner, "import { first } from './first.mjs'; import { second } from './second.mjs'; console.log(`${first}:${second}`);\n");
    let copies = 0;
    const snapshot = createStructuredSupervisorRuntimeSnapshot({
      runtimeRoot: fixture.runtimeRoot,
      runnerPath: fixture.runner,
      afterCopyForTest: () => {
        copies++;
        if (copies === 1) writePrivate(secondDependency, "export const second = 'new';\n");
      },
    });
    try {
      expect(copies).toBe(2);
      expect(execFileSync(process.execPath, [snapshot.runnerPath], { encoding: "utf8" }).trim()).toBe("first:new");
    } finally {
      snapshot.release();
    }
  });

  it("retains an aged image with a live lease and reclaims it only after that lease is released", () => {
    const fixture = runtimeFixture("prospero-runtime-gc");
    writePrivate(fixture.runner, "console.log('one');\n");
    const retained = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    utimesSync(retained.directory, old, old);

    writePrivate(fixture.runner, "console.log('two');\n");
    const current = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
    try {
      expect(existsSync(retained.directory)).toBe(true);
      retained.release();
      writePrivate(fixture.runner, "console.log('three');\n");
      const afterRelease = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
      try {
        expect(existsSync(retained.directory)).toBe(false);
      } finally {
        afterRelease.release();
      }
    } finally {
      retained.release();
      current.release();
    }
  });

  it("does not GC an aged image while its detached host lease is live", () => {
    const fixture = runtimeFixture("prospero-runtime-host-gc");
    const runner = path.join(fixture.source, "structured-supervisor-runner.js");
    writePrivate(runner, "console.log('host');\n");
    const daemonImage = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: runner });
    const hostLease = createStructuredSupervisorHostLease(daemonImage.runnerPath);
    expect(hostLease).not.toBeNull();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    utimesSync(daemonImage.directory, old, old);
    daemonImage.release();
    writePrivate(runner, "console.log('next');\n");
    const current = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: runner });
    try {
      expect(existsSync(daemonImage.directory)).toBe(true);
    } finally {
      hostLease?.release();
      current.release();
    }
  });

  it("retains expired leases when a PID is still live or cannot be inspected", () => {
    const fixture = runtimeFixture("prospero-runtime-pid-gc");
    writePrivate(fixture.runner, "console.log('one');\n");
    const original = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
    const digest = path.basename(original.directory).replace("structured-supervisor-", "");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    utimesSync(original.directory, old, old);
    original.release();
    const leases = path.join(fixture.runtimeRoot, "leases");
    writePrivate(path.join(leases, `${digest}-live.json`), JSON.stringify({ version: 1, digest, pid: process.pid, heartbeatAt: old.getTime() }));
    writePrivate(fixture.runner, "console.log('two');\n");
    const withLivePid = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
    try {
      expect(existsSync(original.directory)).toBe(true);
    } finally {
      withLivePid.release();
    }

    rmSync(path.join(leases, `${digest}-live.json`), { force: true });
    const protectedPid = 987_654_321;
    writePrivate(path.join(leases, `${digest}-dead-fresh.json`), JSON.stringify({
      version: 1, digest, pid: protectedPid, heartbeatAt: Date.now(),
    }));
    writePrivate(fixture.runner, "console.log('three');\n");
    const withDeadFreshLease = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
    try {
      // ESRCH alone is insufficient while the lease is still fresh.
      expect(existsSync(original.directory)).toBe(true);
    } finally {
      withDeadFreshLease.release();
    }
    rmSync(path.join(leases, `${digest}-dead-fresh.json`), { force: true });
    writePrivate(path.join(leases, `${digest}-eperm.json`), JSON.stringify({ version: 1, digest, pid: protectedPid, heartbeatAt: old.getTime() }));
    const realKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === protectedPid && signal === 0) {
        const error = Object.assign(new Error("permission denied"), { code: "EPERM" });
        throw error;
      }
      return realKill(pid, signal as NodeJS.Signals | undefined);
    }) as typeof process.kill);
    try {
      writePrivate(fixture.runner, "console.log('four');\n");
      const withEperm = createStructuredSupervisorRuntimeSnapshot({ runtimeRoot: fixture.runtimeRoot, runnerPath: fixture.runner });
      try {
        expect(existsSync(original.directory)).toBe(true);
      } finally {
        withEperm.release();
      }
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("rejects a runtime root whose ancestor is a symlink", () => {
    const fixture = runtimeFixture("prospero-runtime-symlink");
    writePrivate(fixture.runner, "console.log('unsafe');\n");
    const linkParent = temp("prospero-runtime-link-parent-");
    const link = path.join(linkParent, "linked-home");
    symlinkSync(path.dirname(fixture.runtimeRoot), link, "dir");
    expect(() => createStructuredSupervisorRuntimeSnapshot({
      runtimeRoot: path.join(link, "structured-supervisor-runtime"),
      runnerPath: fixture.runner,
    })).toThrow(/unsafe ancestor/);
  });
});
