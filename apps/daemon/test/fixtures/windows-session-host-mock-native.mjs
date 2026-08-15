import {
  WindowsSessionHostRunner,
} from "../../dist/windows-session-host-runner.js";
import { NATIVE_WINDOWS_ABI_VERSION } from "@prospero/windows-native";
import {
  appendPsj2Event,
  createPsj2Journal,
  hmacProof,
  parseWindowsSessionHostManifest,
} from "../../dist/windows-session-host-protocol.js";

const secret = new TextEncoder().encode("mock-native-process-secret-only");
const sessionId = "mock-native-session";
const epoch = "mock-native-epoch-0001";
const owner = { pid: process.pid, creationTime100ns: "987654321012345" };
const files = new Map();
let failWrites = false;
let failSnapshotWrites = false;
let handlerCalls = 0;

const initial = createPsj2Journal(sessionId, epoch);
const persisted = appendPsj2Event(initial, {
  schemaVersion: 2,
  sessionId,
  epoch,
  seq: 1,
  kind: "event",
  payload: { retained: "before-crash" },
});
const crashTail = new Uint8Array(persisted.byteLength + 5);
crashTail.set(persisted);
crashTail.set([0x50, 0x53, 0x4a, 0x32, 0x01], persisted.byteLength);
files.set("journal.psj2", crashTail);

const native = {
  async hmac(material) { return hmacProof(secret, material); },
  async read(name) { return files.get(name) ?? null; },
  async writeAtomic(name, bytes) {
    if (failWrites) throw new Error("mock-native atomic state write failed");
    if (failSnapshotWrites && name === "snapshot.psj2.json") throw new Error("mock-native snapshot compaction failed");
    files.set(name, Uint8Array.from(bytes));
  },
};

const manifest = parseWindowsSessionHostManifest({
  schemaVersion: 2,
  protocolVersion: 2,
  implementation: "windows-session-host",
  sessionId,
  epoch,
  pipeName: "\\\\.\\pipe\\prospero-mock-native-host",
  stateDirectory: "C:\\mock-state",
  aclProfile: "current-logon-token-v1",
  owner,
  nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION,
  credentialFile: "credential.dpapi",
  journalFile: "journal.psj2",
  snapshotFile: "snapshot.psj2.json",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
});

const runner = new WindowsSessionHostRunner(manifest, native, {
  async handleCommand(context) {
    handlerCalls += 1;
    if (context.method === "stop") return { ok: true, result: { stopped: true }, terminal: true, snapshotState: { stopped: true } };
    return { ok: true, result: { method: context.method, calls: handlerCalls } };
  },
  snapshotState: () => ({ calls: handlerCalls }),
});
await runner.load();

function reply(id, value) {
  process.send?.({ id, ok: true, value, calls: handlerCalls, journalBytes: files.get("journal.psj2")?.byteLength ?? 0, snapshotBytes: files.get("snapshot.psj2.json")?.byteLength ?? 0 });
}

process.send?.({ type: "ready", manifest, owner });
process.on("message", async (message) => {
  try {
    if (!message || typeof message !== "object") return;
    if (message.op === "hello") return reply(message.id, await runner.acceptHello(message.frame, message.peer));
    if (message.op === "command") return reply(message.id, await runner.command(message.frame));
    if (message.op === "replay") return reply(message.id, await runner.replay(message.frame));
    if (message.op === "appendEvent") return reply(message.id, await runner.appendEvent(message.payload, message.options));
    if (message.op === "detach") { runner.detachConnection(); return reply(message.id, { detached: true }); }
    if (message.op === "failWrites") { failWrites = true; return reply(message.id, { armed: true }); }
    if (message.op === "failSnapshotWrites") { failSnapshotWrites = true; return reply(message.id, { armed: true }); }
    if (message.op === "stop") { process.exit(0); }
  } catch (error) {
    process.send?.({ id: message?.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
