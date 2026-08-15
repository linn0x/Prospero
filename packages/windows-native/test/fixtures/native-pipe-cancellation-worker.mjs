import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);

function failure(error, phase) {
  return {
    type: "error",
    phase,
    name: error instanceof Error ? error.name : "NativePipeCancellationError",
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" ? error.code : undefined,
  };
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : "unknown";
}

try {
  // Each worker deliberately loads the same exact .node file. The test must
  // prove that the opaque handle registry is process-wide, not isolate-local.
  const binding = require(workerData.bindingPath);
  if (workerData.role === "control") {
    binding.getCurrentProcessIdentity();
    parentPort.postMessage({ type: "control-ready", phase: "ready" });
    parentPort.on("message", (message) => {
      let phase = "close-command";
      try {
        if (!message || typeof message !== "object" || typeof message.handle !== "bigint") {
          throw new Error("cancellation command lacks a native handle");
        }
        if (message.action === "close-server") {
          phase = "close-server";
          parentPort.postMessage({ type: "close-started", action: message.action, phase });
          binding.closeSecureNamedPipeServer(message.handle);
        } else if (message.action === "disconnect-connection") {
          phase = "disconnect-connection";
          parentPort.postMessage({ type: "close-started", action: message.action, phase });
          binding.disconnectSecureNamedPipeConnection(message.handle);
        } else {
          throw new Error("unknown cancellation command");
        }
        parentPort.postMessage({ type: "control-complete", action: message.action, phase: "closed" });
      } catch (error) {
        parentPort.postMessage(failure(error, phase));
      }
    });
  } else {
    const server = binding.createSecureNamedPipeServer({
      pipeName: workerData.pipeName,
      maxInstances: 1,
      inboundBufferBytes: 4096,
      outboundBufferBytes: 4096,
    });
    parentPort.postMessage({ type: "server-ready", server, phase: "ready" });

    if (workerData.scenario === "idle-accept") {
      // The parent installs every close listener before it releases this
      // worker. `accept-started` marks the phase immediately before the
      // synchronous native call, so a failure reports whether it stalled in
      // setup, close, or the cancelled accept itself.
      parentPort.postMessage({ type: "accept-ready", phase: "ready-for-accept" });
      parentPort.once("message", (message) => {
        if (!message || message.action !== "start-idle-accept") {
          parentPort.postMessage(failure(new Error("missing start-idle-accept command"), "accept-ready"));
          return;
        }
        parentPort.postMessage({ type: "accept-started", operation: "accept", phase: "ConnectNamedPipe" });
        let code = "unexpected-success";
        try {
          binding.acceptSecureNamedPipeConnection(server);
        } catch (error) {
          code = errorCode(error);
        }
        // The control worker consumed this registry handle. Deliberately do
        // not close it again: production drops its stale owner token after
        // cancellation, so there is exactly one CloseHandle owner.
        parentPort.postMessage({
          type: "unblocked",
          operation: "accept",
          code,
          ownerClose: "control-only",
          phase: "accept-unblocked",
        });
      });
    } else if (workerData.scenario === "active-read") {
      const connection = binding.acceptSecureNamedPipeConnection(server);
      parentPort.postMessage({ type: "connection-ready", connection, phase: "connected" });
      parentPort.postMessage({ type: "blocking", operation: "read", phase: "ReadFile" });
      let code = "unexpected-success";
      try {
        binding.readSecureNamedPipeConnection(connection, 4096);
      } catch (error) {
        code = errorCode(error);
      }
      // The control worker only disconnected the borrowed endpoint. The I/O
      // owner performs the single final close after ReadFile unwinds.
      binding.closeSecureNamedPipeConnection(connection);
      binding.closeSecureNamedPipeServer(server);
      parentPort.postMessage({
        type: "unblocked",
        operation: "read",
        code,
        ownerClose: "primary-after-disconnect",
        phase: "read-unblocked",
      });
    } else {
      throw new Error("unknown primary cancellation scenario");
    }
  }
} catch (error) {
  parentPort.postMessage(failure(error, "worker-startup"));
}
