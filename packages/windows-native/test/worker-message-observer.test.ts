import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { observeWorkerMessages } from "./worker-message-observer.js";

const STARTUP_TIMEOUT_MS = 5_000;

async function terminateWorker(worker: Worker | undefined): Promise<void> {
  if (worker) await worker.terminate();
}

function waitForWorkerExit(worker: Worker): Promise<number> {
  return new Promise((resolve) => worker.once("exit", resolve));
}

function waitForWorkerMessage(worker: Worker): Promise<void> {
  return new Promise((resolve) => worker.once("message", () => resolve()));
}

function waitForWorkerError(worker: Worker): Promise<Error> {
  return new Promise((resolve) => worker.once("error", resolve));
}

describe("buffered worker message observer", () => {
  it("keeps received messages FIFO-readable after a clean exit and rejects absent phases", async () => {
    let worker: Worker | undefined;
    try {
      worker = new Worker(`
        const { parentPort } = require("node:worker_threads");
        parentPort.once("message", () => {
          parentPort.postMessage({ type: "ready", phase: "first-ready" });
          parentPort.postMessage({ type: "ready", phase: "second-ready" });
          parentPort.postMessage({ type: "ready-sent", phase: "ready-confirmed" });
          parentPort.close();
        });
      `, { eval: true });
      const messages = observeWorkerMessages(worker);
      const exited = waitForWorkerExit(worker);
      const pendingAbsent = messages.waitFor("pending-absent", STARTUP_TIMEOUT_MS);

      worker.postMessage({ action: "send-and-exit" });
      await expect(exited).resolves.toBe(0);

      await expect(messages.waitFor("ready", STARTUP_TIMEOUT_MS)).resolves.toMatchObject({ phase: "first-ready" });
      await expect(messages.waitFor("ready", STARTUP_TIMEOUT_MS)).resolves.toMatchObject({ phase: "second-ready" });
      await expect(messages.waitFor("ready-sent", STARTUP_TIMEOUT_MS)).resolves.toMatchObject({
        phase: "ready-confirmed",
      });
      await expect(pendingAbsent).rejects.toThrow("Pipe worker exited before its expected phase (0)");
      await expect(messages.waitFor("after-exit-absent", STARTUP_TIMEOUT_MS)).rejects.toThrow(
        "Pipe worker exited before its expected phase (0)",
      );
    } finally {
      await terminateWorker(worker);
    }
  });

  it("keeps messages received before a worker error readable", async () => {
    let worker: Worker | undefined;
    try {
      worker = new Worker(`
        const { parentPort } = require("node:worker_threads");
        parentPort.on("message", ({ action }) => {
          if (action === "send-ready") {
            parentPort.postMessage({ type: "ready", phase: "before-error" });
            return;
          }
          if (action === "fail") throw new Error("intentional observer worker failure");
        });
      `, { eval: true });
      const messages = observeWorkerMessages(worker);
      const received = waitForWorkerMessage(worker);
      const exited = waitForWorkerExit(worker);

      worker.postMessage({ action: "send-ready" });
      await received;
      const errored = waitForWorkerError(worker);
      worker.postMessage({ action: "fail" });
      await expect(errored).resolves.toMatchObject({ message: "intentional observer worker failure" });
      await expect(exited).resolves.toBe(1);

      await expect(messages.waitFor("ready", STARTUP_TIMEOUT_MS)).resolves.toMatchObject({ phase: "before-error" });
      await expect(messages.waitFor("after-error-absent", STARTUP_TIMEOUT_MS)).rejects.toThrow(
        "intentional observer worker failure",
      );
    } finally {
      await terminateWorker(worker);
    }
  });

  it("does not lose fast-worker messages while a slower worker completes", async () => {
    let fast: Worker | undefined;
    let slow: Worker | undefined;
    try {
      fast = new Worker(`
        const { parentPort } = require("node:worker_threads");
        parentPort.once("message", () => {
          parentPort.postMessage({ type: "ready", phase: "fast-ready" });
          parentPort.postMessage({ type: "ready-sent", phase: "fast-confirmed" });
          parentPort.close();
        });
      `, { eval: true });
      const fastMessages = observeWorkerMessages(fast);
      const fastExited = waitForWorkerExit(fast);

      slow = new Worker(`
        const { parentPort } = require("node:worker_threads");
        parentPort.once("message", () => {
          parentPort.postMessage({ type: "ready", phase: "slow-ready" });
          parentPort.close();
        });
      `, { eval: true });
      const slowMessages = observeWorkerMessages(slow);
      const slowExited = waitForWorkerExit(slow);

      fast.postMessage({ action: "send-and-exit" });
      await expect(fastExited).resolves.toBe(0);
      slow.postMessage({ action: "complete-handshake" });
      await expect(slowExited).resolves.toBe(0);

      await expect(fastMessages.waitFor("ready", STARTUP_TIMEOUT_MS)).resolves.toMatchObject({
        phase: "fast-ready",
      });
      await expect(fastMessages.waitFor("ready-sent", STARTUP_TIMEOUT_MS)).resolves.toMatchObject({
        phase: "fast-confirmed",
      });
      await expect(slowMessages.waitFor("ready", STARTUP_TIMEOUT_MS)).resolves.toMatchObject({ phase: "slow-ready" });
    } finally {
      await Promise.all([terminateWorker(fast), terminateWorker(slow)]);
    }
  });
});
