import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);

try {
  const binding = require(workerData.bindingPath);
  const server = binding.createSecureNamedPipeServer({
    pipeName: workerData.pipeName,
    allowedUserSid: workerData.userSid,
    maxInstances: 2,
    inboundBufferBytes: 4096,
    outboundBufferBytes: 4096,
  });
  parentPort.postMessage({ type: "ready" });
  const connection = binding.acceptSecureNamedPipeConnection(server);
  let preReadPeerRejected = false;
  try {
    binding.getSecureNamedPipePeerIdentity(connection);
  } catch (error) {
    preReadPeerRejected = error?.code === "PROSPERO_NATIVE_ACCESS_DENIED";
  }
  if (!preReadPeerRejected) {
    throw new Error("peer identity must be rejected until the first authentication frame is read");
  }
  const input = binding.readSecureNamedPipeConnection(connection, 1024);
  const peer = binding.getSecureNamedPipePeerIdentity(connection);
  binding.writeSecureNamedPipeConnection(connection, input);
  binding.disconnectSecureNamedPipeConnection(connection);
  binding.closeSecureNamedPipeConnection(connection);
  binding.closeSecureNamedPipeServer(server);
  parentPort.postMessage({ type: "complete", peer, preReadPeerRejected });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    name: error instanceof Error ? error.name : "NativePipeError",
    message: error instanceof Error ? error.message : String(error),
  });
}
