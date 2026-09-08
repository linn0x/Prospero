import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonRuntime } from "../src/main/daemon-runtime";
import type { StateStore } from "../src/main/state-store";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
vi.mock("../src/main/host-environment", () => ({ loginPath: () => undefined, resolveNodeExecutable: () => process.execPath }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("daemon startup failure", () => {
  it("reports an exited child and its diagnostic immediately instead of waiting 90 seconds", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 101, exitCode: null as number | null, killed: false, stdout: new PassThrough(), stderr: new PassThrough() });
    mocks.spawn.mockReturnValue(child);
    const store = { home: "C:/test", snapshot: () => ({ daemon: { running: false, port: 7423, bind: "127.0.0.1" }, settings: { fullAccessPermission: false, daemonBind: "127.0.0.1" } }), setStartupProgress: vi.fn(), setManagedState: vi.fn(), appendLog: vi.fn() };
    const runtime = new DaemonRuntime(store as unknown as StateStore);
    vi.spyOn(runtime as unknown as { locateRuntime: () => object }, "locateRuntime").mockReturnValue({ node: process.execPath, cli: "daemon/cli.js", cwd: "." });
    vi.spyOn(runtime, "request").mockRejectedValue(new Error("Not ready"));
    const starting = runtime.start();
    child.stderr.emit("data", Buffer.from("编排状态无法读取"));
    child.exitCode = 1;
    child.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.setManagedState).toHaveBeenCalledWith(undefined, false, expect.stringContaining("编排状态无法读取"));
    expect(await starting).toEqual({ ok: false, error: expect.stringContaining("已退出（1）") });
    expect(runtime.managed).toBe(false);
  });
});
