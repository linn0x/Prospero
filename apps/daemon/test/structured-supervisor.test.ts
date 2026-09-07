import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  startStructuredSupervisor,
  type SupervisorEvent,
  type SupervisorAdapterContext,
} from "../src/structured-supervisor.js";
import { SupervisorEventDatabase } from "../src/supervisor-event-database.js";

const homes: string[] = [];
const children: ChildProcess[] = [];

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-structured-supervisor-"));
  homes.push(home);
  return home;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Ready {
  socketPath: string;
  token: string;
}

class SupervisorClient {
  readonly events: SupervisorEvent[] = [];
  private nextId = 1;
  private buffer = "";
  private readonly waiting = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(
    private readonly socket: Socket,
    private readonly token: string,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("supervisor socket closed")));
  }

  static async connect(socketPath: string, token: string): Promise<SupervisorClient> {
    const socket = createConnection(socketPath);
    await once(socket, "connect");
    return new SupervisorClient(socket, token);
  }

  request<T>(
    method: string,
    params: Record<string, unknown>,
    version = SUPERVISOR_PROTOCOL_VERSION,
  ): Promise<T> {
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      this.waiting.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket.write(`${JSON.stringify({ version, id, method, params, token: this.token })}\n`);
    return response;
  }

  async waitForEvents(count: number): Promise<void> {
    const until = Date.now() + 2_000;
    while (this.events.length < count && Date.now() < until) await delay(10);
    if (this.events.length < count) throw new Error(`expected ${count} events, got ${this.events.length}`);
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message["version"] !== SUPERVISOR_PROTOCOL_VERSION) {
        this.rejectAll(new Error("unexpected supervisor protocol version"));
        return;
      }
      if (message["method"] === "session.event") {
        this.events.push(message["params"] as SupervisorEvent);
        continue;
      }
      if (typeof message["id"] !== "number") continue;
      const waiting = this.waiting.get(message["id"]);
      if (!waiting) continue;
      this.waiting.delete(message["id"]);
      if (message["ok"] === true) waiting.resolve(message["result"]);
      else waiting.reject(new Error(String((message["error"] as { message?: unknown } | undefined)?.message ?? "request failed")));
    }
  }

  private rejectAll(error: Error): void {
    for (const waiting of this.waiting.values()) waiting.reject(error);
    this.waiting.clear();
  }
}

