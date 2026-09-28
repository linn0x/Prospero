/** Binary terminal stream v1.  This module deliberately contains no Electron
 * or credential-bearing code so both sides of the MessagePort use one codec. */
export const TERMINAL_STREAM_VERSION = 1;
export const TERMINAL_STREAM_HEADER_BYTES = 16;
export const TERMINAL_STREAM_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const TERMINAL_STREAM_V1_CAPABILITY = "terminal.stream.v1";

export const TerminalStreamKind = {
  Hello: 1, Snapshot: 2, Output: 3, Resize: 4, State: 5, Error: 6, Exit: 7, Ready: 8,
  Input: 16, Applied: 17, ResizeRequest: 18, Acquire: 19, Result: 20,
  Release: 21, Attach: 32,
} as const;
export type TerminalStreamKind = (typeof TerminalStreamKind)[keyof typeof TerminalStreamKind];
export type TerminalStreamFrame = { kind: TerminalStreamKind; sequence: number; payload: Uint8Array };

const kinds = new Set<number>(Object.values(TerminalStreamKind));
const clientKinds = new Set<number>([TerminalStreamKind.Input, TerminalStreamKind.Applied, TerminalStreamKind.ResizeRequest, TerminalStreamKind.Acquire, TerminalStreamKind.Release, TerminalStreamKind.Attach]);
const serverKinds = new Set<number>([TerminalStreamKind.Hello, TerminalStreamKind.Snapshot, TerminalStreamKind.Output, TerminalStreamKind.Resize, TerminalStreamKind.State, TerminalStreamKind.Error, TerminalStreamKind.Exit, TerminalStreamKind.Ready, TerminalStreamKind.Result]);

export function encodeTerminalStreamFrame(frame: TerminalStreamFrame): ArrayBuffer {
  validate(frame);
  const output = new Uint8Array(TERMINAL_STREAM_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint8(0, TERMINAL_STREAM_VERSION);
  view.setUint8(1, frame.kind);
  view.setUint16(2, 0, false);
  view.setBigUint64(4, BigInt(frame.sequence), false);
  view.setUint32(12, frame.payload.byteLength, false);
  output.set(frame.payload, TERMINAL_STREAM_HEADER_BYTES);
  return output.buffer;
}

export function decodeTerminalStreamFrame(value: ArrayBuffer | ArrayBufferView, direction?: "client" | "server"): TerminalStreamFrame {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.byteLength < TERMINAL_STREAM_HEADER_BYTES) throw new Error("Terminal stream frame is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== TERMINAL_STREAM_VERSION || view.getUint16(2, false) !== 0) throw new Error("Unsupported terminal stream frame");
  const kind = view.getUint8(1);
  const sequence = Number(view.getBigUint64(4, false));
  const payloadLength = view.getUint32(12, false);
  if (!Number.isSafeInteger(sequence) || payloadLength > TERMINAL_STREAM_MAX_PAYLOAD_BYTES || bytes.byteLength !== TERMINAL_STREAM_HEADER_BYTES + payloadLength || !kinds.has(kind)) throw new Error("Invalid terminal stream frame");
  if (direction === "client" && !clientKinds.has(kind)) throw new Error("Unexpected terminal server frame");
  if (direction === "server" && !serverKinds.has(kind)) throw new Error("Unexpected terminal client frame");
  const frame = { kind: kind as TerminalStreamKind, sequence, payload: bytes.slice(TERMINAL_STREAM_HEADER_BYTES) };
  validate(frame);
  return frame;
}

// Short aliases are the public codec names consumed by renderer and main.
export const encodeTerminalFrame = encodeTerminalStreamFrame;
export const decodeTerminalFrame = decodeTerminalStreamFrame;

function validate(frame: TerminalStreamFrame): void {
  if (!kinds.has(frame.kind) || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || frame.payload.byteLength > TERMINAL_STREAM_MAX_PAYLOAD_BYTES) throw new Error("Invalid terminal stream frame");
  if (frame.kind === TerminalStreamKind.Input && (frame.payload.byteLength < 1 || frame.payload.byteLength > 8192)) throw new Error("Invalid terminal input frame");
  if ((frame.kind === TerminalStreamKind.Applied || frame.kind === TerminalStreamKind.Release || frame.kind === TerminalStreamKind.Ready) && frame.payload.byteLength !== 0) throw new Error("Invalid empty terminal frame");
  if (frame.kind === TerminalStreamKind.Resize || frame.kind === TerminalStreamKind.ResizeRequest) {
    if (frame.payload.byteLength !== 4) throw new Error("Invalid terminal resize frame");
    const size = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4);
    if (size.getUint16(0, false) < 20 || size.getUint16(0, false) > 500 || size.getUint16(2, false) < 5 || size.getUint16(2, false) > 300) throw new Error("Invalid terminal resize dimensions");
  }
  if (frame.kind === TerminalStreamKind.Hello || frame.kind === TerminalStreamKind.State || frame.kind === TerminalStreamKind.Error || frame.kind === TerminalStreamKind.Exit || frame.kind === TerminalStreamKind.Acquire || frame.kind === TerminalStreamKind.Result || frame.kind === TerminalStreamKind.Attach) {
    if (frame.payload.byteLength > 4096) throw new Error("Terminal JSON control exceeds limit");
    try { const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload)); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); }
    catch { throw new Error("Invalid terminal JSON frame"); }
  }
}

export type TerminalStreamPortListener = (event: { requestId: string; port: MessagePort }) => void;
