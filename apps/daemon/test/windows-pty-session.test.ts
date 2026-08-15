import { describe, expect, it } from "vitest";
import { NATIVE_WINDOWS_ABI_VERSION } from "@prospero/windows-native";
import {
  RemoteWindowsPtySession,
  type WindowsPtyFacadeClient,
  type WindowsPtySessionRecord,
} from "../src/windows-pty-session.js";
import {
  parseWindowsSessionHostManifest,
  type SessionHostReplayReply,
  type WindowsSessionHostManifest,
} from "../src/windows-session-host-protocol.js";

const record: WindowsPtySessionRecord = {
  schemaVersion: 1,
  implementation: "windows-pty-session",
  id: "windows-pty-mock",
  agent: "custom",
  title: "mock PTY",
  cwd: "C:\\work",
  createdAt: 1,
  cols: 80,
  rows: 24,
};

const manifest = parseWindowsSessionHostManifest({
  schemaVersion: 2,
  protocolVersion: 2,
  implementation: "windows-session-host",
  sessionId: record.id,
  epoch: "windows-pty-epoch-0001",
  pipeName: "\\\\.\\pipe\\prospero-windows-pty-mock",
  stateDirectory: "C:\\Prospero\\session-host\\windows-pty-mock",
  aclProfile: "current-logon-token-v1",
  owner: { pid: 40001, creationTime100ns: "111111111111111" },
  nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION,
  credentialFile: "credential.dpapi",
  journalFile: "journal.psj2",
  snapshotFile: "snapshot.psj2.json",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
});

function output(seq: number, text: string, journalSeq = seq) {
  return {
    schemaVersion: 2 as const,
    sessionId: record.id,
    epoch: manifest.epoch,
    seq: journalSeq,
    kind: "event" as const,
    payload: { provider: "pty", type: "output", outputSeq: seq, dataB64: Buffer.from(text).toString("base64") },
  };
}

function replay(events: SessionHostReplayReply["events"], lastSeq: number, options: Partial<SessionHostReplayReply> = {}): SessionHostReplayReply {
  return {
    version: 2,
    type: "replay",
    sessionId: record.id,
    epoch: manifest.epoch,
    afterSeq: 0,
    lastSeq,
    gap: false,
    terminal: false,
    snapshot: null,
    events,
    ...options,
  };
}

describe("Windows RemotePtySession facade (mock Session Host)", () => {
  it("replays durable output without renumbering it, and daemon dispose only detaches", async () => {
    const calls: string[] = [];
    let replayCount = 0;
    const client: WindowsPtyFacadeClient = {
      async acquireMutationLease() { calls.push("lease"); return "lease"; },
      async command(method) {
        calls.push(method);
        if (method === "pty.status") return { info: { ...record, kind: "pty", status: "running" }, lastOutputSeq: 2 };
        return { info: { ...record, kind: "pty", status: "running" } };
      },
      async replay() {
        replayCount += 1;
        return replayCount === 1 ? replay([output(1, "one"), output(2, "two")], 2) : replay([], 2);
      },
      async dispose() { calls.push("dispose"); },
    };
    const session = await RemoteWindowsPtySession.attachWithClient(manifest, record, client);
    const outputs: Array<[string, number]> = [];
    session.on("output", (dataB64: string, seq: number) => outputs.push([Buffer.from(dataB64, "base64").toString(), seq]));

    const subscribed = await session.subscribe(0);
    expect(subscribed.gap).toBe(false);
    expect(subscribed.events.map((event) => [Buffer.from(event.dataB64, "base64").toString(), event.seq])).toEqual([["one", 1], ["two", 2]]);
    await session.writeInput("hello\r");
    expect(calls).toEqual(expect.arrayContaining(["lease", "pty.input"]));
    // Existing replay events are duplicate journal reads, never duplicate PTY
    // output notifications or a new facade-owned sequence number.
    expect(outputs).toEqual([]);

    await session.dispose();
    expect(calls.at(-1)).toBe("dispose");
    expect(calls).not.toContain("pty.kill");
  });

  it("uses a compacted reducer snapshot as an output gap and fences before reporting kill completion", async () => {
    const calls: string[] = [];
    let phase = 0;
    const runningInfo = { ...record, kind: "pty" as const, status: "running" as const };
    const client: WindowsPtyFacadeClient = {
      async acquireMutationLease() { calls.push("lease"); return "lease"; },
      async command(method) {
        calls.push(method);
        if (method === "pty.kill") return { info: { ...runningInfo, status: "done" as const } };
        return { info: runningInfo, lastOutputSeq: 3 };
      },
      async replay() {
        phase += 1;
        if (phase === 1) {
          return replay([output(3, "three", 7)], 7, {
            gap: true,
            snapshot: {
              schemaVersion: 2,
              sessionId: record.id,
              epoch: manifest.epoch,
              lastSeq: 6,
              terminal: false,
              commands: [],
              state: { provider: "pty", seq: 2, info: runningInfo },
            },
          });
        }
        return replay([], 8, {
          terminal: phase > 2,
        });
      },
      async dispose() { calls.push("dispose"); },
    };
    const session = await RemoteWindowsPtySession.attachWithClient(manifest, record, client);
    expect((await session.subscribe(0)).gap).toBe(true);
    const afterSnapshot = await session.subscribe(2);
    expect(afterSnapshot.gap).toBe(false);
    expect(afterSnapshot.events.map((event) => event.seq)).toEqual([3]);

    await session.kill();
    expect(calls).toEqual(expect.arrayContaining(["lease", "pty.kill"]));
    expect(calls.at(-1)).toBe("pty.kill");
    expect(session.info().status).toBe("done");
    await session.dispose();
  });

  it("keeps a stale owner read-only and never turns it into a launch attempt", async () => {
    const stale = RemoteWindowsPtySession.unavailable({ ...manifest, status: "failed" } as WindowsSessionHostManifest, record);
    await expect(stale.snapshot()).rejects.toThrow(/unavailable|detached/i);
    await expect(stale.writeInput("must not launch")).rejects.toThrow(/unavailable|detached/i);
  });
});
