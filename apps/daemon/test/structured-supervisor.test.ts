import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SupervisorEvent } from "../src/structured-supervisor.js";

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

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      this.waiting.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket.write(`${JSON.stringify({ id, method, params, token: this.token })}\n`);
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
  it("keeps a long fake-adapter turn running across daemon-client disconnect and replays each event once", async () => {
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
    expect(JSON.parse(readFileSync(path.join(home, "state.json"), "utf8")))
      .toEqual(expect.objectContaining({
        sessions: [expect.objectContaining({
          id: "fake-long-turn",
          lastSeq: 3,
          events: expect.arrayContaining([expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 3 })]),
        })],
      }));
    second.close();
  });

  it("treats explicit session.kill differently from a disconnected daemon client", async () => {
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
});
