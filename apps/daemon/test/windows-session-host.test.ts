import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_WINDOWS_ABI_VERSION } from "@prospero/windows-native";
import {
  MAX_WINDOWS_SESSION_HOST_FRAME_BYTES,
  NodePipeConnection,
  WindowsSessionHostClient,
  type WindowsSessionHostClientNative,
  type WindowsSessionHostWireConnection,
} from "../src/windows-session-host-client.js";
import { isStrictWindowsPipePeerIdentity } from "../src/windows-session-host-native.js";
import {
  consumeDetachedWindowsSessionHostBootstrap,
  launchDetachedWindowsSessionHostWithNative,
  rollbackDetachedWindowsSessionHostWithNative,
  runDetachedWindowsSessionHostFromEnvironment,
  serveWindowsSessionHostPipe,
  stopWindowsSessionHostTransport,
  type WindowsSessionHostDetachedLaunchNative,
  type WindowsSessionHostNativeFactory,
  type WindowsSessionHostRunnerNative,
} from "../src/windows-session-host-runner.js";
import {
  decodePsj2Journal,
  hmacProof,
  helloProofMaterial,
  parseWindowsSessionHostManifest,
  welcomeProofMaterial,
  type SessionHostHello,
  type SessionHostWireMessage,
  type WindowsSessionHostManifest,
} from "../src/windows-session-host-protocol.js";

const secret = new TextEncoder().encode("mock-native-process-secret-only");
const daemonA = { pid: 41001, creationTime100ns: "111111111111111" } as const;
const daemonB = { pid: 41002, creationTime100ns: "222222222222222" } as const;
const children: ChildProcess[] = [];

async function nodePipePair(): Promise<{
  readonly connection: NodePipeConnection;
  readonly peer: Socket;
  close(): Promise<void>;
}> {
  let resolvePeer!: (socket: Socket) => void;
  const peerReady = new Promise<Socket>((resolve) => { resolvePeer = resolve; });
  const server = createServer((socket) => {
    socket.on("error", () => {});
    resolvePeer(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  const client = createConnection({ host: "127.0.0.1", port: address.port });
  const connected = once(client, "connect");
  const peer = await peerReady;
  await connected;
  const connection = new NodePipeConnection(client);
  return {
    connection,
    peer,
    async close() {
      connection.detach();
      peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function writeSocket(socket: Socket, data: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => socket.write(data, (error) => error ? reject(error) : resolve()));
}

function makeHello(manifest: WindowsSessionHostManifest, daemon = daemonA, nonce = "bm9uY2UtbW9jay1uYXRpdmU="): SessionHostHello {
  const unsigned = { sessionId: manifest.sessionId, epoch: manifest.epoch, daemon, nonce };
  return { version: 2, type: "hello", ...unsigned, proof: hmacProof(secret, helloProofMaterial(unsigned)) };
}

async function startMock(): Promise<{ child: ChildProcess; manifest: WindowsSessionHostManifest; owner: typeof daemonA }> {
  const child = fork(fileURLToPath(new URL("./fixtures/windows-session-host-mock-native.mjs", import.meta.url)), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("mock native host did not become ready")), 5_000);
    child.once("error", reject);
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "ready") return;
      clearTimeout(timeout);
      const ready = message as { manifest: WindowsSessionHostManifest; owner: typeof daemonA };
      resolve({ child, manifest: ready.manifest, owner: ready.owner });
    });
  });
}

async function call(child: ChildProcess, op: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`mock native host timed out for ${op}`)), 5_000);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { id?: unknown }).id !== id) return;
      child.off("message", onMessage);
      clearTimeout(timeout);
      const reply = message as { ok?: unknown; error?: unknown } & Record<string, unknown>;
      if (reply.ok === true) resolve(reply);
      else reject(new Error(typeof reply.error === "string" ? reply.error : "mock native host operation failed"));
    };
    child.on("message", onMessage);
    child.send({ id, op, ...payload });
  });
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
  })));
});

