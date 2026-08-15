import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);

let server;
let connection;
let phase = "create";
let binding;

function reportFailure(error) {
  parentPort.postMessage({
    type: "error",
    phase,
    name: error instanceof Error ? error.name : "NativePipeError",
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  });
}

function beginPhase(nextPhase) {
  phase = nextPhase;
  parentPort.postMessage({ type: "phase", phase });
}

function completePhase(nextPhase) {
  if (workerData.failAfterPhase === nextPhase) {
    throw new Error(`injected native pipe worker failure after ${nextPhase}`);
  }
}

try {
  binding = require(workerData.bindingPath);
  server = binding.createSecureNamedPipeServer({
    pipeName: workerData.pipeName,
    maxInstances: 2,
    inboundBufferBytes: 4096,
    outboundBufferBytes: 4096,
  });
  parentPort.postMessage({ type: "ready" });
  beginPhase("accept");
  connection = binding.acceptSecureNamedPipeConnection(server);
  completePhase("accept");
  beginPhase("pre-read-peer");
  let preReadPeerRejected = false;
  try {
    binding.getSecureNamedPipePeerIdentity(connection);
  } catch (error) {
    preReadPeerRejected = error?.code === "PROSPERO_NATIVE_ACCESS_DENIED";
  }
  if (!preReadPeerRejected) {
    throw new Error("peer identity must be rejected until the first non-empty read verifies OS peer identity");
  }
  let preReadWriteRejected = false;
  try {
    binding.writeSecureNamedPipeConnection(connection, Buffer.from("unauthenticated"));
  } catch (error) {
    preReadWriteRejected = error?.code === "PROSPERO_NATIVE_ACCESS_DENIED";
  }
  if (!preReadWriteRejected) {
    throw new Error("writes must be rejected until the first non-empty read verifies OS peer identity");
  }
  completePhase("pre-read-peer");
  beginPhase("read");
  const input = binding.readSecureNamedPipeConnection(connection, 1024);
  completePhase("read");
  beginPhase("peer-identity");
  const peer = binding.getSecureNamedPipePeerIdentity(connection);
  completePhase("peer-identity");
  beginPhase("write");
  binding.writeSecureNamedPipeConnection(connection, input);
  completePhase("write");
  beginPhase("disconnect");
  binding.disconnectSecureNamedPipeConnection(connection);
  binding.closeSecureNamedPipeConnection(connection);
  connection = undefined;
  binding.closeSecureNamedPipeServer(server);
  server = undefined;
  completePhase("disconnect");
  parentPort.postMessage({ type: "complete", peer, preReadPeerRejected, preReadWriteRejected });
} catch (error) {
  reportFailure(error);
} finally {
  // Failure diagnostics are sent before endpoint cleanup, guaranteeing the
  // parent can attribute a subsequent client EPIPE to the server phase.
  try {
    if (connection !== undefined) {
      try {
        binding?.disconnectSecureNamedPipeConnection(connection);
      } catch {
        // A failed authentication or a peer close may already have torn down
        // the OS endpoint; the final close remains required either way.
      }
      binding?.closeSecureNamedPipeConnection(connection);
    }
  } catch {
    // Do not replace the original server error with best-effort cleanup.
  }
  try {
    if (server !== undefined) binding?.closeSecureNamedPipeServer(server);
  } catch {
    // Do not replace the original server error with best-effort cleanup.
  }
}
