import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { observeWorkerMessages } from "./worker-message-observer.js";

const STARTUP_TIMEOUT_MS = 5_000;

async function terminateWorker(worker: Worker | undefined): Promise<void> {
  if (worker) await worker.terminate();
}

describe("buffered worker message observer", () => {
  it("retains a fast ready message until another worker handshake completes", async () => {
    let fast: Worker | undefined;
    let slow: Worker | undefined;
    try {
      fast = new Worker(`
        const { parentPort } = require("node:worker_threads");
        parentPort.postMessage({ type: "ready", phase: "fast-ready" });
        parentPort.once("message", () => parentPort.postMessage({ type: "ready-sent", phase: "fast-confirmed" }));
      `, { eval: true });
      const fastMessages = observeWorkerMessages(fast);

      slow = new Worker(`
        const { parentPort } = require("node:worker_threads");
        parentPort.once("message", () => parentPort.postMessage({ type: "ready", phase: "slow-ready" }));
      `, { eval: true });
      const slowMessages = observeWorkerMessages(slow);

      // `ready-sent` is emitted after `ready`; wait for it before beginning
      // the other worker's handshake, then ask for the already-sent ready.
      const fastConfirmed = fastMessages.waitFor("ready-sent", STARTUP_TIMEOUT_MS);
      const slowReady = slowMessages.waitFor("ready", STARTUP_TIMEOUT_MS);
      fast.postMessage({ action: "confirm-ready" });
      await fastConfirmed;
      slow.postMessage({ action: "complete-handshake" });
      await slowReady;

      await expect(fastMessages.waitFor("ready", STARTUP_TIMEOUT_MS)).resolves.toMatchObject({
        phase: "fast-ready",
      });
    } finally {
      await Promise.all([terminateWorker(fast), terminateWorker(slow)]);
    }
  });
});