describe("Windows Session Host common transport (mock native process)", () => {
  it("authenticates peer PID+FILETIME, fences one lease, recovers crash tails, snapshots gaps, deduplicates commands, and fences terminal state", async () => {
    const { child, manifest } = await startMock();
    expect(JSON.stringify(manifest)).not.toContain("mock-native-process-secret-only");
    expect(manifest).not.toHaveProperty("secret");
    expect(manifest).not.toHaveProperty("capability");

    const hello = makeHello(manifest);
    const welcomeResult = await call(child, "hello", { frame: hello, peer: { process: daemonA, userSid: "S-1-5-21-1000", sessionId: 1 } });
    const welcome = welcomeResult.value as { proof: string; terminal: boolean; lastSeq: number; host: typeof daemonA };
    expect(welcome.lastSeq).toBe(1); // valid prefix survived the cut-off PSJ2 record
    expect(welcome.terminal).toBe(false);
    expect(welcome.proof).toBe(hmacProof(secret, welcomeProofMaterial({
      sessionId: manifest.sessionId, epoch: manifest.epoch, host: welcome.host, terminal: false, lastSeq: 1,
    }, hello.nonce)));
    expect(welcomeResult.snapshotBytes).toBeTypeOf("number"); // crash tail compacted before attach

    const lease = await call(child, "command", { frame: {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "lease-a", mutation: false, method: "lease.acquire", params: {},
    } });
    const leaseId = (lease.value as { result: { leaseId: string } }).result.leaseId;

    await call(child, "detach");
    await call(child, "hello", { frame: makeHello(manifest, daemonB), peer: { process: daemonB, userSid: "S-1-5-21-1000", sessionId: 1 } });
    const bypass = await call(child, "command", { frame: {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "old-daemon-bypass", mutation: false, method: "effect", params: {},
    } });
    expect(["lease_required", "lease_held"]).toContain((bypass.value as { error: { code: string } }).error.code);
    const blockedLease = await call(child, "command", { frame: {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "lease-b", mutation: false, method: "lease.acquire", params: {},
    } });
    expect((blockedLease.value as { error: { code: string } }).error.code).toBe("lease_held");

    await call(child, "hello", { frame: makeHello(manifest), peer: { process: daemonA, userSid: "S-1-5-21-1000", sessionId: 1 } });
    const effect = {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "effect-once", mutation: false, method: "effect", params: {}, leaseId,
    } as const;
    const first = await call(child, "command", { frame: effect });
    const duplicate = await call(child, "command", { frame: effect });
    expect(duplicate.value).toEqual(first.value);
    expect(duplicate.calls).toBe(1);

    const terminal = await call(child, "command", { frame: { ...effect, commandId: "explicit-terminal", method: "stop" } });
    expect((terminal.value as { ok: boolean }).ok).toBe(true);
    const afterTerminal = await call(child, "command", { frame: { ...effect, commandId: "after-terminal" } });
    expect((afterTerminal.value as { error: { code: string } }).error.code).toBe("terminal_fence");
    const replay = await call(child, "replay", { frame: {
      version: 2, type: "replay", sessionId: manifest.sessionId, epoch: manifest.epoch, afterSeq: 0,
    } });
    expect((replay.value as { gap: boolean; terminal: boolean; snapshot: { lastSeq: number } }).gap).toBe(true);
    expect((replay.value as { terminal: boolean }).terminal).toBe(true);
  });

  it("sets an in-memory unknown-outcome fence if native journal persistence fails after a handler effect", async () => {
    const { child, manifest } = await startMock();
    await call(child, "hello", { frame: makeHello(manifest), peer: { process: daemonA, userSid: "S-1-5-21-1000", sessionId: 1 } });
    const lease = await call(child, "command", { frame: {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "lease", mutation: true, method: "lease.acquire", params: {},
    } });
    const leaseId = (lease.value as { result: { leaseId: string } }).result.leaseId;
    await call(child, "failWrites");
    const effect = {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "effect-unknown", mutation: true, method: "effect", params: {}, leaseId,
    } as const;
    const first = await call(child, "command", { frame: effect });
    expect((first.value as { error: { code: string } }).error.code).toBe("unknown_command_outcome");
    const duplicate = await call(child, "command", { frame: effect });
    expect(duplicate.value).toEqual(first.value);
    expect(duplicate.calls).toBe(1);
  });

  it("fails closed when required terminal compaction cannot persist", async () => {
    const { child, manifest } = await startMock();
    await call(child, "hello", { frame: makeHello(manifest), peer: { process: daemonA, userSid: "S-1-5-21-1000", sessionId: 1 } });
    const lease = await call(child, "command", { frame: {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "lease-for-compaction", mutation: true, method: "lease.acquire", params: {},
    } });
    const leaseId = (lease.value as { result: { leaseId: string } }).result.leaseId;
    await call(child, "failSnapshotWrites");
    const stop = {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "terminal-with-failed-compaction", mutation: true, method: "stop", params: {}, leaseId,
    } as const;
    const first = await call(child, "command", { frame: stop });
    expect((first.value as { error: { code: string } }).error.code).toBe("unknown_command_outcome");
    // Required terminal persistence failed, so the retained finalizer closes
    // containment without issuing a success reply.
    expect(first.terminalFinalized).toBe(1);
    const duplicate = await call(child, "command", { frame: stop });
    expect(duplicate.value).toEqual(first.value);

    const { child: eventChild } = await startMock();
    await call(eventChild, "failSnapshotWrites");
    await expect(call(eventChild, "appendEvent", { payload: { terminal: "output" }, options: { terminal: true } })).rejects.toThrow(/snapshot compaction/i);
  });

  it("commits terminal intent/state before reply and runs the Job finalizer only after the reply boundary", async () => {
    const { child, manifest } = await startMock();
    await call(child, "hello", { frame: makeHello(manifest), peer: { process: daemonA, userSid: "S-1-5-21-1000", sessionId: 1 } });
    const lease = await call(child, "command", { frame: {
      version: 2, type: "command", sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "kill-lease", mutation: true, method: "lease.acquire", params: {},
    } });
    const leaseId = (lease.value as { result: { leaseId: string } }).result.leaseId;
    const kill = {
      version: 2 as const, type: "command" as const, sessionId: manifest.sessionId, epoch: manifest.epoch,
      commandId: "kill-once", mutation: true, method: "structured.kill", params: {}, leaseId,
    };
    const first = await call(child, "command", { frame: kill });
    expect(first.terminalFinalized).toBe(0);
    expect(first.snapshotBytes).toBeGreaterThan(0);
    const duplicate = await call(child, "command", { frame: kill });
    expect(duplicate.value).toEqual(first.value);
    expect(duplicate.calls).toBe(1);
    const replay = await call(child, "replay", { frame: {
      version: 2, type: "replay", sessionId: manifest.sessionId, epoch: manifest.epoch, afterSeq: 0,
    } });
    expect((replay.value as { terminal: boolean }).terminal).toBe(true);
    const finalized = await call(child, "replyDelivered", { commandId: "kill-once" });
    expect(finalized.terminalFinalized).toBe(1);
    const repeatedFinalization = await call(child, "replyDelivered", { commandId: "kill-once" });
    expect(repeatedFinalization.terminalFinalized).toBe(1);
  });

  it("durably appends host output while detached, serializes it with other appends, and fences a terminal event", async () => {
    const { child, manifest } = await startMock();
    const [first, second] = await Promise.all([
      call(child, "appendEvent", { payload: { stream: "pty", data: "one" } }),
      call(child, "appendEvent", { payload: { stream: "pty", data: "two" } }),
    ]);
    const sequences = [first, second].map((reply) => (reply.value as { seq: number }).seq).sort((left, right) => left - right);
    expect(sequences).toEqual([2, 3]);
    const terminal = await call(child, "appendEvent", { payload: { exited: true }, options: { terminal: true, snapshotState: { exited: true } } });
    expect((terminal.value as { kind: string }).kind).toBe("terminal");
    await expect(call(child, "appendEvent", { payload: { after: "terminal" } })).rejects.toThrow(/terminal fence/i);

    await call(child, "hello", { frame: makeHello(manifest), peer: { process: daemonA, userSid: "S-1-5-21-1000", sessionId: 1 } });
    const replay = await call(child, "replay", { frame: {
      version: 2, type: "replay", sessionId: manifest.sessionId, epoch: manifest.epoch, afterSeq: 0,
    } });
    expect((replay.value as { terminal: boolean; snapshot: { lastSeq: number } }).terminal).toBe(true);
    expect((replay.value as { snapshot: { lastSeq: number } }).snapshot.lastSeq).toBe(4);
  });

  it("rejects malformed native peer identity and replay cursors beyond the durable watermark", async () => {
    const { child, manifest } = await startMock();
    await expect(call(child, "hello", { frame: makeHello(manifest), peer: { process: daemonA, userSid: "not-a-sid", sessionId: 1 } })).rejects.toThrow(/peer/i);
    await call(child, "hello", { frame: makeHello(manifest), peer: { process: daemonA, userSid: "S-1-5-21-1000", sessionId: 1 } });
    await expect(call(child, "replay", { frame: {
      version: 2, type: "replay", sessionId: manifest.sessionId, epoch: manifest.epoch, afterSeq: 999,
    } })).rejects.toThrow(/cursor/i);
  });

  it("accepts the complete DWORD TokenSessionId range and rejects values outside it", async () => {
    const highest = { process: daemonA, userSid: "S-1-5-21-1000", sessionId: 0xffff_ffff };
    expect(isStrictWindowsPipePeerIdentity({ process: daemonA, userSid: "S-1-5-21-1000", sessionId: 0 })).toBe(true);
    expect(isStrictWindowsPipePeerIdentity(highest)).toBe(true);
    for (const sessionId of [-1, 0x1_0000_0000, 1.5]) {
      expect(isStrictWindowsPipePeerIdentity({ ...highest, sessionId })).toBe(false);
    }

    const { child, manifest } = await startMock();
    await expect(call(child, "hello", { frame: makeHello(manifest), peer: highest })).resolves.toBeDefined();
    for (const sessionId of [-1, 0x1_0000_0000, 1.5]) {
      await expect(call(child, "hello", {
        frame: makeHello(manifest), peer: { ...highest, sessionId },
      })).rejects.toThrow(/peer/i);
    }
  });
});