async function startChild(home: string): Promise<Ready> {
  const fixture = path.join(import.meta.dirname, "fixtures", "structured-supervisor-child.mjs");
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, PROSPERO_TEST_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const until = Date.now() + 5_000;
  while (!stdout.includes("\n") && Date.now() < until && child.exitCode === null) await delay(10);
  if (!stdout.includes("\n")) throw new Error(`supervisor child did not become ready: ${stderr}`);
  return JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as Ready;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(2_000)]);
    }
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("structured supervisor transport", () => {
  it.skipIf(process.platform === "win32")("keeps a long fake-adapter turn running across daemon-client disconnect and replays each event once", async () => {
    const home = tempHome();
    const ready = await startChild(home);
    if (process.platform !== "win32") {
      expect(statSync(ready.socketPath).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(home, "supervisor.token")).mode & 0o777).toBe(0o600);
    }

    const first = await SupervisorClient.connect(ready.socketPath, ready.token);
    const initial = await first.request<{ events: SupervisorEvent[]; lastSeq: number; gap: boolean }>(
      "session.subscribe",
      { sessionId: "fake-long-turn", afterSeq: 0 },
    );
    expect(initial.gap).toBe(false);
    expect(initial.events.map((event) => event.seq)).toEqual([1]);
    await first.request("session.send", { sessionId: "fake-long-turn", text: "continue" });
    // Models the daemon process disappearing. No supervisor RPC requests kill the turn.
    first.close();

    await delay(130); // fake progress is now durable; completion remains in the future.
    const second = await SupervisorClient.connect(ready.socketPath, ready.token);
    const replay = await second.request<{ events: SupervisorEvent[]; lastSeq: number; gap: boolean }>(
      "session.subscribe",
      { sessionId: "fake-long-turn", afterSeq: initial.lastSeq },
    );
    expect(replay.gap).toBe(false);
    expect(replay.events.map((event) => event.seq)).toEqual([2]);
    await second.waitForEvents(1);
    expect(second.events.map((event) => event.seq)).toEqual([3]);

    const all = [...initial.events, ...replay.events, ...second.events];
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(new Set(all.map((event) => event.seq)).size).toBe(all.length);
    const database = new SupervisorEventDatabase(path.join(home, "supervisor.sqlite"), { readOnly: true });
    try {
      expect(database.sessions()).toEqual([expect.objectContaining({ id: "fake-long-turn", lastSeq: 3 })]);
      expect(database.replay(database.sessions()[0]!, 0).map((event) => event.seq)).toEqual([1, 2, 3]);
    } finally { database.close(); }
    expect(existsSync(path.join(home, "state.json"))).toBe(false);
    second.close();
  });

  it.skipIf(process.platform === "win32")("treats explicit session.kill differently from a disconnected daemon client", async () => {
    const ready = await startChild(tempHome());
    const client = await SupervisorClient.connect(ready.socketPath, ready.token);
    await client.request("session.send", { sessionId: "fake-long-turn", text: "must-not-run" });
    await client.request("session.kill", { sessionId: "fake-long-turn" });
    await delay(400);
    await expect(client.request("session.status", { sessionId: "fake-long-turn" }))
      .resolves.toEqual({ status: "killed", lastSeq: 1 });
    expect(client.events).toEqual([]);
    client.close();
  });

  it.skipIf(process.platform === "win32")("rejects an incompatible protocol version and will not unlink a live supervisor socket", async () => {
    const home = tempHome();
    const incumbent = await startStructuredSupervisor({ home });
    try {
      const client = await SupervisorClient.connect(incumbent.socketPath, incumbent.token);
      await expect(
        client.request("session.status", { sessionId: "fake-long-turn" }, SUPERVISOR_PROTOCOL_VERSION + 1),
      ).rejects.toThrow("协议版本不兼容");
      client.close();
      await expect(startStructuredSupervisor({ home })).rejects.toMatchObject({
        code: "socket_path_occupied",
      });
    } finally {
      await incumbent.close();
    }
  });

  it.skipIf(process.platform === "win32")("stores dense deltas incrementally and restores the compatibility replay window without discarding durable events", async () => {
    const home = tempHome();
    let first = await startStructuredSupervisor({ home });
    try {
      await first.createSession("dense", {
        async start(context) {
          for (let index = 0; index < 4_200; index++) {
            context.emit({ kind: "text.delta", msgId: "dense", textId: "dense", delta: String(index) });
          }
          context.emit({ kind: "turn.end", msgId: "dense", inputTokens: 1, outputTokens: 1 });
          setTimeout(() => context.emit({ kind: "text.delta", msgId: "dense", textId: "dense", delta: "tail" }), 5).unref();
        },
      });
      await delay(30);
      const database = new SupervisorEventDatabase(path.join(home, "supervisor.sqlite"), { readOnly: true });
      try {
        expect(database.sessions()[0]?.lastSeq).toBe(4_202);
        expect(database.countEvents("dense")).toBe(4_202);
      } finally { database.close(); }
      expect(existsSync(path.join(home, "state.json"))).toBe(false);
      expect(existsSync(path.join(home, "events.jsonl"))).toBe(false);

      await first.close();
      first = await startStructuredSupervisor({ home });
      const replay = first.replay("dense", 0);
      expect(replay.gap).toBe(true);
      expect(replay.events).toHaveLength(4_000);
      expect(replay.events[0]?.seq).toBe(203);
      expect(replay.events.at(-1)?.seq).toBe(4_202);
      expect(replay.events.every((event, index, all) => index === 0 || event.seq === all[index - 1]!.seq + 1)).toBe(true);
    } finally {
      await first.close();
    }
  });
});


