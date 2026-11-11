import { chmodSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustProcess } from "../src/main/rust-process";

const fsMocks = vi.hoisted(() => ({
  readFileCallsForBinary: 0,
  trackedBinary: "",
}));

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (fsMocks.trackedBinary && String(path) === fsMocks.trackedBinary) {
        fsMocks.readFileCallsForBinary += 1;
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

const tempDirs: string[] = [];
afterEach(() => {
  fsMocks.readFileCallsForBinary = 0;
  fsMocks.trackedBinary = "";
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RustProcess binary SHA-256 digest cache", () => {
  it("hashes the daemon binary once per (path, mtimeMs, size) instead of re-reading 24 MB on every 500ms deferred-upgrade poll", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-digest-"));
    tempDirs.push(directory);
    const daemon = resolve(directory, "daemon");
    mkdirSync(daemon, { recursive: true });
    const binary = resolve(directory, "prosperod-rs");
    writeFileSync(binary, "v1-binary-payload");
    fsMocks.trackedBinary = binary;

    const connectionFile = resolve(daemon, "connection.json");
    writeFileSync(
      connectionFile,
      JSON.stringify({
        apiVersion: 1,
        pid: process.pid,
        baseUrl: "http://127.0.0.1:7424",
        token: "c".repeat(64),
      }),
    );
    chmodSync(connectionFile, 0o600);

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          apiVersion: 1,
          backend: "rust",
          daemonVersion: "0.1.0",
          buildId: "old-running-build",
          activeRuntimeSessions: 2,
          databaseQueueCapacity: 128,
          capabilities: [],
          persistence: { pty: true, structured: true },
        }),
      ),
    );

    const processHost = new RustProcess(binary, daemon);
    expect(fsMocks.readFileCallsForBinary).toBe(1);

    const attached = await processHost.attach();
    expect(attached?.upgradeDeferred).toBe(true);
    expect(fsMocks.readFileCallsForBinary).toBe(1);

    // Simulate 20 consecutive 500ms polls while upgradeDeferred is active
    for (let i = 0; i < 20; i++) {
      await processHost.completeDeferredUpgrade();
    }
    expect(fsMocks.readFileCallsForBinary).toBe(1);

    // Updating the binary on disk (size + mtime change) invalidates the cache once and caches the new digest
    writeFileSync(binary, "v2-binary-payload-updated");
    const future = new Date(Date.now() + 5_000);
    utimesSync(binary, future, future);

    await processHost.completeDeferredUpgrade();
    expect(fsMocks.readFileCallsForBinary).toBe(2);
    await processHost.completeDeferredUpgrade();
    expect(fsMocks.readFileCallsForBinary).toBe(2);
  });
});
