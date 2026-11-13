import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  HIDDEN_STREAM_SUSPEND_DELAY_MS,
  NativeGhosttyManager,
  surfaceCommand,
  type NativeGhosttyAddon,
} from "../src/main/native-ghostty";
import {
  TerminalStreamKind,
  decodeTerminalFrame,
  encodeTerminalFrame,
} from "../src/shared/terminal-stream";
import type { TerminalStreamState } from "../src/renderer/src/terminal-stream-controller";

class FakeDaemonSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  closed = false;
  sentFrames: Array<ReturnType<typeof decodeTerminalFrame>> = [];
  constructor(
    private readonly behavior: {
      cols?: number;
      rows?: number;
      epoch?: string;
      latestSeq?: number;
      exited?: boolean;
      historyGapOnAfterSeq?: boolean;
    } = {},
  ) {
    super();
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  send(data: Buffer | Uint8Array, callback?: (error?: Error) => void): void {
    const frame = decodeTerminalFrame(data, "client");
    this.sentFrames.push(frame);
    callback?.();
    if (frame.kind === TerminalStreamKind.Attach) {
      const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as {
        afterSeq?: number;
        epoch?: string;
        wantControl?: boolean;
      };
      const epoch = this.behavior.epoch ?? "e1";
      const latestSeq = this.behavior.latestSeq ?? 1;
      const exited = Boolean(this.behavior.exited);
      const controller = Boolean(payload.wantControl) && !exited;
      queueMicrotask(() => {
        if (this.closed) return;
        if (payload.epoch && payload.epoch !== epoch) {
          this.emit(
            "message",
            Buffer.from(
              encodeTerminalFrame({
                kind: TerminalStreamKind.Error,
                sequence: 0,
                payload: new TextEncoder().encode(
                  JSON.stringify({ code: "epoch_mismatch", message: "Terminal epoch changed", recoverable: false }),
                ),
              }),
            ),
          );
          return;
        }
        if (payload.afterSeq !== undefined && this.behavior.historyGapOnAfterSeq) {
          this.emit(
            "message",
            Buffer.from(
              encodeTerminalFrame({
                kind: TerminalStreamKind.Error,
                sequence: 0,
                payload: new TextEncoder().encode(
                  JSON.stringify({ code: "history_gap", message: "Cursor fell behind retained floor", recoverable: false }),
                ),
              }),
            ),
          );
          return;
        }
        this.emit(
          "message",
          Buffer.from(
            encodeTerminalFrame({
              kind: TerminalStreamKind.Hello,
              sequence: 0,
              payload: new TextEncoder().encode(
                JSON.stringify({
                  clientId: "c1",
                  epoch,
                  cols: this.behavior.cols ?? 80,
                  rows: this.behavior.rows ?? 24,
                  exited,
                  ...(controller ? { controllerId: "c1" } : {}),
                }),
              ),
            }),
          ),
        );
        if (payload.afterSeq === undefined) {
          this.emit(
            "message",
            Buffer.from(
              encodeTerminalFrame({
                kind: TerminalStreamKind.Snapshot,
                sequence: latestSeq,
                payload: new TextEncoder().encode(`snapshot-${latestSeq}`),
              }),
            ),
          );
        } else if (payload.afterSeq < latestSeq) {
          for (let seq = payload.afterSeq + 1; seq <= latestSeq; seq += 1) {
            this.emit(
              "message",
              Buffer.from(
                encodeTerminalFrame({
                  kind: TerminalStreamKind.Output,
                  sequence: seq,
                  payload: new TextEncoder().encode(`+delta-${seq}`),
                }),
              ),
            );
          }
        } else {
          this.emit(
            "message",
            Buffer.from(
              encodeTerminalFrame({
                kind: TerminalStreamKind.Ready,
                sequence: latestSeq,
                payload: new Uint8Array(),
              }),
            ),
          );
          if (exited) {
            this.emitExitAndClose(latestSeq);
          }
        }
      });
    } else if (frame.kind === TerminalStreamKind.Applied) {
      const latestSeq = this.behavior.latestSeq ?? 1;
      const exited = Boolean(this.behavior.exited);
      if (frame.sequence === latestSeq) {
        queueMicrotask(() => {
          if (this.closed) return;
          this.emit(
            "message",
            Buffer.from(
              encodeTerminalFrame({
                kind: TerminalStreamKind.Ready,
                sequence: frame.sequence,
                payload: new Uint8Array(),
              }),
            ),
          );
          if (exited) {
            this.emitExitAndClose(frame.sequence);
          }
        });
      }
    }
  }

  private emitExitAndClose(sequence: number): void {
    this.emit(
      "message",
      Buffer.from(
        encodeTerminalFrame({
          kind: TerminalStreamKind.Exit,
          sequence: 0,
          payload: new TextEncoder().encode(JSON.stringify({ exitCode: 0 })),
        }),
      ),
    );
    this.emit(
      "message",
      Buffer.from(
        encodeTerminalFrame({
          kind: TerminalStreamKind.State,
          sequence,
          payload: new TextEncoder().encode(JSON.stringify({ controllerId: null, readOnly: true, exited: true })),
        }),
      ),
    );
    // Match stream_session.rs: daemon closes the WebSocket with 1005 in the same tick right after Exit + State.
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1005, Buffer.alloc(0));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.close();
  }
}

