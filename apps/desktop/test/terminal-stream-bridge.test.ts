import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ MessageChannelMain: class {
  port1: any; port2: any;
  constructor() {
    const makePort = (): any => {
      const listeners = new Map<string, Array<(value: any) => void>>();
      return { on(name: string, listener: (value: any) => void) { const list = listeners.get(name) ?? []; list.push(listener); listeners.set(name, list); }, emit(name: string, value?: any) { for (const listener of listeners.get(name) ?? []) listener(value); }, start() {}, close() { this.emit("close"); } };
    };
    this.port1 = makePort(); this.port2 = makePort();
    this.port1.postMessage = (value: unknown) => this.port2.emit("message", { data: value });
    this.port2.postMessage = (value: unknown) => this.port1.emit("message", { data: value });
  }
} }));

import { TerminalStreamBridge } from "../src/main/terminal-stream-bridge";
import { TerminalStreamKind, decodeTerminalFrame, encodeTerminalFrame } from "../src/shared/terminal-stream";

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  closed = false;
  sent: ArrayBuffer[] = [];
  send(value: ArrayBuffer, callback?: (error?: Error) => void): void { this.sent.push(value); callback?.(); }
  close(): void { if (!this.closed) { this.closed = true; this.emit("close"); } }
}

describe("terminal stream bridge", () => {
  it("registers connecting attachments for window teardown", async () => {
    const socket = new FakeSocket();
    const bridge = new TerminalStreamBridge(() => socket as never);
    const contents = { id: 9, postMessage: vi.fn() };
    const opening = bridge.open(contents as never, "session", "nonce");
    bridge.closeAllForId(contents.id);
    await expect(opening).rejects.toThrow("closed before attach");
    expect(socket.closed).toBe(true);
  });

  it("requires Attach first and only releases input credit on Result", async () => {
    const socket = new FakeSocket();
    const bridge = new TerminalStreamBridge(() => socket as never);
    const contents = { id: 10, postMessage: vi.fn() };
    const opening = bridge.open(contents as never, "session", "nonce"); socket.emit("open"); await opening;
    const port = contents.postMessage.mock.calls[0]![2][0] as { postMessage(value: ArrayBuffer): void };
    port.postMessage(encodeTerminalFrame({ kind: TerminalStreamKind.Attach, sequence: 0, payload: new TextEncoder().encode('{"wantControl":true}') }));
    for (let sequence = 1; sequence <= 32; sequence++) port.postMessage(encodeTerminalFrame({ kind: TerminalStreamKind.Input, sequence, payload: new Uint8Array(8192).fill(1) }));
    port.postMessage(encodeTerminalFrame({ kind: TerminalStreamKind.Input, sequence: 33, payload: Uint8Array.of(1) }));
    expect(socket.closed).toBe(true);

    const secondSocket = new FakeSocket();
    const secondBridge = new TerminalStreamBridge(() => secondSocket as never);
    const secondContents = { id: 11, postMessage: vi.fn() };
    const pending = secondBridge.open(secondContents as never, "session", "nonce"); secondSocket.emit("open"); await pending;
    const secondPort = secondContents.postMessage.mock.calls[0]![2][0] as { postMessage(value: ArrayBuffer): void };
    secondPort.postMessage(encodeTerminalFrame({ kind: TerminalStreamKind.Attach, sequence: 0, payload: new TextEncoder().encode('{"wantControl":true}') }));
    secondPort.postMessage(encodeTerminalFrame({ kind: TerminalStreamKind.Input, sequence: 1, payload: new Uint8Array(8192).fill(1) }));
    secondSocket.emit("message", encodeTerminalFrame({ kind: TerminalStreamKind.Result, sequence: 1, payload: new TextEncoder().encode('{"ok":false,"code":"rejected"}') }));
    secondPort.postMessage(encodeTerminalFrame({ kind: TerminalStreamKind.Input, sequence: 2, payload: new Uint8Array(8192).fill(2) }));
    expect(secondSocket.closed).toBe(false);
  });

  it("keeps Resize in the acknowledged ordered output credit", async () => {
    const socket = new FakeSocket();
    const bridge = new TerminalStreamBridge(() => socket as never);
    const contents = { id: 12, postMessage: vi.fn() };
    const pending = bridge.open(contents as never, "session", "nonce"); socket.emit("open"); await pending;
    const port = contents.postMessage.mock.calls[0]![2][0] as { postMessage(value: ArrayBuffer): void };
    port.postMessage(encodeTerminalFrame({ kind: TerminalStreamKind.Attach, sequence: 0, payload: new TextEncoder().encode('{"wantControl":true}') }));
    socket.emit("message", encodeTerminalFrame({ kind: TerminalStreamKind.Snapshot, sequence: 0, payload: Uint8Array.of(65) }));
    socket.emit("message", encodeTerminalFrame({ kind: TerminalStreamKind.Output, sequence: 1, payload: Uint8Array.of(66) }));
    socket.emit("message", encodeTerminalFrame({ kind: TerminalStreamKind.Resize, sequence: 2, payload: Uint8Array.of(0, 80, 0, 24) }));
    port.postMessage(encodeTerminalFrame({ kind: TerminalStreamKind.Applied, sequence: 2, payload: new Uint8Array() }));
    expect(socket.closed).toBe(false);
    expect(decodeTerminalFrame(socket.sent.at(-1)!, "client").kind).toBe(TerminalStreamKind.Applied);
  });
});
