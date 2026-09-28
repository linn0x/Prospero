import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamKind,
  TERMINAL_STREAM_MAX_PAYLOAD_BYTES,
  type TerminalStreamFrame,
} from "../../shared/terminal-stream";

const utf8 = new TextEncoder();
const decoder = new TextDecoder();
// A legal maximum-size snapshot can arrive alongside Hello/Ready/State.
const MAX_QUEUED_FRAME_BYTES = TERMINAL_STREAM_MAX_PAYLOAD_BYTES + 64 * 1024;

export type TerminalStreamState = {
  connected: boolean;
  syncing: boolean;
  readOnly: boolean;
  exited: boolean;
  controller: boolean;
  epoch?: string;
};

type Json = Record<string, unknown>;

export type TerminalStreamControllerOptions = {
  sessionId: string;
  /** The last cursor that xterm has fully consumed. */
  cursor: () => number | undefined;
  epoch: () => string | undefined;
  wantControl: boolean;
  onHello?: (hello: { cols: number; rows: number }) => void;
  consume: (frame: TerminalStreamFrame) => Promise<void>;
  onState: (state: TerminalStreamState) => void;
  onError: (message: string, recoverable: boolean) => void;
  onHistoryGap: (message: string) => void;
};

function json(payload: Uint8Array): Json {
  const value: unknown = JSON.parse(decoder.decode(payload));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid terminal stream control payload");
  return value as Json;
}

function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function bool(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }

/**
 * Owns one renderer attachment.  It deliberately commits cursors only from
 * `consume` completion, which is where xterm's write callback resolves.
 */
export class TerminalStreamController {
  private port: MessagePort | undefined;
  private disposed = false;
  private sequence = 0;
  private writeChain = Promise.resolve();
  private readonly received: TerminalStreamFrame[] = [];
  private receivedBytes = 0;
  private processingBytes = 0;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<number, { resolve: () => void; reject: (reason: Error) => void; bytes: number }>();
  private pendingBytes = 0;
  private state: TerminalStreamState = { connected: false, syncing: true, readOnly: true, exited: false, controller: false };
  private clientId: string | undefined;
  private ready = false;
  private committedCursor: number;
  private helloSeen = false;
  private cleanExit = false;
  private freshReloadRequired = false;
  private attachmentGeneration = 0;

  constructor(private readonly options: TerminalStreamControllerOptions) {
    this.committedCursor = options.cursor() ?? 0;
  }

  attach(port: MessagePort): void {
    if (this.disposed) { port.close(); return; }
    if (this.port === port) return;
    this.port?.close();
    this.rejectPending(new Error("Terminal stream reattached"));
    this.port = port;
    this.attachmentGeneration += 1;
    this.committedCursor = this.options.cursor() ?? 0;
    this.ready = false;
    this.helloSeen = false;
    port.onmessage = event => this.receive(event.data);
    port.onmessageerror = () => this.fail("Terminal stream message could not be decoded", true);
    // Chromium/Electron ports may emit close; plain web MessagePort typings do
    // not expose it, so feature-detect without relying on a browser-only type.
    const closeAware = port as unknown as { addEventListener?: (type: string, listener: () => void) => void };
    closeAware.addEventListener?.("close", () => { if (this.port === port) this.fail("Terminal stream port closed", true); });
    port.start();
    this.state = { ...this.state, connected: false, syncing: true, controller: false };
    this.publish();
    const afterSeq = this.options.cursor();
    const epoch = this.options.epoch();
    this.send(TerminalStreamKind.Attach, 0, {
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(epoch ? { epoch } : {}),
      wantControl: this.options.wantControl,
    });
  }

  input(bytes: Uint8Array): Promise<void> {
    if (!this.ready) return Promise.reject(new Error("Terminal stream is not ready"));
    if (!this.canControl() || bytes.byteLength === 0) return Promise.reject(new Error("Terminal input is unavailable while observing"));
    return this.writeInputChunks(bytes);
  }

