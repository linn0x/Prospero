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
  let handle: (request: Request) => void = () => {};
  const respond = (id: number | undefined, result: unknown): void => {
    stdout.write(`${JSON.stringify({ id, result })}\n`);
  };
  const stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)) as Request;
    requests.push(request);
    queueMicrotask(() => {
      if (request.method === "initialize") respond(request.id, {});
      else if (request.method === "thread/start" || request.method === "thread/resume") respond(request.id, { thread: { id: "main-thread" } });
      else handle(request);
    });
    done();
  } });
  Object.assign(child, { stdin, stdout, stderr, kill: vi.fn(() => true) });
  spawnMock.mockReturnValue(child);
  const adapter = new CodexAdapter({ resumeState });
  adapters.push(adapter);
  const context = { cwd: "/synthetic-workspace", emit: (event: AgentEventBody) => events.push(event) };
  return { adapter, child, requests, events, respond, context, onRequest: (callback: typeof handle) => { handle = callback; } };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
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