describe("Windows Session Host client replay validation", () => {
  const manifest = parseWindowsSessionHostManifest({
    schemaVersion: 2, protocolVersion: 2, implementation: "windows-session-host", sessionId: "client-session", epoch: "client-epoch-0001",
    pipeName: "\\\\.\\pipe\\prospero-client-test", stateDirectory: "C:\\client-state", aclProfile: "current-logon-token-v1",
    owner: daemonA, nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION, credentialFile: "credential.dpapi", journalFile: "journal.psj2",
    snapshotFile: "snapshot.psj2.json", status: "active", createdAt: 1, updatedAt: 1,
  });

  it("does not advance its consumption cursor from welcome and rejects discontinuous replay", async () => {
    const sent: SessionHostWireMessage[] = [];
    const nonce = "mock-client-nonce";
    const native: WindowsSessionHostClientNative = {
      async openState() {}, async loadCredential() {}, async currentIdentity() { return daemonA; }, async matchesIdentity() { return true; },
      async hmac(material) { return hmacProof(secret, material); },
    };
    const welcome = {
      version: 2, type: "welcome", sessionId: manifest.sessionId, epoch: manifest.epoch, host: manifest.owner,
      terminal: false, lastSeq: 5,
      proof: hmacProof(secret, welcomeProofMaterial({ sessionId: manifest.sessionId, epoch: manifest.epoch, host: manifest.owner, terminal: false, lastSeq: 5 }, nonce)),
    } as const;
    const replies: SessionHostWireMessage[] = [welcome, {
      version: 2, type: "replay", sessionId: manifest.sessionId, epoch: manifest.epoch, afterSeq: 0,
      lastSeq: 2, gap: false, terminal: false, snapshot: null,
      events: [{ schemaVersion: 2, sessionId: manifest.sessionId, epoch: manifest.epoch, seq: 2, kind: "event", payload: {} }],
    }];
    const connection: WindowsSessionHostWireConnection = {
      async send(frame) {
        const line = new TextDecoder().decode(frame).trim();
        const message = JSON.parse(line) as SessionHostWireMessage;
        if (message.type === "hello") {
          // The client chooses a random nonce. Re-sign the queued welcome for
          // exactly that nonce rather than trusting test fixture metadata.
          const mutable = replies[0] as { proof: string } & typeof welcome;
          mutable.proof = hmacProof(secret, welcomeProofMaterial({
            sessionId: manifest.sessionId, epoch: manifest.epoch, host: manifest.owner, terminal: false, lastSeq: 5,
          }, message.nonce));
        }
        sent.push(message);
      },
      async receive() {
        const next = replies.shift();
        if (!next) throw new Error("no queued reply");
        return next;
      },
      detach() {},
    };
    const client = await WindowsSessionHostClient.attach(manifest, native, async () => connection);
    expect(client.cursor).toBe(0);
    await expect(client.replay()).rejects.toMatchObject({ code: "session_host_unavailable" });
    expect((sent.at(-1) as { type: string; afterSeq: number }).afterSeq).toBe(0);
  });

  it("does not advance the replay cursor from a command reply, releases native ownership on dispose, and binds its expected state directory", async () => {
    const sent: SessionHostWireMessage[] = [];
    let detached = 0;
    let nativeClosed = 0;
    const native: WindowsSessionHostClientNative = {
      async openState() {}, async loadCredential() {}, async currentIdentity() { return daemonA; }, async matchesIdentity() { return true; },
      async hmac(material) { return hmacProof(secret, material); }, async close() { nativeClosed += 1; },
    };
    const replies: SessionHostWireMessage[] = [{
      version: 2, type: "welcome", sessionId: manifest.sessionId, epoch: manifest.epoch, host: manifest.owner,
      terminal: false, lastSeq: 5, proof: "",
    }, {
      version: 2, type: "reply", commandId: "status-command", ok: true, result: { active: true }, seq: 5,
    }, {
      version: 2, type: "replay", sessionId: manifest.sessionId, epoch: manifest.epoch, afterSeq: 0, lastSeq: 5,
      gap: true, terminal: false,
      snapshot: { schemaVersion: 2, sessionId: manifest.sessionId, epoch: manifest.epoch, lastSeq: 4, terminal: false, commands: [], state: {} },
      events: [{ schemaVersion: 2, sessionId: manifest.sessionId, epoch: manifest.epoch, seq: 5, kind: "event", payload: { output: "late" } }],
    }];
    const connection: WindowsSessionHostWireConnection = {
      async send(frame) {
        const message = JSON.parse(new TextDecoder().decode(frame).trim()) as SessionHostWireMessage;
        if (message.type === "hello") {
          (replies[0] as { proof: string }).proof = hmacProof(secret, welcomeProofMaterial({
            sessionId: manifest.sessionId, epoch: manifest.epoch, host: manifest.owner, terminal: false, lastSeq: 5,
          }, message.nonce));
        }
        sent.push(message);
      },
      async receive() {
        const next = replies.shift();
        if (!next) throw new Error("no queued reply");
        return next;
      },
      detach() { detached += 1; },
    };
    await expect(WindowsSessionHostClient.attach(manifest, native, async () => connection, { expectedStateDirectory: "C:\\wrong" })).rejects.toMatchObject({ code: "invalid_manifest" });
    const client = await WindowsSessionHostClient.attach(manifest, native, async () => connection, {
      expectedStateDirectory: manifest.stateDirectory, readOnlyMethods: ["status"],
    });
    await expect(client.command("status", {}, false, "status-command")).resolves.toEqual({ active: true });
    expect(client.cursor).toBe(0);
    await client.replay();
    expect((sent.at(-1) as { type: string; afterSeq: number }).afterSeq).toBe(0);
    expect(client.cursor).toBe(5);
    await client.dispose();
    expect(detached).toBe(1);
    expect(nativeClosed).toBe(1);
  });

  it("bounds a stalled welcome receive and detaches its socket", async () => {
    let detached = 0;
    const native: WindowsSessionHostClientNative = {
      async openState() {}, async loadCredential() {}, async currentIdentity() { return daemonA; }, async matchesIdentity() { return true; },
      async hmac(material) { return hmacProof(secret, material); },
    };
    const connection: WindowsSessionHostWireConnection = {
      async send() {}, async receive() { return new Promise<SessionHostWireMessage>(() => {}); }, detach() { detached += 1; },
    };
    await expect(WindowsSessionHostClient.attach(manifest, native, async () => connection, { handshakeTimeoutMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    expect(detached).toBe(1);
  });
});

describe("Windows Session Host Node pipe reply boundary", () => {
  it("fails closed when a peer sends more than one reply", async () => {
    const pair = await nodePipePair();
    try {
      const pending = pair.connection.receive();
      await writeSocket(pair.peer, new TextEncoder().encode('{"version":2,"type":"reply"}\n{"version":2,"type":"reply"}\n'));
      await expect(pending).rejects.toThrow(/more than one unconsumed reply/i);
      await expect(pair.connection.receive()).rejects.toThrow(/more than one unconsumed reply/i);
    } finally { await pair.close(); }
  });

  it("decodes before releasing its sole waiter and rejects malformed frames immediately", async () => {
    const pair = await nodePipePair();
    try {
      const pending = pair.connection.receive();
      await writeSocket(pair.peer, new TextEncoder().encode("{not-json}\n"));
      await expect(pending).rejects.toThrow(/invalid JSON/i);
      await expect(pair.connection.receive()).rejects.toThrow(/invalid JSON/i);
    } finally { await pair.close(); }
  });

  it("fails closed instead of accumulating oversized buffered input or concurrent waiters", async () => {
    const waitingPair = await nodePipePair();
    try {
      const first = waitingPair.connection.receive();
      const second = waitingPair.connection.receive();
      await expect(first).rejects.toThrow(/one pending reply/i);
      await expect(second).rejects.toThrow(/one pending reply/i);
    } finally { await waitingPair.close(); }

    const bufferPair = await nodePipePair();
    try {
      const pending = bufferPair.connection.receive();
      await writeSocket(bufferPair.peer, new Uint8Array(MAX_WINDOWS_SESSION_HOST_FRAME_BYTES + 1));
      await expect(pending).rejects.toThrow(/frame exceeds maximum/i);
      await expect(bufferPair.connection.receive()).rejects.toThrow(/frame exceeds maximum/i);
    } finally { await bufferPair.close(); }
  });
});

describe("Windows Session Host detached bootstrap and provider output", () => {
  const stateDirectory = "C:\\detached-state";
  const sessionId = "detached-session";
  const epoch = "detached-epoch-0001";
  const handlerModule = new URL("./fixtures/windows-session-host-factory.mjs", import.meta.url).href;
  const bootstrap = {
    schemaVersion: 2, implementation: "windows-session-host-runner", sessionId, epoch,
    pipeName: "\\\\.\\pipe\\prospero-detached-test", stateDirectory, handlerModule, createdAt: 1,
  } as const;

  it("securely consumes bootstrap once so a second detached entry cannot reuse it", async () => {
    const files = new Map<string, Uint8Array>([["host.bootstrap.json", new TextEncoder().encode(JSON.stringify(bootstrap))]]);
    let removed = 0;
    const native = {
      async read(name: string) { return files.get(name) ?? null; },
      async removeState(name: string) { removed += 1; files.delete(name); },
    };
    await expect(consumeDetachedWindowsSessionHostBootstrap(native, stateDirectory)).resolves.toMatchObject({ sessionId, epoch });
    expect(removed).toBe(1);
    await expect(consumeDetachedWindowsSessionHostBootstrap(native, stateDirectory)).rejects.toMatchObject({ code: "native_unavailable" });
  });

  it("injects durable appendEvent/emit into the detached factory while no daemon is attached", async () => {
    const files = new Map<string, Uint8Array>([["host.bootstrap.json", new TextEncoder().encode(JSON.stringify(bootstrap))]]);
    let rejectAccept: ((error: Error) => void) | undefined;
    const order: string[] = [];
    const native: WindowsSessionHostRunnerNative & { close(): Promise<void> } = {
      async openState() {},
      async read(name) { return files.get(name) ?? null; },
      async writeAtomic(name, bytes) { files.set(name, Uint8Array.from(bytes)); },
      async removeState(name) { files.delete(name); },
      async createCredential() {}, async hmac(material) { return hmacProof(secret, material); },
      async currentIdentity() { return daemonA; },
      async createProviderJob() { order.push("job.create"); },
      async assignProviderProcess(process) { expect(process).toEqual(daemonA); order.push("job.assign-self"); },
      async isProviderProcessInJob(process) { expect(process).toEqual(daemonA); order.push("job.audit-self"); return true; },
      async terminateProviderJob() {}, async closeProviderJob() {},
      async createPipe() { order.push("pipe.create"); },
      async acceptPipe() { return new Promise<void>((_resolve, reject) => { rejectAccept = reject; }); },
      async readPipe() { return { data: new Uint8Array(), peer: null }; }, async writePipe() { return 0; },
      async closePipeConnection() {}, async closePipeServer() {},
      async cancelActivePipeIo() { rejectAccept?.(new Error("test cancellation")); }, async close() {},
    };
    const factory: WindowsSessionHostNativeFactory = { async create() { return native; } };
    const running = await runDetachedWindowsSessionHostFromEnvironment({ PROSPERO_WINDOWS_SESSION_HOST_STATE_DIRECTORY: stateDirectory }, factory);
    expect(order.slice(0, 4)).toEqual(["job.create", "job.assign-self", "job.audit-self", "pipe.create"]);
    const journal = decodePsj2Journal(files.get("journal.psj2")!, sessionId, epoch);
    expect(journal.events.map((event) => event.payload)).toEqual([
      { source: "factory", output: "daemon-offline" },
      { source: "factory", output: "second" },
    ]);
    expect(files.has("host.bootstrap.json")).toBe(false);
    await running.closeTransport();
    await expect(runDetachedWindowsSessionHostFromEnvironment({ PROSPERO_WINDOWS_SESSION_HOST_STATE_DIRECTORY: stateDirectory }, factory)).rejects.toMatchObject({ code: "native_unavailable" });
  });

  it("fails closed and closes the self-owned Job when adapter startup fails", async () => {
    const failingBootstrap = {
      ...bootstrap,
      handlerModule: new URL("./fixtures/windows-session-host-failing-factory.mjs", import.meta.url).href,
    };
    const files = new Map<string, Uint8Array>([["host.bootstrap.json", new TextEncoder().encode(JSON.stringify(failingBootstrap))]]);
    let closeJob = 0;
    let rejectAccept: ((error: Error) => void) | undefined;
    const native: WindowsSessionHostRunnerNative & { close(): Promise<void> } = {
      async openState() {},
      async read(name) { return files.get(name) ?? null; },
      async writeAtomic(name, bytes) { files.set(name, Uint8Array.from(bytes)); },
      async removeState(name) { files.delete(name); },
      async createCredential() {}, async hmac(material) { return hmacProof(secret, material); },
      async currentIdentity() { return daemonA; },
      async createProviderJob() {}, async assignProviderProcess() {}, async isProviderProcessInJob() { return true; },
      async terminateProviderJob() {}, async closeProviderJob() { closeJob += 1; },
      async createPipe() {},
      async acceptPipe() { return new Promise<void>((_resolve, reject) => { rejectAccept = reject; }); },
      async readPipe() { return { data: new Uint8Array(), peer: null }; }, async writePipe() { return 0; },
      async closePipeConnection() {}, async closePipeServer() {},
      async cancelActivePipeIo() { rejectAccept?.(new Error("test cancellation")); }, async close() {},
    };
    await expect(runDetachedWindowsSessionHostFromEnvironment(
      { PROSPERO_WINDOWS_SESSION_HOST_STATE_DIRECTORY: stateDirectory },
      { async create() { return native; } },
    )).rejects.toThrow(/handler is invalid/);
    expect(closeJob).toBe(1);
    expect(JSON.parse(new TextDecoder().decode(files.get("host.failed.json")!))).toEqual({
      version: 1,
      code: "native_unavailable",
      stage: "starting_handler",
    });
  });

  it("exactly rolls back a launched host and clears credential-bearing bootstrap on invalid manifest publication", async () => {
    const files = new Map<string, Uint8Array>();
    const launched = { pid: 51001, creationTime100ns: "555555555555555" } as const;
    const terminated: unknown[] = [];
    let manifestReads = 0;
    const native: WindowsSessionHostDetachedLaunchNative = {
      async openState() {},
      async read(name) {
        if (name === "manifest.json") {
          manifestReads += 1;
          return manifestReads === 1 ? null : new TextEncoder().encode("{not-json}");
        }
        return files.get(name) ?? null;
      },
      async writeAtomic(name, bytes) { files.set(name, Uint8Array.from(bytes)); },
      async removeState(name) { files.delete(name); },
      async launchDetachedHost() { return { status: "launched", process: launched }; },
      async terminateIdentityAndWait(identity) { terminated.push(identity); return true; },
      async close() {},
    };
    await expect(launchDetachedWindowsSessionHostWithNative({
      sessionId,
      epoch,
      pipeName: "\\\\.\\pipe\\prospero-detached-rollback-invalid",
      stateDirectory,
      handlerModule,
      providerBootstrap: new TextEncoder().encode(JSON.stringify({ environment: { API_TOKEN: "secret" } })),
      providerRecord: new TextEncoder().encode("record"),
    }, native)).rejects.toMatchObject({ code: "invalid_manifest" });
    expect(terminated).toEqual([launched]);
    expect(files.has("provider.bootstrap.json")).toBe(false);
    expect(files.has("host.bootstrap.json")).toBe(false);
    // Immutable non-secret discovery metadata may remain, but it cannot start
    // another owner without a valid manifest/bootstrap.
    expect(files.has("provider.record.json")).toBe(true);
  });

  it("cleans all launch records when CreateProcess never succeeds", async () => {
    const files = new Map<string, Uint8Array>();
    let exactTerminateCalls = 0;
    const native: WindowsSessionHostDetachedLaunchNative = {
      async openState() {}, async read(name) { return files.get(name) ?? null; },
      async writeAtomic(name, bytes) { files.set(name, Uint8Array.from(bytes)); },
      async removeState(name) { files.delete(name); },
      async launchDetachedHost() {
        return { status: "parent_job_prevents_detach", parentJob: { parentJobDetected: true, breakawayAllowed: false, detachedLaunchAllowed: false } };
      },
      async terminateIdentityAndWait() { exactTerminateCalls += 1; return false; },
      async close() {},
    };
    await expect(launchDetachedWindowsSessionHostWithNative({
      sessionId,
      epoch,
      pipeName: "\\\\.\\pipe\\prospero-detached-no-spawn",
      stateDirectory,
      handlerModule,
      providerBootstrap: new TextEncoder().encode("sensitive"),
      providerRecord: new TextEncoder().encode("record"),
    }, native)).rejects.toMatchObject({ code: "native_unavailable" });
    expect(exactTerminateCalls).toBe(0);
    expect([...files.keys()]).toEqual([]);
  });

  it("canonicalizes Windows runtime variables copied from a worker-thread environment", async () => {
    const environmentKeys = ["SystemRoot", "SYSTEMROOT"] as const;
    const previous = new Map(environmentKeys.map((name) => [name, process.env[name]]));
    let launchedEnvironment: Readonly<Record<string, string>> | undefined;
    try {
      for (const name of environmentKeys) delete process.env[name];
      // Node documents worker-thread process.env copies as case-sensitive on
      // Windows. Task Scheduler commonly supplies this all-uppercase spelling.
      process.env["SYSTEMROOT"] = "C:\\Windows";
      const files = new Map<string, Uint8Array>();
      const native: WindowsSessionHostDetachedLaunchNative = {
        async openState() {}, async read(name) { return files.get(name) ?? null; },
        async writeAtomic(name, bytes) { files.set(name, Uint8Array.from(bytes)); },
        async removeState(name) { files.delete(name); },
        async launchDetachedHost(options) {
          launchedEnvironment = options.environment;
          return { status: "parent_job_prevents_detach", parentJob: { parentJobDetected: true, breakawayAllowed: false, detachedLaunchAllowed: false } };
        },
        async terminateIdentityAndWait() { return false; },
        async close() {},
      };
      await expect(launchDetachedWindowsSessionHostWithNative({
        sessionId,
        epoch,
        pipeName: "\\\\.\\pipe\\prospero-detached-worker-environment",
        stateDirectory,
        handlerModule,
      }, native)).rejects.toMatchObject({ code: "native_unavailable" });
      expect(launchedEnvironment).toMatchObject({
        SystemRoot: "C:\\Windows",
        PROSPERO_WINDOWS_SESSION_HOST_STATE_DIRECTORY: stateDirectory,
      });
    } finally {
      for (const name of environmentKeys) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("uses exact owner identity for facade-attach rollback and persists failed discovery state", async () => {
    const files = new Map<string, Uint8Array>([
      ["provider.bootstrap.json", new TextEncoder().encode("sensitive")],
      ["host.bootstrap.json", new TextEncoder().encode("bootstrap")],
    ]);
    const terminated: unknown[] = [];
    const owner = { pid: 52001, creationTime100ns: "666666666666666" } as const;
    const rollbackManifest = parseWindowsSessionHostManifest({
      schemaVersion: 2, protocolVersion: 2, implementation: "windows-session-host", sessionId, epoch,
      pipeName: "\\\\.\\pipe\\prospero-detached-attach-rollback", stateDirectory, aclProfile: "current-logon-token-v1",
      owner, nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION, credentialFile: "credential.dpapi", journalFile: "journal.psj2",
      snapshotFile: "snapshot.psj2.json", status: "active", createdAt: 1, updatedAt: 1,
    });
    const native: WindowsSessionHostDetachedLaunchNative = {
      async openState() {}, async read(name) { return files.get(name) ?? null; },
      async writeAtomic(name, bytes) { files.set(name, Uint8Array.from(bytes)); },
      async removeState(name) { files.delete(name); },
      async launchDetachedHost() { throw new Error("not used"); },
      async terminateIdentityAndWait(identity) { terminated.push(identity); return true; },
      async close() {},
    };
    await rollbackDetachedWindowsSessionHostWithNative(rollbackManifest, native);
    expect(terminated).toEqual([owner]);
    expect(files.has("provider.bootstrap.json")).toBe(false);
    expect(files.has("host.bootstrap.json")).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(files.get("manifest.json")!))).toMatchObject({ status: "failed" });
  });

  it("clears provider bootstrap when common host setup fails before the factory can consume it", async () => {
    const files = new Map<string, Uint8Array>([
      ["host.bootstrap.json", new TextEncoder().encode(JSON.stringify(bootstrap))],
      ["provider.bootstrap.json", new TextEncoder().encode(JSON.stringify({ environment: { API_TOKEN: "secret" } }))],
    ]);
    let closed = 0;
    const native: WindowsSessionHostRunnerNative & { close(): Promise<void> } = {
      async openState() {}, async read(name) { return files.get(name) ?? null; },
      async writeAtomic(name, bytes) { files.set(name, Uint8Array.from(bytes)); },
      async removeState(name) { files.delete(name); },
      async createCredential() {}, async hmac(material) { return hmacProof(secret, material); },
      async currentIdentity() { return daemonA; },
      async createProviderJob() {}, async assignProviderProcess() {}, async isProviderProcessInJob() { return true; },
      async terminateProviderJob() {}, async closeProviderJob() {},
      async createPipe() { throw new Error("pipe creation failed"); },
      async acceptPipe() {}, async readPipe() { return { data: new Uint8Array(), peer: null }; }, async writePipe() { return 0; },
      async closePipeConnection() {}, async closePipeServer() {},
      async close() { closed += 1; },
    };
    const factory: WindowsSessionHostNativeFactory = { async create() { return native; } };
    await expect(runDetachedWindowsSessionHostFromEnvironment({ PROSPERO_WINDOWS_SESSION_HOST_STATE_DIRECTORY: stateDirectory }, factory)).rejects.toThrow(/pipe creation failed/i);
    expect(files.has("host.bootstrap.json")).toBe(false);
    expect(files.has("provider.bootstrap.json")).toBe(false);
    expect(closed).toBe(1);
  });
});

describe("Windows Session Host fail-closed edges", () => {
  it("rejects a manifest ABI/SID trust input and native-invalid pipe names", () => {
    const base = {
      schemaVersion: 2, protocolVersion: 2, implementation: "windows-session-host", sessionId: "edge-session", epoch: "edge-epoch-000001",
      pipeName: "\\\\.\\pipe\\prospero-edge", stateDirectory: "C:\\edge-state", aclProfile: "current-logon-token-v1",
      owner: daemonA, nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION, credentialFile: "credential.dpapi", journalFile: "journal.psj2",
      snapshotFile: "snapshot.psj2.json", status: "active", createdAt: 1, updatedAt: 1,
    } as const;
    expect(() => parseWindowsSessionHostManifest({ ...base, nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION + 1 })).toThrow();
    expect(() => parseWindowsSessionHostManifest({ ...base, allowedUserSid: "S-1-5-18" })).toThrow();
    expect(() => parseWindowsSessionHostManifest({ ...base, owner: { ...daemonA, creationTime100ns: "0" } })).toThrow();
    expect(() => parseWindowsSessionHostManifest({ ...base, pipeName: "\\\\.\\pipe\\bad/pipe" })).toThrow();
    expect(() => parseWindowsSessionHostManifest({ ...base, pipeName: `\\\\.\\pipe\\${"x".repeat(257)}` })).toThrow();
  });

  it("stops after an accepted connection when requested instead of spinning after close", async () => {
    let stopping = false;
    let accepted = 0;
    let closed = 0;
    const native: WindowsSessionHostRunnerNative = {
      async openState() {}, async read() { return null; }, async writeAtomic() {}, async removeState() {}, async createCredential() {}, async hmac() { return ""; },
      async currentIdentity() { return daemonA; }, async createPipe() {},
      async acceptPipe() { accepted += 1; stopping = true; },
      async readPipe() { return { data: new Uint8Array(), peer: null }; }, async writePipe() { return 0; },
      async closePipeConnection() { closed += 1; }, async closePipeServer() {},
    };
    await serveWindowsSessionHostPipe(native, { detachConnection() {} } as never, () => stopping);
    expect(accepted).toBe(1);
    expect(closed).toBe(1);
  });

  it("cancels an active blocking read instead of waiting for the native worker queue", async () => {
    let stopping = false;
    let accepted = 0;
    let closeConnection = 0;
    let closeServer = 0;
    let nativeClosed = 0;
    let cancel = 0;
    let rejectRead: ((error: Error) => void) | undefined;
    let reading!: () => void;
    const startedRead = new Promise<void>((resolve) => { reading = resolve; });
    const native: WindowsSessionHostRunnerNative = {
      async openState() {}, async read() { return null; }, async writeAtomic() {}, async removeState() {}, async createCredential() {}, async hmac() { return ""; },
      async currentIdentity() { return daemonA; }, async createPipe() {},
      async acceptPipe() { accepted += 1; },
      async readPipe() {
        reading();
        return new Promise<{ data: Uint8Array; peer: null }>((_resolve, reject) => { rejectRead = reject; });
      },
      async writePipe() { return 0; },
      async closePipeConnection() { closeConnection += 1; }, async closePipeServer() { closeServer += 1; },
      async cancelActivePipeIo() { cancel += 1; rejectRead?.(new Error("DisconnectNamedPipe cancelled active read")); },
      async close() { nativeClosed += 1; },
    };
    const serving = serveWindowsSessionHostPipe(native, { detachConnection() {} } as never, () => stopping);
    await startedRead;
    stopping = true;
    await stopWindowsSessionHostTransport(native, serving, "\\\\.\\pipe\\test-active-read");
    expect(accepted).toBe(1);
    expect(cancel).toBe(1);
    expect(closeConnection).toBe(1);
    expect(closeServer).toBe(1);
    expect(nativeClosed).toBe(1);
  });

  it("cancels an idle blocking accept and always closes the native worker after a close error", async () => {
    let stopping = false;
    let rejectAccept: ((error: Error) => void) | undefined;
    let acceptStarted!: () => void;
    const started = new Promise<void>((resolve) => { acceptStarted = resolve; });
    let cancel = 0;
    let nativeClosed = 0;
    const native: WindowsSessionHostRunnerNative = {
      async openState() {}, async read() { return null; }, async writeAtomic() {}, async removeState() {}, async createCredential() {}, async hmac() { return ""; },
      async currentIdentity() { return daemonA; }, async createPipe() {},
      async acceptPipe() {
        acceptStarted();
        return new Promise<void>((_resolve, reject) => { rejectAccept = reject; });
      },
      async readPipe() { return { data: new Uint8Array(), peer: null }; }, async writePipe() { return 0; },
      async closePipeConnection() {},
      async closePipeServer() { throw new Error("server close failed"); },
      async cancelActivePipeIo() { cancel += 1; rejectAccept?.(new Error("close idle accept")); },
      async close() { nativeClosed += 1; },
    };
    const serving = serveWindowsSessionHostPipe(native, { detachConnection() {} } as never, () => stopping);
    await started;
    stopping = true;
    await expect(stopWindowsSessionHostTransport(native, serving, "\\\\.\\pipe\\test-idle-accept")).rejects.toThrow(/server close failed/);
    expect(cancel).toBe(1);
    expect(nativeClosed).toBe(1);
  });
});
