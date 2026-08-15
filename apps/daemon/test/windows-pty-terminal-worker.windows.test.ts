/** Real Windows N-API vertical: the terminal worker owns ConPTY and its Job. */
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

// This runs in the signed-artifact Windows release job. Normal PR CI still
// exercises the raw native ConPTY suite before an Authenticode artifact exists.
const describeWindows = process.platform === "win32" && process.env["PROSPERO_WINDOWS_SIGNED_SESSION_HOST_TEST"] === "1"
  ? describe
  : describe.skip;

interface Reply { readonly id?: number; readonly ok?: boolean; readonly error?: string; readonly type?: string; readonly data?: Uint8Array; }
interface HandleOwnerReply { readonly id?: number; readonly ok?: boolean; readonly error?: string; readonly token?: bigint; }

function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

describeWindows.sequential("Windows Session Host ConPTY terminal worker", () => {
  it("drains UTF-8 output, accepts raw terminal input, and Job-kills a provider tree", async () => {
    const worker = new Worker(new URL("../dist/windows-pty-terminal-worker.js", import.meta.url));
    const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
    let nextId = 1;
    let output = "";
    const decoder = new TextDecoder();
    worker.on("message", (message: Reply) => {
      if (message.type === "output" && message.data instanceof Uint8Array) {
        output += decoder.decode(message.data, { stream: true });
        return;
      }
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve();
      else request.reject(new Error(message.error ?? "terminal worker request failed"));
    });
    const call = (op: string, args: Record<string, unknown> = {}): Promise<void> => {
      const id = nextId++;
      return new Promise<void>((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject });
        worker.postMessage({ id, op, args });
      });
    };
    const until = async (marker: string): Promise<void> => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (output.includes(marker)) return;
        await delay(25);
      }
      throw new Error(`timed out waiting for ${marker}; received ${output}`);
    };
    const provider = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(`PROSPERO_HOST_READY:${process.pid}:${grandchild.pid}\\n你好🙂\\n`);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (data) => process.stdout.write(`PROSPERO_HOST_INPUT:${JSON.stringify(data)}\\n`));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    try {
      await call("start", { options: {
        executablePath: process.execPath,
        arguments: ["-e", provider],
        columns: 80,
        rows: 24,
        environment: {
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
        },
      } });
      await until("你好");
      await call("resize", { cols: 120, rows: 40 });
      await call("input", { data: new TextEncoder().encode("hello\r") });
      await until("PROSPERO_HOST_INPUT:\"hello\\r\\n\"");
      const match = output.match(/PROSPERO_HOST_READY:(\d+):(\d+)/);
      expect(match).not.toBeNull();
      await call("kill");
      for (const pid of [Number(match?.[1]), Number(match?.[2])]) {
        let exited = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { process.kill(pid, 0); } catch { exited = true; break; }
          await delay(25);
        }
        expect(exited).toBe(true);
      }
    } finally {
      await call("close").catch(() => {});
      await worker.terminate();
    }
  });

  it("closes its provider Job when an idle terminal worker crashes, killing provider and grandchild", async () => {
    const worker = new Worker(new URL("../dist/windows-pty-terminal-worker.js", import.meta.url));
    const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
    let nextId = 1;
    let output = "";
    const decoder = new TextDecoder();
    worker.on("message", (message: Reply) => {
      if (message.type === "output" && message.data instanceof Uint8Array) {
        output += decoder.decode(message.data, { stream: true });
        return;
      }
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve();
      else request.reject(new Error(message.error ?? "terminal worker request failed"));
    });
    const call = (op: string, args: Record<string, unknown> = {}): Promise<void> => {
      const id = nextId++;
      return new Promise<void>((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject: reject });
        worker.postMessage({ id, op, args });
      });
    };
    const until = async (marker: string): Promise<void> => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (output.includes(marker)) return;
        await delay(25);
      }
      throw new Error(`timed out waiting for ${marker}; received ${output}`);
    };
    const provider = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(`PROSPERO_IDLE_READY:${process.pid}:${grandchild.pid}\\n`);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    try {
      await call("start", { options: {
        executablePath: process.execPath,
        arguments: ["-e", provider],
        columns: 80,
        rows: 24,
        environment: {
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
        },
      } });
      await until("PROSPERO_IDLE_READY:");
      const match = output.match(/PROSPERO_IDLE_READY:(\d+):(\d+)/);
      expect(match).not.toBeNull();
      // Do not issue close/kill RPCs. Worker.terminate() bypasses the JS
      // process-exit hook, so native napi_env teardown must close the
      // KILL_ON_JOB_CLOSE handle and contain the complete tree.
      await worker.terminate();
      for (const pid of [Number(match?.[1]), Number(match?.[2])]) {
        let exited = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { process.kill(pid, 0); } catch { exited = true; break; }
          await delay(25);
        }
        expect(exited).toBe(true);
      }
    } finally {
      await worker.terminate().catch(() => {});
    }
  });

  it("keeps native Job tokens scoped to their Worker napi_env", async () => {
    const createOwner = () => new Worker(new URL("./fixtures/windows-native-handle-owner-worker.mjs", import.meta.url));
    const ownerA = createOwner();
    const ownerB = createOwner();
    const pending = new Map<number, { resolve(reply: HandleOwnerReply): void; reject(error: Error): void }>();
    let nextId = 1;
    const onMessage = (reply: HandleOwnerReply) => {
      if (typeof reply.id !== "number") return;
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      if (reply.ok) request.resolve(reply);
      else request.reject(new Error(reply.error ?? "native handle-owner request failed"));
    };
    ownerA.on("message", onMessage);
    ownerB.on("message", onMessage);
    const call = (owner: Worker, op: string, token?: bigint): Promise<HandleOwnerReply> => {
      const id = nextId++;
      return new Promise<HandleOwnerReply>((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject });
        owner.postMessage({ id, op, token });
      });
    };
    try {
      await call(ownerA, "create");
      const ownerBJob = (await call(ownerB, "create")).token;
      expect(ownerBJob).toBeTypeOf("bigint");

      // A process-wide registry must not make one Worker capable of using a
      // token created by another N-API environment.
      await expect(call(ownerA, "foreignTerminate", ownerBJob)).rejects.toThrow(/unknown or closed/i);

      // Terminating A removes and closes only A's native entries. B's Job
      // remains valid and can still be terminated and closed by its owner.
      await ownerA.terminate();
      await expect(call(ownerB, "probe")).resolves.toMatchObject({ ok: true });
      await expect(call(ownerB, "close")).resolves.toMatchObject({ ok: true });
    } finally {
      await ownerA.terminate().catch(() => {});
      await ownerB.terminate().catch(() => {});
    }
  });
});
