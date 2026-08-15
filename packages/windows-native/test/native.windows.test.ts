import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bindingPath = join(packageRoot, "build", "Release", "prospero_windows_native.node");

type RawBinding = {
  getCurrentProcessIdentity(): { pid: number; creationTime100ns: string };
  getProcessIdentity(pid: number): { pid: number; creationTime100ns: string };
  matchesProcessIdentity(identity: { pid: number; creationTime100ns: string }): boolean;
  createSecureNamedPipeServer(options: {
    pipeName: string;
    allowedUserSid: string;
    maxInstances: number;
    inboundBufferBytes: number;
    outboundBufferBytes: number;
  }): bigint;
  closeSecureNamedPipeServer(server: bigint): void;
  dpapiProtectCurrentUser(plaintext: Uint8Array, sessionEpochEntropy: Uint8Array): Uint8Array;
  dpapiUnprotectCurrentUser(ciphertext: Uint8Array, sessionEpochEntropy: Uint8Array): Uint8Array;
  openSecureStateDirectory(options: { path: string }): bigint;
  writeSecureStateFileAtomically(directory: bigint, fileName: string, data: Uint8Array): void;
  readSecureStateFile(directory: bigint, fileName: string): Uint8Array;
  listSecureStateEntries(directory: bigint): readonly string[];
  removeSecureStateFile(directory: bigint, fileName: string): void;
  closeSecureStateDirectory(directory: bigint): void;
};

const binding = (process.platform === "win32" ? require(bindingPath) : undefined) as RawBinding;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function currentUserSid(): string {
  const output = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = output.match(/S-1-\d+(?:-\d+)+/i)?.[0];
  if (!sid) throw new Error("whoami did not return a current user SID");
  return sid;
}

function waitForWorker(worker: Worker, expected: "ready" | "complete"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for pipe worker ${expected}`)), 10_000);
    worker.once("error", reject);
    worker.on("message", (message: Record<string, unknown>) => {
      if (message.type === "error") {
        clearTimeout(timeout);
        reject(new Error(`${message.name}: ${message.message}`));
      } else if (message.type === expected) {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
}

describe.runIf(process.platform === "win32")("Windows identity, secure pipe, DPAPI, and state addon", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("reports and strictly matches a live PID plus decimal FILETIME", () => {
    const current = binding.getCurrentProcessIdentity();
    expect(current.pid).toBe(process.pid);
    expect(current.creationTime100ns).toMatch(/^[1-9]\d*$/);
    expect(binding.getProcessIdentity(process.pid)).toEqual(current);
    expect(binding.matchesProcessIdentity(current)).toBe(true);
    expect(binding.matchesProcessIdentity({ ...current, creationTime100ns: "1" })).toBe(false);
    const missingPid = 0xffff_ffff;
    expect(() => binding.getProcessIdentity(missingPid)).toThrow(/not found/i);
    expect(binding.matchesProcessIdentity({ pid: missingPid, creationTime100ns: "1" })).toBe(false);
  });

  it("binds current-user DPAPI ciphertext to non-empty session/epoch entropy", () => {
    const entropy = encoder.encode("session=smoke-test;epoch=7");
    const plaintext = encoder.encode("capability-is-never-logged");
    const ciphertext = binding.dpapiProtectCurrentUser(plaintext, entropy);
    expect(ciphertext).not.toEqual(plaintext);
    expect(decoder.decode(binding.dpapiUnprotectCurrentUser(ciphertext, entropy))).toBe(
      "capability-is-never-logged",
    );
    expect(() => binding.dpapiUnprotectCurrentUser(ciphertext, encoder.encode("session=other;epoch=7")))
      .toThrow(/security validation|operation failed|native/i);
    expect(() => binding.dpapiProtectCurrentUser(plaintext, new Uint8Array())).toThrow(/invalid argument/i);
    expect(() => (binding as unknown as { dpapiProtectCurrentUser(data: Uint8Array): Uint8Array })
      .dpapiProtectCurrentUser(plaintext)).toThrow(/invalid argument/i);
  });

  it("keeps state operations in a reparse-free current-user-only directory", () => {
    const directoryPath = mkdtempSync(join(tmpdir(), "prospero-native-state-"));
    directories.push(directoryPath);
    const missingParent = join(directoryPath, "must-not-create");
    expect(() => binding.openSecureStateDirectory({ path: join(missingParent, "state") }))
      .toThrow(/not found/i);
    expect(existsSync(missingParent)).toBe(false);
    const directory = binding.openSecureStateDirectory({ path: join(directoryPath, "state") });
    try {
      binding.writeSecureStateFileAtomically(directory, "manifest.json", encoder.encode('{"epoch":7}'));
      expect(decoder.decode(binding.readSecureStateFile(directory, "manifest.json"))).toBe('{"epoch":7}');
      expect(binding.listSecureStateEntries(directory)).toEqual(["manifest.json"]);
      expect(() => binding.writeSecureStateFileAtomically(directory, "../escape", encoder.encode("x")))
        .toThrow(/invalid argument/i);
      expect(() => binding.readSecureStateFile(directory, "state:ads")).toThrow(/invalid argument/i);
      expect(() => binding.readSecureStateFile(directory, "COM\u00b9.json")).toThrow(/invalid argument/i);
      expect(() => binding.readSecureStateFile(directory, "LPT\u00b2")).toThrow(/invalid argument/i);
      binding.removeSecureStateFile(directory, "manifest.json");
      expect(binding.listSecureStateEntries(directory)).toEqual([]);
    } finally {
      binding.closeSecureStateDirectory(directory);
    }
  });

  it("uses an explicit current-logon-SID DACL and verifies the accepted client identity", async () => {
    const pipeName = `\\\\.\\pipe\\prospero-native-smoke-${process.pid}-${randomUUID()}`;
    const worker = new Worker(new URL("./fixtures/native-pipe-server.mjs", import.meta.url), {
      workerData: { bindingPath, pipeName, userSid: currentUserSid() },
    });
    const completePromise = waitForWorker(worker, "complete");
    await waitForWorker(worker, "ready");
    const response = await new Promise<Buffer>((resolve, reject) => {
      const socket = createConnection(pipeName);
      socket.once("error", reject);
      socket.once("connect", () => socket.write(Buffer.from("pipe-round-trip")));
      socket.once("data", (data) => {
        resolve(data);
        socket.end();
      });
    });
    expect(response.toString("utf8")).toBe("pipe-round-trip");
    const complete = await completePromise;
    const peer = complete.peer as { process: { pid: number; creationTime100ns: string }; userSid: string };
    expect(complete.preReadPeerRejected).toBe(true);
    expect(peer.process.pid).toBe(process.pid);
    expect(peer.process.creationTime100ns).toMatch(/^[1-9]\d*$/);
    expect(peer.userSid).toBe(currentUserSid());
    await worker.terminate();
  });

  it("rejects a pipe SID that is not the current identity before endpoint publication", () => {
    const pipeName = `\\\\.\\pipe\\prospero-native-negative-${process.pid}-${randomUUID()}`;
    expect(() => binding.createSecureNamedPipeServer({
      pipeName,
      allowedUserSid: "S-1-5-18",
      maxInstances: 1,
      inboundBufferBytes: 4096,
      outboundBufferBytes: 4096,
    })).toThrow(/security validation/i);
    expect(() => binding.createSecureNamedPipeServer({
      pipeName: "\\\\remote-host\\pipe\\prospero-native-negative",
      allowedUserSid: currentUserSid(),
      maxInstances: 1,
      inboundBufferBytes: 4096,
      outboundBufferBytes: 4096,
    })).toThrow(/invalid argument/i);
  });
});
