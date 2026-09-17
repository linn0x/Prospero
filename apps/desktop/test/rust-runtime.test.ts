import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustProcess } from "../src/main/rust-process";
import { RustRuntime } from "../src/main/rust-runtime";
import type { StateStore } from "../src/main/state-store";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));

afterEach(() => { vi.restoreAllMocks(); });

describe("RustRuntime CLI bridge", () => {
  it("runs the Rust binary with the daemon data directory as PROSPERO_HOME", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    mocks.spawn.mockReturnValue(child);
    const store = { backend: "api", setManagedState: vi.fn() } as unknown as StateStore;
    const runtime = new RustRuntime(store, "/opt/prosperod-rs", "/tmp/prospero-rust/daemon");
    const result = runtime.runCli(["relay", "status", "--json"]);
    child.stdout.emit("data", Buffer.from("{\"enabled\":false}\n"));
    child.emit("exit", 0);
    await expect(result).resolves.toEqual({ code: 0, output: "{\"enabled\":false}\n" });
    expect(mocks.spawn).toHaveBeenCalledWith("/opt/prosperod-rs", ["relay", "status", "--json"], expect.objectContaining({
      env: expect.objectContaining({ PROSPERO_HOME: "/tmp/prospero-rust/daemon" }),
      stdio: "pipe",
      windowsHide: true,
    }));
  });

  it("starts the Rust daemon with runtime helper executables on PATH", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 102, exitCode: null as number | null, signalCode: null as string | null, stdout: new PassThrough(), stderr: new PassThrough() });
    mocks.spawn.mockReturnValue(child);
    const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-process-"));
    mkdirSync(resolve(directory, "daemon"), { recursive: true });
    const processHost = new RustProcess("/opt/prospero/runtime/prosperod-rs", resolve(directory, "daemon"), () => undefined, { PROSPERO_NODE: "/opt/prospero/runtime/node/node", PATH: "/usr/bin" });
    const started = processHost.start().catch(() => undefined);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    const [, , options] = mocks.spawn.mock.calls[0]!;
    expect(options).toMatchObject({
      env: expect.objectContaining({
        PROSPERO_NODE: "/opt/prospero/runtime/node/node",
        PATH: expect.stringContaining("/opt/prospero/runtime"),
      }),
    });
    child.emit("exit", 1);
    await started;
  });

  it("attaches to an already running Rust daemon without spawning a child", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-process-"));
    mkdirSync(resolve(directory, "daemon"), { recursive: true });
    const connectionFile = resolve(directory, "daemon", "connection.json");
    writeFileSync(connectionFile, JSON.stringify({
      apiVersion: 1,
      pid: process.pid,
      baseUrl: "http://127.0.0.1:7424",
      token: "a".repeat(64),
    }));
    chmodSync(connectionFile, 0o600);
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      apiVersion: 1,
      backend: "rust",
      activeRuntimeSessions: 0,
      databaseQueueCapacity: 128,
      capabilities: [],
      persistence: { pty: true, structured: true },
    })));
    const processHost = new RustProcess("/opt/prospero/runtime/prosperod-rs", resolve(directory, "daemon"));
    await expect(processHost.attach()).resolves.toMatchObject({ pid: process.pid, baseUrl: "http://127.0.0.1:7424" });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:7424/v1/health", expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${"a".repeat(64)}` }),
    }));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("uses an external Rust daemon before launching one", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-process-"));
    mkdirSync(resolve(directory, "daemon"), { recursive: true });
    const connectionFile = resolve(directory, "daemon", "connection.json");
    writeFileSync(connectionFile, JSON.stringify({
      apiVersion: 1,
      pid: process.pid,
      baseUrl: "http://127.0.0.1:7424",
      token: "b".repeat(64),
    }));
    chmodSync(connectionFile, 0o600);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/health")) return new Response(JSON.stringify({
        apiVersion: 1,
        backend: "rust",
        activeRuntimeSessions: 0,
        databaseQueueCapacity: 128,
        capabilities: [],
        persistence: { pty: true, structured: true },
      }));
      if (url.includes("/v1/events?")) return new Response(JSON.stringify({ latestSeq: 0, events: [], resyncRequired: false }));
      if (url.includes("/v1/session-summary")) return new Response(JSON.stringify({ total: 0, active: 0, archived: 0, attention: 0, latestSeq: 0 }));
      if (url.includes("/v1/sessions?")) return new Response(JSON.stringify({ items: [], total: 0, latestSeq: 0 }));
      if (url.includes("/v1/workspaces?")) return new Response(JSON.stringify({ items: [], latestSeq: 0 }));
      if (url.includes("/v1/schedules")) return new Response(JSON.stringify([]));
      if (url.includes("/v1/agent-sessions/queues")) return new Response(JSON.stringify({ queues: [] }));
      if (url.includes("/v1/agent-sessions/controls")) return new Response(JSON.stringify({ controls: [] }));
      return new Response("{}", { status: 404 });
    });
    const store = {
      backend: "api",
      setStartupProgress: vi.fn(),
      setManagedState: vi.fn(),
      setApiState: vi.fn(),
      appendLog: vi.fn(),
    } as unknown as StateStore;
    const runtime = new RustRuntime(store, "/opt/prosperod-rs", resolve(directory, "daemon"));
    (runtime as unknown as { refresh: () => Promise<void> }).refresh = async () => undefined;
    await expect(runtime.start()).resolves.toEqual({ ok: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(store.setManagedState).toHaveBeenLastCalledWith(undefined, false);
  });

  it("passes the legacy home to the Rust daemon for first-run migration", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 103, exitCode: null as number | null, signalCode: null as string | null, stdout: new PassThrough(), stderr: new PassThrough() });
    mocks.spawn.mockReturnValue(child);
    const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-process-"));
    mkdirSync(resolve(directory, "daemon"), { recursive: true });
    const processHost = new RustProcess("/opt/prospero/runtime/prosperod-rs", resolve(directory, "daemon"), () => undefined, { PROSPERO_LEGACY_HOME: "/Users/example/.prospero" });
    const started = processHost.start().catch(() => undefined);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    const [, , options] = mocks.spawn.mock.calls[0]!;
    expect(options).toMatchObject({ env: expect.objectContaining({ PROSPERO_LEGACY_HOME: "/Users/example/.prospero" }) });
    child.emit("exit", 1);
    await started;
  });
});
