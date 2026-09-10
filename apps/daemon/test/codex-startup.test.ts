import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { AdapterResumeState } from "../src/adapters/types.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: spawnMock }));

type Request = { id?: number; method: string; params: Record<string, unknown> };
const adapters: CodexAdapter[] = [];

/** Stdio-only fixture: no native process, account directory, socket or model. */
function fixture(resumeState?: AdapterResumeState) {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Request[] = [];
  const events: AgentEventBody[] = [];
  let handle: (request: Request) => boolean | void = () => {};
  const respond = (id: number | undefined, result: unknown): void => {
    stdout.write(`${JSON.stringify({ id, result })}\n`);
  };
  const stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)) as Request;
    requests.push(request);
    queueMicrotask(() => {
      if (handle(request) === true) return;
      if (request.method === "initialize") respond(request.id, {});
      else if (request.method === "thread/start" || request.method === "thread/resume") respond(request.id, { thread: { id: "main-thread" } });
    });
    done();
  } });
  Object.assign(child, { stdin, stdout, stderr, kill: vi.fn(() => true) });
  spawnMock.mockReturnValue(child);
  const adapter = new CodexAdapter({ resumeState });
  adapters.push(adapter);
  const context = { cwd: "/synthetic-workspace", emit: (event: AgentEventBody) => events.push(event) };
  return { adapter, child, stdin, stdout, stderr, requests, events, respond, context, onRequest: (callback: typeof handle) => { handle = callback; } };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Codex startup without waiting for optional history", () => {
  it("a new thread becomes ready without querying the account-wide child index", async () => {
    const f = fixture();
    await f.adapter.start(f.context);
    expect(f.requests.map((request) => request.method)).toEqual(["initialize", "initialized", "thread/start"]);
    await f.adapter.send("synthetic first message");
    expect(f.requests.at(-1)?.method).toBe("turn/start");
  });

  it("a resumed thread accepts messages while its child index has not answered", async () => {
    const f = fixture({ threadId: "main-thread" });
    await f.adapter.start(f.context);
    const pending = f.requests.find((request) => request.method === "thread/list")!;
    expect(pending).toBeDefined();
    await f.adapter.send("synthetic first message");
    expect(f.requests.at(-1)?.method).toBe("turn/start");
    f.respond(pending.id, { data: [{ id: "child", parentThreadId: "main-thread", agentNickname: "Reviewer", status: "idle" }] });
    await Promise.resolve();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "subagent.started", subagent: expect.objectContaining({ id: "child", name: "Reviewer" }) }));
  });

  it("a late child index response cannot populate a disposed or restarted session", async () => {
    const f = fixture({ threadId: "main-thread" });
    await f.adapter.start(f.context);
    const pending = f.requests.find((request) => request.method === "thread/list")!;
    // The response can already be resolved while its async continuation is
    // still queued; clearing pending RPCs alone does not cover this ordering.
    f.respond(pending.id, { data: [{ id: "stale-child", parentThreadId: "main-thread", status: "idle" }] });
    await f.adapter.dispose();
    expect(f.events.some((event) => event.kind === "subagent.started")).toBe(false);
    // Reusing the adapter with a new context must not let the old pending RPC
    // publish into this next generation, even if its native thread ID matches.
    const nextEvents: AgentEventBody[] = [];
    await f.adapter.start({ ...f.context, emit: (event) => nextEvents.push(event) });
    f.respond(pending.id, { data: [{ id: "stale-child", parentThreadId: "main-thread", status: "idle" }] });
    await Promise.resolve();
    expect(nextEvents.some((event) => event.kind === "subagent.started")).toBe(false);
  });

  it("bounds the whole background scan to five seconds across pages", async () => {
    vi.useFakeTimers();
    const f = fixture({ threadId: "main-thread" });
    f.onRequest((request) => {
      if (request.method === "thread/list" && !request.params["cursor"]) {
        setTimeout(() => f.respond(request.id, { data: [], nextCursor: "page-2" }), 3_000);
      }
    });
    await f.adapter.start(f.context);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.requests.filter((request) => request.method === "thread/list")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.events.some((event) => event.kind === "agent.error")).toBe(false);
  });
});

