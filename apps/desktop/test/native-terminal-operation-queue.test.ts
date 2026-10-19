import { expect, it } from "vitest";
import { NativeTerminalOperationQueue, type NativeTerminalOperation } from "../src/main/native-terminal-operation-queue";

it("recovers queue capacity after a synchronous executor failure", async () => {
  let attempts = 0;
  const queue = new NativeTerminalOperationQueue(() => {
    if (++attempts === 1) throw new Error("closed transport");
    return Promise.resolve();
  }, 8, 4);
  await expect(queue.enqueueInput(new Uint8Array(8))).rejects.toThrow("closed transport");
  await expect(queue.enqueueInput(new Uint8Array(8))).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});

it("coalesces a 50-frame wheel burst behind the in-flight input into one operation", async () => {
  const outputs: Uint8Array[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const queue = new NativeTerminalOperationQueue(async (operation: NativeTerminalOperation) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (operation.kind === "input") {
        outputs.push(operation.bytes);
        if (outputs.length === 1) await firstGate;
      }
    } finally { active -= 1; }
  });

  const first = queue.enqueueInput(new TextEncoder().encode("key"));
  const wheelFrames = Array.from({ length: 50 }, (_, index) => Uint8Array.of(27, 91, 77, 32, 64 + (index % 32), 65 + (index % 16)));
  const accepted = wheelFrames.map(frame => queue.enqueueInput(frame));

  await Promise.resolve();
  expect(outputs).toHaveLength(1);
  releaseFirst();
  await Promise.all([first, ...accepted]);
  expect(outputs).toHaveLength(2);
  const expected = new Uint8Array(wheelFrames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of wheelFrames) { expected.set(frame, offset); offset += frame.length; }
  expect(outputs[0]).toEqual(new TextEncoder().encode("key"));
  expect(outputs[1]).toEqual(expected);
  expect(maximumActive).toBe(1);
});

it("preserves mixed UTF-8 and key bytes without merging across resize boundaries", async () => {
  const operations: NativeTerminalOperation[] = [];
  const queue = new NativeTerminalOperationQueue(async operation => { operations.push(operation); });
  await queue.enqueueInput(Uint8Array.of(27, 91, 65));
  const beforeResize = queue.enqueueInput(new TextEncoder().encode("中文"));
  const resize = queue.enqueueResize(90, 30);
  const afterResizeA = queue.enqueueInput(Uint8Array.of(13));
  const afterResizeB = queue.enqueueInput(Uint8Array.of(27, 91, 66));
  await Promise.all([beforeResize, resize, afterResizeA, afterResizeB]);
  expect(operations).toEqual([
    { kind: "input", bytes: Uint8Array.of(27, 91, 65) },
    { kind: "input", bytes: new TextEncoder().encode("中文") },
    { kind: "resize", columns: 90, rows: 30 },
    { kind: "input", bytes: Uint8Array.of(13, 27, 91, 66) },
  ]);
});

it("does not replay a rejected input and continues with the next command", async () => {
  const seen: string[] = [];
  const queue = new NativeTerminalOperationQueue(async operation => {
    if (operation.kind === "input") {
      const text = new TextDecoder().decode(operation.bytes);
      seen.push(text);
      if (text === "uncertain") throw new Error("busy");
    }
  });

  await expect(queue.enqueueInput(new TextEncoder().encode("uncertain"))).rejects.toThrow("busy");
  await queue.enqueueInput(new TextEncoder().encode("user retry"));
  expect(seen).toEqual(["uncertain", "user retry"]);
});

it("bounds queued input and releases capacity after the in-flight write settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queue = new NativeTerminalOperationQueue(async () => gate, 8, 4);
  const first = queue.enqueueInput(new Uint8Array(8));
  const second = queue.enqueueInput(new Uint8Array(1));
  await expect(second).rejects.toThrow("queue is full");
  release();
  await first;
  await expect(queue.enqueueInput(new Uint8Array(8))).resolves.toBeUndefined();
});

it("bounds waiter count even when many inputs coalesce", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: Uint8Array[] = [];
  const queue = new NativeTerminalOperationQueue(async operation => {
    if (operation.kind === "input") {
      seen.push(operation.bytes);
      if (seen.length === 1) await gate;
    }
  }, 100, 10, 3);
  const active = queue.enqueueInput(Uint8Array.of(1));
  const second = queue.enqueueInput(Uint8Array.of(2));
  const third = queue.enqueueInput(Uint8Array.of(3));
  await expect(queue.enqueueInput(Uint8Array.of(4))).rejects.toThrow("queue is full");
  release();
  await Promise.all([active, second, third]);
  expect(seen).toEqual([Uint8Array.of(1), Uint8Array.of(2, 3)]);
});

it("rejects active and queued waiters on close without replaying the active write", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: number[] = [];
  const queue = new NativeTerminalOperationQueue(async operation => {
    if (operation.kind === "input") {
      seen.push(...operation.bytes);
      if (seen.length === 1) await gate;
    }
  });
  const active = queue.enqueueInput(Uint8Array.of(1));
  const queued = queue.enqueueInput(Uint8Array.of(2));
  queue.close(new Error("surface closed"));
  await expect(active).rejects.toThrow("surface closed");
  await expect(queued).rejects.toThrow("surface closed");
  await expect(queue.enqueueInput(Uint8Array.of(3))).rejects.toThrow("surface closed");
  release();
  await Promise.resolve();
  expect(seen).toEqual([1]);
});

it("splits a queued burst at the 8192-byte wire limit without losing bytes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: Uint8Array[] = [];
  const queue = new NativeTerminalOperationQueue(async operation => {
    if (operation.kind !== "input") return;
    seen.push(operation.bytes);
    if (seen.length === 1) await gate;
  });
  const active = queue.enqueueInput(Uint8Array.of(0));
  const a = queue.enqueueInput(new Uint8Array(8191).fill(1));
  const b = queue.enqueueInput(Uint8Array.of(2));
  const c = queue.enqueueInput(Uint8Array.of(3));
  release();
  await Promise.all([active, a, b, c]);
  expect(seen.map(bytes => bytes.length)).toEqual([1, 8192, 1]);
  expect(seen[1]!.slice(0, 8191)).toEqual(new Uint8Array(8191).fill(1));
  expect(seen[1]![8191]).toBe(2);
  expect(seen[2]).toEqual(Uint8Array.of(3));
});