  resize(cols: number, rows: number): Promise<void> {
    if (!this.ready) return Promise.reject(new Error("Terminal stream is not ready"));
    if (!this.canControl()) return Promise.reject(new Error("Terminal resize is unavailable while observing"));
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 300) return Promise.reject(new Error("Invalid terminal size"));
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, cols, false); view.setUint16(2, rows, false);
    return this.operation(TerminalStreamKind.ResizeRequest, payload);
  }

  acquire(takeover: boolean): Promise<void> { return this.operation(TerminalStreamKind.Acquire, { takeover }); }
  release(): Promise<void> { return this.operation(TerminalStreamKind.Release, new Uint8Array()); }

  close(): void {
    this.disposed = true;
    this.attachmentGeneration += 1;
    this.rejectPending(new Error("Terminal stream closed"));
    this.port?.close(); this.port = undefined;
    clearTimeout(this.drainTimer); this.drainTimer = undefined; this.received.length = 0; this.receivedBytes = 0; this.processingBytes = 0;
    this.state = { ...this.state, connected: false, syncing: false, controller: false };
    this.publish();
  }

  private receive(value: unknown): void {
    let frame: TerminalStreamFrame;
    try {
      if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error("Terminal stream message was not binary");
      frame = decodeTerminalStreamFrame(value as ArrayBuffer | ArrayBufferView, "server");
    } catch (error) { this.fail(error instanceof Error ? error.message : "Malformed terminal stream frame", false); return; }
    this.received.push(frame); this.receivedBytes += frame.payload.byteLength;
    if (this.receivedBytes + this.processingBytes > MAX_QUEUED_FRAME_BYTES) { this.fail("Terminal stream renderer queue is full", false); return; }
    if (this.drainTimer === undefined) this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      const batch = this.received.splice(0); const bytes = this.receivedBytes; this.receivedBytes = 0; this.processingBytes += bytes;
      this.writeChain = this.writeChain.then(() => this.handleBatch(batch)).catch(error => this.fail(error instanceof Error ? error.message : "Terminal stream failed", false)).finally(() => { this.processingBytes = Math.max(0, this.processingBytes - bytes); });
    }, 0);
  }

  private async handleBatch(frames: TerminalStreamFrame[]): Promise<void> {
    for (let index = 0; index < frames.length; index += 1) {
      if (this.disposed || this.freshReloadRequired) return;
      const frame = frames[index]!;
      if (frame.kind !== TerminalStreamKind.Output) { await this.handle(frame); continue; }
      const outputs = [frame];
      while (index + 1 < frames.length && frames[index + 1]!.kind === TerminalStreamKind.Output) outputs.push(frames[++index]!);
      if (this.disposed || this.freshReloadRequired) return;
      let expected = this.committedCursor;
      for (const output of outputs) {
        if (!this.helloSeen || output.sequence !== expected + 1) throw new Error("Terminal stream output cursor was out of order");
        expected = output.sequence;
      }
      // Applied is cumulative, so one xterm write/ack covers this continuous range.
      const total = outputs.reduce((sum, output) => sum + output.payload.byteLength, 0);
      const payload = new Uint8Array(total); let offset = 0;
      for (const output of outputs) { payload.set(output.payload, offset); offset += output.payload.byteLength; }
      const last = outputs.at(-1)!;
      await this.consumeOutput({ ...last, payload });
    }
  }

  private async handle(frame: TerminalStreamFrame): Promise<void> {
    if (this.disposed || this.freshReloadRequired) return;
    if (frame.kind === TerminalStreamKind.Hello) {
      if (this.helloSeen || this.ready) throw new Error("Terminal stream hello was out of order");
      const value = json(frame.payload);
      const epoch = string(value.epoch);
      const clientId = string(value.clientId);
      if (!epoch || !clientId) throw new Error("Terminal stream hello was incomplete");
      const expectedEpoch = this.options.epoch();
      if (expectedEpoch && expectedEpoch !== epoch) { this.requireFreshReload("Terminal stream epoch changed; reload an authoritative snapshot"); return; }
      this.clientId = clientId;
      this.helloSeen = true;
      if (Number.isSafeInteger(value.cols) && Number.isSafeInteger(value.rows)) this.options.onHello?.({ cols: value.cols as number, rows: value.rows as number });
      this.state = { ...this.state, epoch, readOnly: bool(value.readOnly) === true || bool(value.exited) === true, exited: bool(value.exited) === true, controller: string(value.controllerId) === clientId };
      this.publish();
      return;
    }
    if (frame.kind === TerminalStreamKind.Ready) {
      if (!this.helloSeen || this.ready) throw new Error("Terminal stream Ready was out of order");
      if (frame.sequence !== this.committedCursor) throw new Error("Terminal stream Ready cursor was not committed");
      this.ready = true;
      this.state = { ...this.state, connected: true, syncing: false };
      this.publish();
      return;
    }
    if (frame.kind === TerminalStreamKind.Snapshot || frame.kind === TerminalStreamKind.Output || frame.kind === TerminalStreamKind.Resize) {
      if (!this.helloSeen) throw new Error("Terminal stream output arrived before Hello");
      if (frame.kind !== TerminalStreamKind.Snapshot && frame.sequence !== this.committedCursor + 1) throw new Error("Terminal stream output cursor was out of order");
      if (frame.kind === TerminalStreamKind.Snapshot && frame.sequence < this.committedCursor) throw new Error("Terminal stream snapshot cursor was out of order");
      await this.consumeOutput(frame);
      return;
    }
    if (frame.kind === TerminalStreamKind.State) {
      const value = json(frame.payload);
      const controllerId = string(value.controllerId);
      const exited = bool(value.exited) === true;
      this.state = { ...this.state, syncing: !this.ready, exited, readOnly: bool(value.readOnly) === true || exited, controller: Boolean(this.clientId && controllerId === this.clientId) };
      this.publish();
      return;
    }
    if (frame.kind === TerminalStreamKind.Exit) {
      this.cleanExit = true;
      this.rejectPending(new Error("Terminal session exited"));
      this.state = { ...this.state, syncing: false, exited: true, readOnly: true, controller: false };
      this.publish();
      return;
    }
    if (frame.kind === TerminalStreamKind.Error) {
      const value = json(frame.payload);
      const code = string(value.code) ?? "stream_error";
      const message = string(value.message) ?? "Terminal stream error";
      if (code === "history_gap" || code === "history_truncated" || code === "epoch_mismatch") {
        this.requireFreshReload(message);
        return;
      }
      else this.options.onError(message, bool(value.recoverable) === true);
      if (bool(value.recoverable) !== true) this.fail(message, false);
      return;
    }
    if (frame.kind === TerminalStreamKind.Result) {
      const pending = this.pending.get(frame.sequence);
      if (!pending) throw new Error("Terminal stream result did not match an operation");
      this.pending.delete(frame.sequence); this.pendingBytes -= pending.bytes;
      const value = json(frame.payload);
      if (bool(value.ok) === true) pending.resolve();
      else pending.reject(new Error(string(value.code) ?? "Terminal stream operation rejected"));
    }
  }

  private async consumeOutput(frame: TerminalStreamFrame): Promise<void> {
    if (this.disposed || this.freshReloadRequired) return;
    const port = this.port;
    const generation = this.attachmentGeneration;
    await this.options.consume(frame);
    // An old xterm write may complete after a reattach. It must never ACK the
    // new attachment or advance its wire cursor.
    if (this.disposed || this.freshReloadRequired || !port || this.port !== port || generation !== this.attachmentGeneration) return;
    // consume resolves after the complete xterm write, including snapshots.
    this.send(TerminalStreamKind.Applied, frame.sequence, new Uint8Array());
    this.committedCursor = frame.sequence;
    this.state = { ...this.state, syncing: !this.ready };
    this.publish();
  }

  private operation(kind: TerminalStreamKind, payload: Uint8Array | Json): Promise<void> {
    if (!this.port || !this.ready || !this.state.connected || this.disposed) return Promise.reject(new Error("Terminal stream is not ready"));
    const bytes = payload instanceof Uint8Array ? payload.byteLength : 0;
    if (this.pending.size >= 128 || this.pendingBytes + bytes > 1024 * 1024) return Promise.reject(new Error("Terminal stream operation queue is full"));
    const sequence = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(sequence, { resolve, reject, bytes }); this.pendingBytes += bytes;
      try { this.send(kind, sequence, payload); }
      catch (error) {
        this.pending.delete(sequence); this.pendingBytes -= bytes;
        reject(error instanceof Error ? error : new Error("Terminal stream operation failed"));
      }
    });
  }
  private async writeInputChunks(bytes: Uint8Array): Promise<void> {
    // Keep byte slices intact. UTF-8 code points may straddle a slice, which is
    // valid for a PTY byte stream and avoids altering pasted input.
    for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
      if (!this.canControl()) throw new Error("Terminal input controller changed");
      await this.operation(TerminalStreamKind.Input, bytes.slice(offset, Math.min(offset + 8192, bytes.byteLength)));
    }
  }

  private send(kind: TerminalStreamKind, sequence: number, value: Uint8Array | Json): void {
    if (!this.port) throw new Error("Terminal stream is disconnected");
    const payload = value instanceof Uint8Array ? value : utf8.encode(JSON.stringify(value));
    this.port.postMessage(encodeTerminalStreamFrame({ kind, sequence, payload }));
  }

  private canControl(): boolean { return this.ready && this.state.connected && !this.state.syncing && !this.state.readOnly && !this.state.exited && this.state.controller; }
  private publish(): void { this.options.onState(this.state); }
  private fail(message: string, recoverable: boolean): void {
    if (this.disposed) return;
    if (!this.cleanExit && !this.freshReloadRequired) this.options.onError(message, recoverable);
    this.rejectPending(new Error(message));
    clearTimeout(this.drainTimer); this.drainTimer = undefined; this.received.length = 0; this.processingBytes = 0;
    this.state = { ...this.state, connected: false, syncing: false, controller: false };
    this.publish();
    this.port?.close(); this.port = undefined;
    this.attachmentGeneration += 1;
  }
  private requireFreshReload(message: string): void {
    this.freshReloadRequired = true;
    this.options.onHistoryGap(message);
    this.rejectPending(new Error("Terminal stream requires a fresh reload"));
    this.state = { ...this.state, connected: false, syncing: false, readOnly: true, controller: false };
    this.publish();
    this.port?.close(); this.port = undefined;
    this.attachmentGeneration += 1;
  }
  private rejectPending(reason: Error): void {
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear(); this.pendingBytes = 0;
  }
}
