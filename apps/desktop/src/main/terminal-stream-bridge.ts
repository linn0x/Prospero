import { MessageChannelMain, type MessagePortMain, type WebContents } from "electron";
import type WebSocket from "ws";
import { TerminalStreamKind, decodeTerminalFrame, encodeTerminalFrame } from "../shared/terminal-stream";

const MAX_PENDING_INPUT_BYTES = 256 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 256 * 1024;
const MAX_PENDING_OUTPUT_FRAMES = 1024;
const MAX_CONTROL_FRAMES_PER_TURN = 256;
const OPEN_TIMEOUT_MS = 7_000;
type StreamSocket = Pick<WebSocket, "bufferedAmount" | "send" | "close" | "on" | "once"> & { terminate?: () => void };
type Attachment = { port: MessagePortMain; socket: StreamSocket; closed: boolean; attached: boolean; pendingInput: number; pendingWireBytes: number; inputOperations: Map<number, number>; pendingOutput: number; outputFrames: Array<{ sequence: number; bytes: number }>; controlFramesThisTurn: number; controlReset: ReturnType<typeof setImmediate> | undefined };

/** Main-process-only credential bridge. The renderer receives only a MessagePort. */
export class TerminalStreamBridge {
  private readonly attachments = new Map<number, Set<Attachment>>();
  constructor(private readonly openSocket: (sessionId: string) => WebSocket) {}