describe("NativeGhosttyManager retained streams", () => {
  it("formats direct: command when paths have no whitespace and falls back to /bin/sh without /bin/zsh -l", () => {
    expect(surfaceCommand("/opt/prospero/prospero-terminal-relay", "/tmp/prospero-sock/relay.sock")).toBe(
      "direct:/opt/prospero/prospero-terminal-relay /tmp/prospero-sock/relay.sock",
    );

    const withSpaces = surfaceCommand(
      "/Applications/Prospero App/Contents/Resources/prospero-terminal-relay",
      "/tmp/prospero sock/relay.sock",
    );
    expect(withSpaces.startsWith("/bin/sh -c ")).toBe(true);
    expect(withSpaces).not.toContain("zsh");
    expect(withSpaces).toContain("exec ");
  });

  it("keeps legacy hosts attached, resumes checkpoint-capable hosts, and reconciles resize checkpoints", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const flushIo = async () => {
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(1);
      }
    };
    const sockets: FakeDaemonSocket[] = [];
    const states: TerminalStreamState[] = [];
    const errors: string[] = [];
    const rendered: string[] = [];
    const readSnapshot = vi.fn(async () => ({ seq: 1, size: { cols: 80, rows: 24 }, dataB64: Buffer.from("checkpoint-1").toString("base64") }) as { seq: number; size: { cols: number; rows: number }; dataB64: string } | null);
    let relaySocketPath = "";
    const peers: Array<ReturnType<typeof createConnection>> = [];

    const addon: NativeGhosttyAddon = {
      initialize: vi.fn(),
      create: vi.fn((_handle, command) => {
        const parts = command.replace(/^direct:/, "").split(" ");
        relaySocketPath = parts[1]!;
        const peer = createConnection(relaySocketPath);
        peers.push(peer);
        let buf = Buffer.alloc(0);
        peer.on("data", chunk => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 5) {
            const kind = String.fromCharCode(buf[0]!);
            const len = buf.readUInt32BE(1);
            if (buf.length < 5 + len) break;
            const payload = buf.subarray(5, 5 + len);
            buf = buf.subarray(5 + len);
            if (kind === "O" && len >= 4) {
              rendered.push(payload.subarray(4).toString("utf8"));
              const ackHeader = Buffer.alloc(9);
              ackHeader[0] = "A".charCodeAt(0);
              ackHeader.writeUInt32BE(4, 1);
              payload.subarray(0, 4).copy(ackHeader, 5);
              peer.write(ackHeader);
            }
          }
        });
        return 42;
      }),
      update: vi.fn(),
      destroy: vi.fn(),
      setReadOnly: vi.fn(),
      setGrid: vi.fn(),
    };

    const manager = new NativeGhosttyManager(
      tmpdir(),
      () => {
        const sock = new FakeDaemonSocket(sockets.length === 0 ? { cols: 185, rows: 60 } : {});
        sockets.push(sock);
        queueMicrotask(() => sock.open());
        return sock as never;
      },
      async () => true,
      (_id, state) => states.push(state),
      (_id, message) => errors.push(message),
      () => undefined,
      () => undefined,
      () => false,
      addon,
      readSnapshot,
    );

    const fakeWindow = {
      isDestroyed: () => false,
      getNativeWindowHandle: () => Buffer.alloc(8),
      webContents: { id: 7, isDestroyed: () => false },
    };

    try {
      const id = await manager.open(fakeWindow as never, 7, "sess-1", 13);
      expect(id).toBe(42);

      await flushIo();
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.closed).toBe(false);
      expect(states.at(-1)).toMatchObject({ connected: true, syncing: false, controller: true });

      // Rapid hide + show within the grace period cancels suspension.
      manager.update(id, { x: 0, y: 0, width: 800, height: 600, visible: false });
      await vi.advanceTimersByTimeAsync(HIDDEN_STREAM_SUSPEND_DELAY_MS - 200);
      await flushIo();
      expect(sockets[0]!.closed).toBe(false);
      manager.update(id, { x: 0, y: 0, width: 800, height: 600, visible: true });
      await vi.advanceTimersByTimeAsync(500);
      await flushIo();
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.closed).toBe(false);

      // Old terminal hosts without snapshots must stay attached even while hidden.
      readSnapshot.mockResolvedValueOnce(null);
      manager.update(id, { x: 0, y: 0, width: 0, height: 0, visible: false });
      await vi.advanceTimersByTimeAsync(HIDDEN_STREAM_SUSPEND_DELAY_MS + 50);
      await flushIo();
      expect(sockets[0]!.closed).toBe(false);

      // Staying hidden past the grace period suspends the WebSocket cleanly without emitting disconnected teardown state.
      manager.update(id, { x: 0, y: 0, width: 0, height: 0, visible: false });
      await vi.advanceTimersByTimeAsync(HIDDEN_STREAM_SUSPEND_DELAY_MS + 50);
      await flushIo();
      expect(sockets[0]!.closed).toBe(true);
      expect(errors).toEqual([]);
      expect(states.some(s => !s.connected && !s.syncing && !s.exited)).toBe(false);
      expect(addon.destroy).not.toHaveBeenCalled();

      // Becoming visible again reconnects and resyncs incrementally using afterSeq + epoch without RIS reset.
      manager.update(id, { x: 0, y: 0, width: 800, height: 600, visible: true });
      await flushIo();
      expect(sockets).toHaveLength(2);
      expect(sockets[1]!.closed).toBe(false);
      const resumeAttach = JSON.parse(
        new TextDecoder().decode(sockets[1]!.sentFrames[0]!.payload),
      ) as { afterSeq?: number; epoch?: string; wantControl?: boolean };
      expect(resumeAttach).toEqual({ afterSeq: 1, epoch: "e1", wantControl: true });
      expect(addon.setGrid).toHaveBeenCalledTimes(1);
      expect(addon.setGrid).toHaveBeenLastCalledWith(id, 185, 60);
      expect(states.at(-1)).toMatchObject({ connected: true, syncing: false, controller: true });
      expect(errors).toEqual([]);

      // The checkpoint includes output 3 and 4, which may already be queued
      // with output 5. Only 5 may be painted after the checkpoint.
      readSnapshot.mockResolvedValue({ seq: 4, size: { cols: 80, rows: 12 }, dataB64: Buffer.from("aligned-checkpoint").toString("base64") });
      const emit = (kind: number, sequence: number, payload: Uint8Array) => sockets[1]!.emit("message", Buffer.from(encodeTerminalFrame({ kind: kind as never, sequence, payload })));
      emit(TerminalStreamKind.Resize, 2, new Uint8Array([0, 80, 0, 12]));
      for (const sequence of [3, 4, 5]) emit(TerminalStreamKind.Output, sequence, new TextEncoder().encode(`live-${sequence}`));
      await flushIo();
      expect(rendered.join("")).toContain("aligned-checkpoint");
      expect(rendered.join("")).not.toContain("live-3");
      expect(rendered.join("")).not.toContain("live-4");
      expect(rendered.join("")).toContain("live-5");
      expect(addon.setGrid).toHaveBeenLastCalledWith(id, 80, 12);
      expect(errors).toEqual([]);

      // Do not detach while a resize checkpoint is still being consumed.
      let resolveCheckpoint!: (value: Awaited<ReturnType<typeof readSnapshot>>) => void;
      readSnapshot.mockImplementationOnce(() => new Promise(resolve => { resolveCheckpoint = resolve; }));
      emit(TerminalStreamKind.Resize, 6, new Uint8Array([0, 80, 0, 10]));
      await flushIo();
      manager.update(id, { x: 0, y: 0, width: 0, height: 0, visible: false });
      await vi.advanceTimersByTimeAsync(HIDDEN_STREAM_SUSPEND_DELAY_MS + 50);
      await flushIo();
      expect(sockets[1]!.closed).toBe(false);
      resolveCheckpoint({ seq: 6, size: { cols: 80, rows: 10 }, dataB64: Buffer.from("aligned-6").toString("base64") });
      await flushIo();
      await vi.advanceTimersByTimeAsync(HIDDEN_STREAM_SUSPEND_DELAY_MS + 50);
      await flushIo();
      expect(sockets[1]!.closed).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      for (const peer of peers) peer.destroy();
      manager.closeAll();
      vi.useRealTimers();
    }
  });

  it("falls back cleanly to a cold snapshot on history_gap without destroying the surface, and keeps exited terminals visible on clean WebSocket close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const flushIo = async () => {
      for (let i = 0; i < 10; i += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(1);
      }
    };
    const sockets: FakeDaemonSocket[] = [];
    const statesBySurface = new Map<number, TerminalStreamState[]>();
    const errors: string[] = [];
    const renderedChunksBySurface = new Map<number, string[]>();
    const peers: Array<ReturnType<typeof createConnection>> = [];
    let nextSurfaceId = 100;

    const addon: NativeGhosttyAddon = {
      initialize: vi.fn(),
      create: vi.fn((_handle, command) => {
        const surfaceId = ++nextSurfaceId;
        const relaySocketPath = command.replace(/^direct:/, "").split(" ")[1]!;
        const peer = createConnection(relaySocketPath);
        peers.push(peer);
        let buf = Buffer.alloc(0);
        peer.on("data", chunk => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 5) {
            const kind = String.fromCharCode(buf[0]!);
            const len = buf.readUInt32BE(1);
            if (buf.length < 5 + len) break;
            const payload = buf.subarray(5, 5 + len);
            buf = buf.subarray(5 + len);
            if (kind === "O" && len >= 4) {
              const text = payload.subarray(4).toString("binary");
              const list = renderedChunksBySurface.get(surfaceId) ?? [];
              list.push(text);
              renderedChunksBySurface.set(surfaceId, list);
              const ackHeader = Buffer.alloc(9);
              ackHeader[0] = "A".charCodeAt(0);
              ackHeader.writeUInt32BE(4, 1);
              payload.subarray(0, 4).copy(ackHeader, 5);
              peer.write(ackHeader);
            }
          }
        });
        return surfaceId;
      }),
      update: vi.fn(),
      destroy: vi.fn(),
      setReadOnly: vi.fn(),
      setGrid: vi.fn(),
    };

    let socketMode: "normal" | "gap" | "exited" = "normal";
    const manager = new NativeGhosttyManager(
      tmpdir(),
      () => {
        const sock =
          socketMode === "gap"
            ? new FakeDaemonSocket({ epoch: "e2", latestSeq: 5 })
            : socketMode === "exited"
              ? new FakeDaemonSocket({ epoch: "e3", latestSeq: 3, exited: true })
              : new FakeDaemonSocket({ epoch: "e1", latestSeq: 2 });
        if (socketMode === "gap") socketMode = "normal";
        sockets.push(sock);
        queueMicrotask(() => sock.open());
        return sock as never;
      },
      async () => true,
      (id, state) => {
        const list = statesBySurface.get(id) ?? [];
        list.push(state);
        statesBySurface.set(id, list);
      },
      (_id, message) => errors.push(message),
      () => undefined,
      () => undefined,
      () => false,
      addon,
    );

    const fakeWindow = {
      isDestroyed: () => false,
      getNativeWindowHandle: () => Buffer.alloc(8),
      webContents: { id: 9, isDestroyed: () => false },
    };

    try {
      // 1. Open running session, suspend, then trigger epoch_mismatch -> automatic cold snapshot fallback without destroy.
      const runningId = await manager.open(fakeWindow as never, 9, "sess-gap", 13);
      await flushIo();
      manager.update(runningId, { x: 0, y: 0, width: 0, height: 0, visible: false });
      await vi.advanceTimersByTimeAsync(HIDDEN_STREAM_SUSPEND_DELAY_MS + 50);
      await flushIo();

      socketMode = "gap";
      manager.update(runningId, { x: 0, y: 0, width: 900, height: 600, visible: true });
      await flushIo();

      // Socket[1] received afterSeq=2/epoch=e1 and returned epoch_mismatch; Socket[2] automatically re-attached cold without afterSeq!
      expect(sockets).toHaveLength(3);
      const fallbackAttach = JSON.parse(
        new TextDecoder().decode(sockets[2]!.sentFrames[0]!.payload),
      ) as { afterSeq?: number; epoch?: string };
      expect(fallbackAttach.afterSeq).toBeUndefined();
      expect(fallbackAttach.epoch).toBeUndefined();
      expect(addon.destroy).not.toHaveBeenCalled();
      expect(statesBySurface.get(runningId)?.at(-1)).toMatchObject({ connected: true, syncing: false });

      // 2. Open an already-exited PTY session where Ready + Exit + State + close(1005) arrive in the same tick.
      socketMode = "exited";
      const exitedId = await manager.open(fakeWindow as never, 9, "sess-exited", 13);
      manager.update(exitedId, { x: 10, y: 20, width: 800, height: 500, visible: true });
      await flushIo();

      expect(addon.destroy).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      expect(renderedChunksBySurface.get(exitedId)?.join("")).toContain("snapshot-3");
      expect(statesBySurface.get(exitedId)?.at(-1)).toMatchObject({
        connected: false,
        syncing: false,
        exited: true,
        readOnly: true,
        controller: false,
      });
    } finally {
      for (const peer of peers) peer.destroy();
      manager.closeAll();
      vi.useRealTimers();
    }
  });
});