describe.skipIf(process.platform === "win32")("supervisor durable-write failures", () => {
  it("allows retrying an explicit kill after its durable fence could not be written", async () => {
    const owner = await startStructuredSupervisor({ home: tempHome() });
    const kill = vi.fn(async () => {});
    let client: SupervisorClient | undefined;
    try {
      await owner.createSession("kill-retry", { start: async () => {}, kill });
      client = await SupervisorClient.connect(owner.socketPath, owner.token);
      const save = vi.spyOn(SupervisorEventDatabase.prototype, "saveSession").mockImplementationOnce(() => { throw new Error("disk full"); });
      try { await expect(client.request("session.kill", { sessionId: "kill-retry" })).rejects.toThrow("disk full"); }
      finally { save.mockRestore(); }
      expect(kill).not.toHaveBeenCalled();
      expect(await client.request("session.status", { sessionId: "kill-retry" })).toMatchObject({ status: "running" });
      await client.request("session.kill", { sessionId: "kill-retry" });
      expect(kill).toHaveBeenCalledTimes(1);
      expect(await client.request("session.status", { sessionId: "kill-retry" })).toMatchObject({ status: "killed" });
    } finally { client?.close(); await owner.close(); }
  });
  it("subscribes to the current cursor without materializing existing bodies", async () => {
    const owner = await startStructuredSupervisor({ home: tempHome() });
    let context!: SupervisorAdapterContext;
    let client: SupervisorClient | undefined;
    try {
      await owner.createSession("tail-only", { start: async (value) => { context = value; } });
      context.emit({ kind: "user.message", msgId: "large", text: "x".repeat(1024 * 1024) });
      client = await SupervisorClient.connect(owner.socketPath, owner.token);
      const replay = vi.spyOn(SupervisorEventDatabase.prototype, "replay").mockImplementation(() => { throw new Error("historical bodies must stay on disk"); });
      try {
        expect(await client.request("session.subscribe", { sessionId: "tail-only", tailOnly: true })).toMatchObject({ events: [], lastSeq: 1, gap: false });
        expect(replay).not.toHaveBeenCalled();
      } finally { replay.mockRestore(); }
      context.emit({ kind: "text.delta", msgId: "next", textId: "t", delta: "next" });
      await client.waitForEvents(1);
      expect(client.events.map((event) => event.seq)).toEqual([2]);
    } finally { client?.close(); await owner.close(); }
  });
  it("fences further commands and events after a replay commit fails", async () => {
    const home = tempHome();
    const owner = await startStructuredSupervisor({ home });
    let context!: SupervisorAdapterContext;
    const send = vi.fn(async () => {});
    let client: SupervisorClient | undefined;
    try {
      await owner.createSession("write-failure", { start: async (value) => { context = value; }, send });
      const append = vi.spyOn(SupervisorEventDatabase.prototype, "append").mockImplementationOnce(() => { throw new Error("disk full"); });
      try { expect(() => context.emit({ kind: "text.delta", msgId: "m", textId: "t", delta: "first" })).toThrow("历史写入失败"); }
      finally { append.mockRestore(); }
      expect(() => context.emit({ kind: "text.delta", msgId: "m", textId: "t", delta: "later" })).toThrow("历史写入失败");
      expect(owner.replay("write-failure", 0).lastSeq).toBe(0);
      client = await SupervisorClient.connect(owner.socketPath, owner.token);
      await expect(client.request("session.send", { sessionId: "write-failure", text: "must-not-run" })).rejects.toThrow("历史写入失败");
      expect(send).not.toHaveBeenCalled();
      expect(await client.request("session.status", { sessionId: "write-failure" })).toMatchObject({ status: "failed", lastSeq: 0 });
    } finally { client?.close(); await owner.close(); }
  });
});
