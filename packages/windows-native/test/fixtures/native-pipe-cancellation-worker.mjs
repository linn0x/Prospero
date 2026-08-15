import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);

function failure(error) {
  return {
    type: "error",
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
    parentPort.postMessage({ type: "control-ready" });
    parentPort.on("message", (message) => {
      try {
        if (!message || typeof message !== "object" || typeof message.handle !== "bigint") {
          throw new Error("cancellation command lacks a native handle");
        }
        if (message.action === "close-server") {
          binding.closeSecureNamedPipeServer(message.handle);
        } else if (message.action === "disconnect-connection") {
          binding.disconnectSecureNamedPipeConnection(message.handle);
        } else {
          throw new Error("unknown cancellation command");
        }
        parentPort.postMessage({ type: "control-complete", action: message.action });
      } catch (error) {
        parentPort.postMessage(failure(error));
      }
    });
  } else {
    const server = binding.createSecureNamedPipeServer({
      pipeName: workerData.pipeName,
      maxInstances: 1,
      inboundBufferBytes: 4096,
      outboundBufferBytes: 4096,
    });
    parentPort.postMessage({ type: "server-ready", server });

    if (workerData.scenario === "idle-accept") {
      // postMessage is ordered before the following synchronous native call;
      // the controller is released only after this worker enters the accept
      // path and has no further event-loop turn available to process input.
      parentPort.postMessage({ type: "blocking", operation: "accept" });
      let code = "unexpected-success";
      try {
        binding.acceptSecureNamedPipeConnection(server);
      } catch (error) {
        code = errorCode(error);
      }
      // The control worker consumed this registry handle. Deliberately do not
      // close it again: production drops its stale owner token after cancel.
      parentPort.postMessage({ type: "unblocked", operation: "accept", code, ownerClose: "control-only" });
    } else if (workerData.scenario === "active-read") {
      const connection = binding.acceptSecureNamedPipeConnection(server);
      parentPort.postMessage({ type: "connection-ready", connection });
      parentPort.postMessage({ type: "blocking", operation: "read" });
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
      parentPort.postMessage({ type: "unblocked", operation: "read", code, ownerClose: "primary-after-disconnect" });
    } else {
      throw new Error("unknown primary cancellation scenario");
    }
  }
} catch (error) {
  parentPort.postMessage(failure(error));
}
