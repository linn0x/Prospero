import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRecovery } from "../src/main/terminal-recovery";
import { RustProcess } from "../src/main/rust-process";
import { RustRuntime, rustTerminalView } from "../src/main/rust-runtime";
import type { StateStore } from "../src/main/state-store";
import type { TerminalPage } from "@prospero/protocol/rust-daemon";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));

afterEach(() => { vi.restoreAllMocks(); });

function health(buildId: string, activeRuntimeSessions = 0): Record<string, unknown> {
  return {
    apiVersion: 1,
    backend: "rust",
    daemonVersion: "0.1.0",
    buildId,
    activeRuntimeSessions,
    databaseQueueCapacity: 128,
    capabilities: [],
    persistence: { pty: true, structured: true },
  };
}

function terminalPage(input: Partial<TerminalPage> = {}): TerminalPage {
  return {
    initialSize: { cols: 120, rows: 40 },
    baseSeq: 0,
    nextSeq: 0,
    latestSeq: 0,
    floorSeq: 0,
    events: [],
    resyncRequired: false,
    exited: true,
    exitCode: 0,
    ...input,
  };
}

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
    const binary = resolve(directory, "prosperod-rs");
    writeFileSync(binary, "");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(health("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))));
    const processHost = new RustProcess(binary, resolve(directory, "daemon"));
    await expect(processHost.attach()).resolves.toMatchObject({ pid: process.pid, baseUrl: "http://127.0.0.1:7424" });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:7424/v1/health", expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${"a".repeat(64)}` }),
    }));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("defers a build handoff while runtime sessions are active", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-process-"));
    const daemon = resolve(directory, "daemon");
    mkdirSync(daemon, { recursive: true });
    const binary = resolve(directory, "prosperod-rs");
    writeFileSync(binary, "new-build");
    const expectedBuildId = "a3869de21758451a261f386b70e30fb8132acc161030949a1ebb75cd290257bf";
    writeFileSync(resolve(daemon, "connection.json"), JSON.stringify({
      apiVersion: 1,
      pid: process.pid,
      baseUrl: "http://127.0.0.1:7424",
      token: "c".repeat(64),
    }));
    chmodSync(resolve(daemon, "connection.json"), 0o600);
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(health("old-build", 2))));
    const processHost = new RustProcess(binary, daemon);

    await expect(processHost.attach()).resolves.toMatchObject({
      buildId: "old-build",
      expectedBuildId,
      upgradeDeferred: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("hands an idle mismatched daemon back to its independent manager", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-process-"));
    const daemon = resolve(directory, "daemon");
    mkdirSync(daemon, { recursive: true });
    const binary = resolve(directory, "prosperod-rs");
    writeFileSync(binary, "new-build");
    const expectedBuildId = "a3869de21758451a261f386b70e30fb8132acc161030949a1ebb75cd290257bf";
    const connectionFile = resolve(daemon, "connection.json");
    writeFileSync(connectionFile, JSON.stringify({
      apiVersion: 1,
      pid: process.pid,
      baseUrl: "http://127.0.0.1:7424",
      token: "d".repeat(64),
    }));
    chmodSync(connectionFile, 0o600);
    let replacement = false;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/shutdown?")) {
        replacement = true;
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      if (url.endsWith("/v1/health")) return new Response(JSON.stringify(health(replacement ? expectedBuildId : "old-build")));
      throw new Error(`Unexpected request ${url} ${String(init?.method)}`);
    });
    const processHost = new RustProcess(binary, daemon);

    await expect(processHost.attach()).resolves.toMatchObject({
      buildId: expectedBuildId,
      expectedBuildId,
    });
    expect(fetcher.mock.calls.some(([input]) => String(input).includes(`/v1/shutdown?expectedBuildId=old-build`))).toBe(true);
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
      if (url.endsWith("/v1/health")) return new Response(JSON.stringify(health("development")));
      if (url.includes("/v1/events?")) return new Response(JSON.stringify({ latestSeq: 0, events: [], resyncRequired: false }));
      if (url.includes("/v1/session-summary")) return new Response(JSON.stringify({ total: 0, active: 0, archived: 0, attention: 0, latestSeq: 0 }));
      if (url.includes("/v1/sessions?")) return new Response(JSON.stringify({ items: [], total: 0, latestSeq: 0 }));
      if (url.includes("/v1/workspaces?")) return new Response(JSON.stringify({ items: [], latestSeq: 0 }));
      if (url.endsWith("/v1/devices")) return new Response(JSON.stringify({ items: [] }));
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

describe("Rust terminal recovery", () => {
  it.each([undefined, 2])("refuses truncated history without a snapshot (cursor %s)", async cursor => {
    const output = vi.fn().mockResolvedValue(terminalPage({ baseSeq: 2, nextSeq: 2, latestSeq: 12, floorSeq: 8, resyncRequired: true, exited: false, exitCode: null }));
    const client = { terminalOutput: output, terminalSnapshot: vi.fn().mockResolvedValue(null) };
    await expect(rustTerminalView(client, "session-1", cursor, 0, AbortSignal.timeout(1000))).rejects.toThrow("无法可靠恢复画面");
    expect(output).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith("session-1", { afterSeq: cursor ?? 0, waitMs: 0 }, expect.any(AbortSignal));
  });

  it("allows cold replay when the complete event history is retained", async () => {
    const page = terminalPage({ baseSeq: 0, floorSeq: 0, nextSeq: 1, latestSeq: 1, events: [{ type: "output", dataB64: "b25l" }] });
    const client = { terminalOutput: vi.fn().mockResolvedValue(page), terminalSnapshot: vi.fn().mockResolvedValue(null) };
    await expect(rustTerminalView(client, "session-1", undefined, 0, AbortSignal.timeout(1000))).resolves.toMatchObject({ mode: "events", baseSeq: 0, seq: 1, caughtUp: true, events: page.events });
  });

  it("prefers a checkpoint when the requested cursor was truncated", async () => {
    const client = {
      terminalOutput: vi.fn().mockResolvedValue(terminalPage({ latestSeq: 12, floorSeq: 8, resyncRequired: true })),
      terminalSnapshot: vi.fn().mockResolvedValue({ seq: 12, size: { cols: 80, rows: 24 }, dataB64: "c25hcHNob3Q=" }),
    };

    await expect(rustTerminalView(client, "session-1", 2, 0, AbortSignal.timeout(1000))).resolves.toEqual({
      kind: "pty",
      mode: "snapshot",
      seq: 12,
      cols: 80,
      rows: 24,
      dataB64: "c25hcHNob3Q=",
    });
    expect(client.terminalOutput).toHaveBeenCalledOnce();
  });
});


it("restores a persisted complete prefix after desktop restart even when daemon history was pruned", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "prospero-recovery-route-"));
  const recovery = new TerminalRecovery(dir);
  const restarted = new TerminalRecovery(dir);
  let pruned = false;
  const events = [{ type: "output" as const, dataB64: Buffer.from("\x1b[31;").toString("base64") }, { type: "output" as const, dataB64: Buffer.from("1mred").toString("base64") }];
  const client = { terminalSnapshot: vi.fn().mockResolvedValue(null), terminalOutput: vi.fn(async () => terminalPage({ baseSeq: 0, nextSeq: pruned ? 0 : 2, latestSeq: 2, floorSeq: pruned ? 2 : 0, resyncRequired: pruned, events: pruned ? [] : events })) };
  try {
    await rustTerminalView(client, "session", undefined, 0, AbortSignal.timeout(1000), recovery);
    await recovery.flush(); pruned = true;
    expect(await rustTerminalView(client, "session", undefined, 0, AbortSignal.timeout(1000), restarted)).toMatchObject({ mode: "snapshot", seq: 0, caughtUp: false });
    expect(await rustTerminalView(client, "session", 0, 0, AbortSignal.timeout(1000), restarted)).toMatchObject({ mode: "events", baseSeq: 0, seq: 2, events, caughtUp: true });
  } finally { await recovery.flush(); await restarted.flush(); rmSync(dir, { recursive: true, force: true }); }
});
