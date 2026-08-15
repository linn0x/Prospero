/**
 * The only process which calls synchronous @prospero/windows-native methods.
 *
 * The addon intentionally rejects calls from Node's main thread. Keeping this
 * worker narrow also means a blocked pipe read can never stall WebSocket,
 * orchestration, or a session reducer.
 */
import { createHmac } from "node:crypto";
import { parentPort } from "node:worker_threads";
import {
  loadWindowsNative,
  type NativeWindowsBinding,
  type ProcessIdentity,
  type SecureNamedPipeConnectionHandle,
  type SecureNamedPipeServerHandle,
  type SecureStateDirectoryHandle,
} from "@prospero/windows-native";

if (!parentPort) throw new Error("Windows session host native worker requires a parent port");

interface Request {
  readonly id: number;
  readonly op: string;
  readonly args?: Record<string, unknown>;
}

let native: NativeWindowsBinding | null = null;
let stateDirectory: SecureStateDirectoryHandle | null = null;
let pipeServer: SecureNamedPipeServerHandle | null = null;
let pipeConnection: SecureNamedPipeConnectionHandle | null = null;
let peerIdentity: unknown = null;
let credential: Buffer | null = null;

function asBytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} must be Uint8Array`);
  return value;
}

function binding(): NativeWindowsBinding {
  if (!native) native = loadWindowsNative();
  return native;
}

function directory(): SecureStateDirectoryHandle {
  if (stateDirectory === null) throw new Error("secure state directory is not open");
  return stateDirectory;
}

function server(): SecureNamedPipeServerHandle {
  if (pipeServer === null) throw new Error("secure pipe server is not open");
  return pipeServer;
}

function connection(): SecureNamedPipeConnectionHandle {
  if (pipeConnection === null) throw new Error("secure pipe connection is not open");
  return pipeConnection;
}

function reply(id: number, ok: boolean, value?: unknown, error?: unknown): void {
  parentPort!.postMessage(ok ? { id, ok, value } : { id, ok, error: String(error) });
}

function hmac(material: Uint8Array): string {
  if (!credential) throw new Error("DPAPI credential is not loaded");
  return createHmac("sha256", credential).update(material).digest("base64");
}

function request(op: string, args: Record<string, unknown>): unknown {
  const addon = binding();
  switch (op) {
    case "initialize": {
      const report = addon.getAbiInfo();
      return { report, identity: addon.getCurrentProcessIdentity() };
    }
    case "openState": {
      const path = args["path"];
      if (typeof path !== "string") throw new Error("state path is invalid");
      // Never leave a stale opaque handle reachable if either close or the
      // replacement open fails.  A later request must fail closed instead of
      // accidentally targeting the previous session's state directory.
      const previous = stateDirectory;
      stateDirectory = null;
      if (previous !== null) addon.closeSecureStateDirectory(previous);
      stateDirectory = addon.openSecureStateDirectory({ path });
      return undefined;
    }
    case "state.read": {
      const name = args["name"];
      if (typeof name !== "string") throw new Error("state filename is invalid");
      try { return addon.readSecureStateFile(directory(), name); }
      catch (error) {
        // Native errors intentionally have no platform-stable class.  The
        // parent treats only this explicit absence value as an absent entry;
        // all other native failures remain unavailable at higher layers.
        if ((error as { code?: unknown } | null)?.code === "PROSPERO_NATIVE_NOT_FOUND") return null;
        throw error;
      }
    }
    case "state.write": {
      const name = args["name"];
      if (typeof name !== "string") throw new Error("state filename is invalid");
      addon.writeSecureStateFileAtomically(directory(), name, asBytes(args["bytes"], "state bytes"));
      return undefined;
    }
    case "state.remove": {
      const name = args["name"];
      if (typeof name !== "string") throw new Error("state filename is invalid");
      addon.removeSecureStateFile(directory(), name);
      return undefined;
    }
    case "credential.create": {
      const plain = asBytes(args["secret"], "credential secret");
      const entropy = asBytes(args["entropy"], "credential entropy");
      try {
        const protectedBytes = addon.dpapiProtectCurrentUser(plain, entropy);
        addon.writeSecureStateFileAtomically(directory(), "credential.dpapi", protectedBytes);
        credential?.fill(0);
        credential = Buffer.from(plain);
      } finally {
        // This copy arrived over a worker channel solely for DPAPI and never
        // reaches disk/argv/environment. Best-effort zeroing narrows its life.
        plain.fill(0);
      }
      return undefined;
    }
    case "credential.load": {
      const entropy = asBytes(args["entropy"], "credential entropy");
      const protectedBytes = addon.readSecureStateFile(directory(), "credential.dpapi");
      credential?.fill(0);
      const plaintext = addon.dpapiUnprotectCurrentUser(protectedBytes, entropy);
      try {
        credential = Buffer.from(plaintext);
      } finally {
        // CryptUnprotectData's returned typed array is a second temporary
        // plaintext copy. Retain only the worker-private HMAC key and wipe it.
        plaintext.fill(0);
      }
      return undefined;
    }
    case "credential.hmac": return hmac(asBytes(args["material"], "HMAC material"));
    case "identity.current": return addon.getCurrentProcessIdentity();
    case "identity.matches": {
      const identity = args["identity"] as ProcessIdentity;
      return addon.matchesProcessIdentity(identity);
    }
    case "pipe.create": {
      const pipeName = args["pipeName"];
      if (typeof pipeName !== "string") throw new Error("pipe options are invalid");
      // As with state, clear before a close/create pair.  A failed create
      // cannot retain a handle to a different or already-closed pipe.
      const previous = pipeServer;
      pipeServer = null;
      if (previous !== null) addon.closeSecureNamedPipeServer(previous);
      pipeServer = addon.createSecureNamedPipeServer({
        pipeName, maxInstances: 1, inboundBufferBytes: 1024 * 1024, outboundBufferBytes: 1024 * 1024,
      });
      return pipeServer;
    }
    case "pipe.accept": {
      if (pipeConnection !== null) throw new Error("secure pipe connection is already active");
      pipeConnection = addon.acceptSecureNamedPipeConnection(server());
      peerIdentity = null;
      return pipeConnection;
    }
    case "pipe.read": {
      const maxBytes = args["maxBytes"];
      if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
        throw new Error("pipe read size is invalid");
      }
      const data = addon.readSecureNamedPipeConnection(connection(), maxBytes);
      if (data.byteLength > 0 && peerIdentity === null) peerIdentity = addon.getSecureNamedPipePeerIdentity(connection());
      return { data, peer: peerIdentity };
    }
    case "pipe.write": return addon.writeSecureNamedPipeConnection(connection(), asBytes(args["bytes"], "pipe bytes"));
    case "pipe.disconnect": {
      if (pipeConnection !== null) addon.disconnectSecureNamedPipeConnection(pipeConnection);
      return undefined;
    }
    case "pipe.closeConnection": {
      const previous = pipeConnection;
      pipeConnection = null;
      peerIdentity = null;
      if (previous !== null) addon.closeSecureNamedPipeConnection(previous);
      return undefined;
    }
    case "pipe.closeServer": {
      const previous = pipeServer;
      pipeServer = null;
      if (previous !== null) addon.closeSecureNamedPipeServer(previous);
      return undefined;
    }
    // The cancellation worker closes an idle server directly to interrupt a
    // blocking accept.  Once that accept unwinds this worker must drop its
    // now-invalid registry token without attempting a second native close.
    case "pipe.forgetCancelledServer": {
      pipeServer = null;
      return undefined;
    }
    case "detached.launch": return addon.launchDetachedHost(args as never);
    case "close": {
      const previousConnection = pipeConnection;
      const previousServer = pipeServer;
      const previousDirectory = stateDirectory;
      credential?.fill(0);
      credential = null;
      pipeConnection = null;
      pipeServer = null;
      stateDirectory = null;
      peerIdentity = null;
      if (previousConnection !== null) addon.closeSecureNamedPipeConnection(previousConnection);
      if (previousServer !== null) addon.closeSecureNamedPipeServer(previousServer);
      if (previousDirectory !== null) addon.closeSecureStateDirectory(previousDirectory);
      return undefined;
    }
    default: throw new Error(`unknown native worker operation: ${op}`);
  }
}

parentPort.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const requestMessage = message as Partial<Request>;
  const id = requestMessage.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof requestMessage.op !== "string") return;
  try {
    reply(id, true, request(requestMessage.op, requestMessage.args ?? {}));
  } catch (error) {
    reply(id, false, undefined, error instanceof Error ? error.message : error);
  }
});