  async open(contents: WebContents, sessionId: string, requestId: string): Promise<void> {
    const socket = this.openSocket(sessionId);
    const { port1, port2 } = new MessageChannelMain();
    const attachment: Attachment = { port: port1, socket, closed: false, attached: false, pendingInput: 0, pendingWireBytes: 0, inputOperations: new Map(), pendingOutput: 0, outputFrames: [], controlFramesThisTurn: 0, controlReset: undefined };
    // Register before the handshake: window teardown also aborts connecting sockets.
    this.bind(contents.id, attachment);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => { clearTimeout(timer); this.close(contents.id, attachment); reject(error); };
      timer = setTimeout(() => fail(new Error("Terminal stream connection timed out")), OPEN_TIMEOUT_MS);
      timer.unref?.();
      socket.once("open", () => {
        if (attachment.closed) return;
        clearTimeout(timer);
        try { contents.postMessage("terminal:port", { requestId }, [port2]); resolve(); }
        catch (cause) { fail(cause instanceof Error ? cause : new Error("Terminal stream port transfer failed")); }
      });
      socket.once("error", () => fail(new Error("Terminal stream connection failed")));
      socket.once("close", () => fail(new Error("Terminal stream closed before attach")));
      socket.on("message", (data: WebSocket.RawData) => this.forwardOutput(contents.id, attachment, data));
      socket.on("close", () => this.close(contents.id, attachment));
      socket.on("error", () => this.close(contents.id, attachment));
      port1.on("message", event => this.forwardInput(contents.id, attachment, event.data));
      port1.on("close", () => this.close(contents.id, attachment));
      port1.start();
    });
  }

  closeAll(contents: WebContents): void { for (const item of [...(this.attachments.get(contents.id) ?? [])]) this.close(contents.id, item); }
  closeAllForId(contentsId: number): void { for (const item of [...(this.attachments.get(contentsId) ?? [])]) this.close(contentsId, item); }
  private bind(contentsId: number, attachment: Attachment): void {
    const entries = this.attachments.get(contentsId) ?? new Set<Attachment>();
    entries.add(attachment); this.attachments.set(contentsId, entries);
  }
  private forwardOutput(contentsId: number, attachment: Attachment, data: WebSocket.RawData): void {
    if (attachment.closed) return;
    try {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const frame = decodeTerminalFrame(bytes, "server");
      if (frame.kind === TerminalStreamKind.Result) this.releaseInput(attachment, frame.sequence);
      if (frame.kind === TerminalStreamKind.Output || frame.kind === TerminalStreamKind.Snapshot || frame.kind === TerminalStreamKind.Resize) {
        const allowance = frame.kind === TerminalStreamKind.Snapshot && attachment.pendingOutput === 0 ? 1024 * 1024 : MAX_PENDING_OUTPUT_BYTES;
        if (attachment.outputFrames.length >= MAX_PENDING_OUTPUT_FRAMES || attachment.pendingOutput + frame.payload.byteLength > allowance) throw new Error("Terminal stream output queue is full");
        attachment.pendingOutput += frame.payload.byteLength;
        attachment.outputFrames.push({ sequence: frame.sequence, bytes: frame.payload.byteLength });
      } else {
        attachment.controlFramesThisTurn++;
        if (attachment.controlFramesThisTurn > MAX_CONTROL_FRAMES_PER_TURN) throw new Error("Terminal stream control queue is full");
        if (!attachment.controlReset) attachment.controlReset = setImmediate(() => { attachment.controlFramesThisTurn = 0; attachment.controlReset = undefined; });
      }
      attachment.port.postMessage(encodeTerminalFrame(frame));
    } catch { this.close(contentsId, attachment); }
  }
  private forwardInput(contentsId: number, attachment: Attachment, value: unknown): void {
    if (attachment.closed) return;
    try {
      if (!(value instanceof ArrayBuffer || ArrayBuffer.isView(value))) throw new Error("Invalid terminal port data");
      const frame = decodeTerminalFrame(value, "client");
      if ((!attachment.attached && frame.kind !== TerminalStreamKind.Attach) || (attachment.attached && frame.kind === TerminalStreamKind.Attach)) throw new Error("Terminal attach ordering violation");
      if (frame.kind === TerminalStreamKind.Input && (!frame.payload.byteLength || frame.payload.byteLength > 8192)) throw new Error("Invalid terminal command");
      const bytes = encodeTerminalFrame(frame);
      if (frame.kind === TerminalStreamKind.Attach) attachment.attached = true;
      if (frame.kind === TerminalStreamKind.Applied) this.acknowledgeOutput(attachment, frame.sequence);
      const inputBytes = frame.kind === TerminalStreamKind.Input ? frame.payload.byteLength : 0;
      if (attachment.pendingInput + attachment.pendingWireBytes + inputBytes > MAX_PENDING_INPUT_BYTES || attachment.socket.bufferedAmount > MAX_PENDING_INPUT_BYTES) throw new Error("Terminal stream input queue is full");
      if (inputBytes) {
        if (attachment.inputOperations.has(frame.sequence)) throw new Error("Duplicate terminal input operation");
        attachment.pendingInput += inputBytes;
        attachment.inputOperations.set(frame.sequence, inputBytes);
      }
      attachment.pendingWireBytes += bytes.byteLength;
      attachment.socket.send(bytes, error => {
        attachment.pendingWireBytes = Math.max(0, attachment.pendingWireBytes - bytes.byteLength);
        if (error) this.close(contentsId, attachment);
      });
    } catch { this.close(contentsId, attachment); }
  }
  private acknowledgeOutput(attachment: Attachment, sequence: number): void {
    const last = attachment.outputFrames.at(-1)?.sequence;
    if (last !== undefined && sequence > last) throw new Error("Terminal stream acknowledgement is ahead of output");
    while (attachment.outputFrames[0] && attachment.outputFrames[0].sequence <= sequence) attachment.pendingOutput -= attachment.outputFrames.shift()!.bytes;
  }
  private releaseInput(attachment: Attachment, sequence: number): void {
    const bytes = attachment.inputOperations.get(sequence);
    if (bytes === undefined) return;
    attachment.inputOperations.delete(sequence);
    attachment.pendingInput = Math.max(0, attachment.pendingInput - bytes);
  }
  private close(contentsId: number, attachment: Attachment): void {
    if (attachment.closed) return;
    attachment.closed = true;
    if (attachment.controlReset) clearImmediate(attachment.controlReset);
    const entries = this.attachments.get(contentsId);
    entries?.delete(attachment); if (entries?.size === 0) this.attachments.delete(contentsId);
    try { attachment.port.close(); } catch { /* already closed */ }
    try { if (attachment.socket.terminate) attachment.socket.terminate(); else attachment.socket.close(); } catch { /* already closed */ }
  }
}