describe("Codex process startup and failure isolation", () => {
  function platform(value: string, env: NodeJS.ProcessEnv = {}) {
    vi.stubGlobal("process", { ...process, platform: value, env });
  }

  it("hides Windows child windows and merges environment keys without case collisions", async () => {
    platform("win32", { Path: "parent", CODEX_THREAD_ID: "parent-thread", codex_permission_profile: "parent-profile" });
    const f = fixture();
    await f.adapter.start({ ...f.context, env: { PATH: "selected-path", CodeX_CI: "explicit-value" } });
    const options = spawnMock.mock.calls.at(-1)![2];
    expect(options).toMatchObject({ windowsHide: true, env: { PATH: "selected-path", CODEX_CI: "explicit-value" } });
    expect(options.env).not.toHaveProperty("Path");
    expect(options.env).not.toHaveProperty("CODEX_THREAD_ID");
    expect(options.env).not.toHaveProperty("CODEX_PERMISSION_PROFILE");
    expect(options).not.toHaveProperty("detached");
  });

  it.each(["darwin", "linux"])("keeps %s launch and environment semantics", async (os) => {
    platform(os, { PATH: "parent", CODEX_THREAD_ID: "parent-thread" });
    const f = fixture();
    await f.adapter.start({ ...f.context, env: { Path: "case-sensitive", CODEX_CI: "explicit-value" }, codexAppServerArgs: ["-c", "example=true"] });
    expect(spawnMock).toHaveBeenLastCalledWith("codex", ["app-server", "-c", "example=true"], {
      cwd: f.context.cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "parent", Path: "case-sensitive", CODEX_CI: "explicit-value" },
    });
    await f.adapter.dispose();
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it("reports the Windows exit status without ANSI sequences or treating stderr as the cause", async () => {
    platform("win32");
    const f = fixture();
    f.onRequest((request) => {
      if (request.method !== "initialize") return;
      f.stderr.write("\u001b[31mfailed to refresh available models: timeout waiting for child process to exit\u001b[0m\n");
      f.child.emit("exit", 1073807364, null);
      return true;
    });
    const error = await f.adapter.start(f.context).catch(error => error as Error);
    expect(error.message).toContain("0x40010004");
    expect(error.message).toContain("DBG_TERMINATE_PROCESS");
    expect(error.message).toContain("最近的 stderr：failed to refresh");
    expect(error.message).not.toContain("\u001b");
    expect(f.events.filter(event => event.kind === "agent.error")).toHaveLength(1);
  });

  it("retains an early exit diagnostic while process registration is pending", async () => {
    platform("win32");
    const f = fixture();
    await expect(f.adapter.start({ ...f.context, registerProviderProcess: async () => {
      f.child.emit("exit", 1073807364, null);
    } })).rejects.toThrow("0x40010004");
    expect(f.requests).toEqual([]);
  });

  it("closes a Windows app-server when thread startup fails", async () => {
    platform("win32");
    const f = fixture();
    Object.assign(f.child, { pid: 42, exitCode: null, signalCode: null });
    f.stdin.on("finish", () => f.child.emit("exit", 0, null));
    f.onRequest((request) => {
      if (request.method !== "thread/start") return;
      f.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -1, message: "synthetic startup failure" } })}\n`);
      return true;
    });
    await expect(f.adapter.start(f.context)).rejects.toThrow("synthetic startup failure");
    expect(f.stdin.writableEnded).toBe(true);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.events.filter(event => event.kind === "agent.error")).toHaveLength(0);
  });

  it("bounds stalled initialization and closes the child instead of leaving it behind", async () => {
    platform("win32");
    vi.useFakeTimers();
    const f = fixture();
    Object.assign(f.child, { pid: 42, exitCode: null, signalCode: null });
    f.onRequest(request => request.method === "initialize");
    const failure = expect(f.adapter.start(f.context)).rejects.toThrow("codex initialize 超时");
    await vi.advanceTimersByTimeAsync(32_000);
    await failure;
    expect(f.stdin.writableEnded).toBe(true);
    expect(f.child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles an asynchronous stdin error once and terminates the owned child", async () => {
    platform("win32");
    const f = fixture();
    Object.assign(f.child, { pid: 42, exitCode: null, signalCode: null });
    f.stdin.on("finish", () => f.child.emit("exit", 0, null));
    f.onRequest((request) => {
      if (request.method !== "initialize") return;
      f.stdin.emit("error", new Error("EPIPE"));
      return true;
    });
    await expect(f.adapter.start(f.context)).rejects.toThrow("EPIPE");
    expect(f.stdin.writableEnded).toBe(true);
    expect(f.events.filter(event => event.kind === "agent.error")).toHaveLength(1);
  });

  it("ignores old stdout and stderr after restarting with a different child", async () => {
    platform("win32");
    const f = fixture();
    await f.adapter.start(f.context);
    await f.adapter.dispose();
    const next = fixture();
    await f.adapter.start(f.context);
    f.stdout.write(`${JSON.stringify({ method: "error", params: { message: "stale notification" } })}\n`);
    f.stderr.write("stale diagnostic\n");
    next.child.emit("exit", 1, null);
    const errors = f.events.filter(event => event.kind === "agent.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).not.toContain("stale");
  });
});
