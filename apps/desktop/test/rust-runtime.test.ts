import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
