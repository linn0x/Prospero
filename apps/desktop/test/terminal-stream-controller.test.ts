import { describe, expect, it, vi } from "vitest";
import { decodeTerminalStreamFrame, encodeTerminalStreamFrame, TerminalStreamKind, type TerminalStreamKind as Kind } from "../src/shared/terminal-stream";
import { TerminalStreamController } from "../src/renderer/src/terminal-stream-controller";

class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: ArrayBuffer[] = []; closed = false;
  start(): void {} close(): void { this.closed = true; }
  postMessage(value: ArrayBuffer): void { this.sent.push(value); }
  receive(value: ArrayBuffer): void { this.onmessage?.({ data: value } as MessageEvent); }
}
const json = (value: Record<string, unknown>): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const frame = (kind: Kind, sequence: number, payload = new Uint8Array()): ArrayBuffer => encodeTerminalStreamFrame({ kind, sequence, payload });
const tick = async (): Promise<void> => { await new Promise<void>(resolve => setTimeout(resolve, 0)); for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
function setup({ cursor = 4, epoch, consume = async () => undefined }: { cursor?: number; epoch?: string; consume?: () => Promise<void> } = {}) {
  const port = new Port(); const errors: string[] = []; const gaps: string[] = [];
  const controller = new TerminalStreamController({ sessionId: "term", cursor: () => cursor, epoch: () => epoch, wantControl: false, consume, onState: () => undefined, onError: message => errors.push(message), onHistoryGap: message => gaps.push(message) });
  controller.attach(port as unknown as MessagePort);
  const hello = (controllerId: string | null = "me", nextEpoch = "next") => port.receive(frame(TerminalStreamKind.Hello, 0, json({ epoch: nextEpoch, clientId: "me", controllerId, cols: 80, rows: 24, windowBytes: 1 })));
  const ready = (sequence = cursor) => port.receive(frame(TerminalStreamKind.Ready, sequence));
  return { port, controller, errors, gaps, hello, ready };
}

describe("TerminalStreamController", () => {
  it("accepts a full-size snapshot with its surrounding control frames", async () => {
    const current = setup();
    current.hello();
    current.port.receive(frame(TerminalStreamKind.Snapshot, 4, new Uint8Array(1024 * 1024).fill(32)));
    current.ready(4);
    await tick();
    expect(current.errors).toEqual([]);
    expect(current.port.sent.map(value => decodeTerminalStreamFrame(value, "client").kind)).toContain(TerminalStreamKind.Applied);
    current.controller.close();
  });
  it("sends Applied only after the xterm consumer has fully committed", async () => {
    let commit!: () => void; const consumed = new Promise<void>(resolve => { commit = resolve; });
    const current = setup({ consume: () => consumed }); current.hello();
    current.port.receive(frame(TerminalStreamKind.Output, 5, new Uint8Array([65]))); await tick();
    expect(current.port.sent).toHaveLength(1); commit(); await tick();
    expect(decodeTerminalStreamFrame(current.port.sent[1]!, "client")).toMatchObject({ kind: TerminalStreamKind.Applied, sequence: 5 });
    current.ready(5);
  });

  it("coalesces consecutive output frames without crossing a resize boundary", async () => {
    const received: Array<{ sequence: number; bytes: number }> = [];
    const current = setup({ consume: async () => undefined });
    // Replace the test controller so the consumed frame is observable.
    current.controller.close();
    const port = new Port();
    const controller = new TerminalStreamController({ sessionId: "term", cursor: () => 4, epoch: () => undefined, wantControl: false, consume: async item => { received.push({ sequence: item.sequence, bytes: item.payload.byteLength }); }, onState: () => undefined, onError: message => { throw new Error(message); }, onHistoryGap: () => undefined });
    controller.attach(port as unknown as MessagePort);
    port.receive(frame(TerminalStreamKind.Hello, 0, json({ epoch: "x", clientId: "me", controllerId: "me", cols: 80, rows: 24, windowBytes: 1 }))); await tick();
    port.receive(frame(TerminalStreamKind.Output, 5, new Uint8Array([65]))); port.receive(frame(TerminalStreamKind.Output, 6, new Uint8Array([66]))); port.receive(frame(TerminalStreamKind.Resize, 7, new Uint8Array([0, 80, 0, 24]))); await tick();
    expect(received).toEqual([{ sequence: 6, bytes: 2 }, { sequence: 7, bytes: 4 }]);
    expect(port.sent.slice(1).map(item => decodeTerminalStreamFrame(item, "client").sequence)).toEqual([6, 7]);
  });

  it("blocks input and resize before Ready and for observers", async () => {
    const current = setup();
    await expect(current.controller.input(new Uint8Array([65]))).rejects.toThrow("not ready");
    current.hello(null); await tick(); current.ready(); await tick();
    await expect(current.controller.input(new Uint8Array([65]))).rejects.toThrow("observing");
    await expect(current.controller.resize(80, 24)).rejects.toThrow("observing");
  });

  it("revokes old-owner writes after takeover state and never replays disconnect input", async () => {
    const current = setup(); current.hello(); await tick(); current.ready(); await tick();
    const pending = current.controller.input(new Uint8Array([65]));
    current.port.receive(frame(TerminalStreamKind.State, 0, json({ controllerId: "other", readOnly: false, exited: false }))); await tick();
    await expect(current.controller.input(new Uint8Array([66]))).rejects.toThrow("observing");
    current.port.onmessageerror?.(); await expect(pending).rejects.toThrow("could not be decoded");
    expect(current.port.sent.filter(item => decodeTerminalStreamFrame(item, "client").kind === TerminalStreamKind.Input)).toHaveLength(1);
  });

  it("keeps a healthy but blocked input pending beyond fifteen seconds", async () => {
    const current = setup(); current.hello(); await tick(); current.ready(); await tick();
    const input = current.controller.input(new Uint8Array([65]));
    let settled = false; void input.then(() => { settled = true; }, () => { settled = true; });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(settled).toBe(false);
    current.port.receive(frame(TerminalStreamKind.Result, 1, json({ ok: true })));
    await vi.runAllTimersAsync(); await Promise.resolve();
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it("writes large pasted bytes in ordered 8KiB chunks and stops after a rejected prefix", async () => {
    const current = setup(); current.hello(); await tick(); current.ready(); await tick();
    const paste = new Uint8Array(20_001).fill(0x80);
    const sent = current.controller.input(paste);
    await tick();
    expect(decodeTerminalStreamFrame(current.port.sent[1]!, "client").payload.byteLength).toBe(8192);
    current.port.receive(frame(TerminalStreamKind.Result, 1, json({ ok: true }))); await tick();
    expect(decodeTerminalStreamFrame(current.port.sent[2]!, "client").payload.byteLength).toBe(8192);
    current.port.receive(frame(TerminalStreamKind.Result, 2, json({ ok: false, code: "blocked" }))); await expect(sent).rejects.toThrow("blocked");
    expect(current.port.sent).toHaveLength(3);
  });

  it("preserves screen ownership on wrong epoch/history gap and rejects malformed or out-of-order frames", async () => {
    let writes = 0; const current = setup({ epoch: "old", consume: async () => { writes += 1; } });
    current.hello("me", "new"); await tick(); current.ready(); await tick(); current.port.receive(frame(TerminalStreamKind.Error, 0, json({ code: "history_gap", message: "expired", recoverable: false }))); await tick();
    // Epoch mismatch closes this attachment before its later history error can
    // be trusted; it is one fresh-reload notice, not two notifications.
    expect(current.gaps).toHaveLength(1); expect(current.gaps[0]).toMatch(/epoch changed/); expect(writes).toBe(0);
    await expect(current.controller.input(new Uint8Array([65]))).rejects.toThrow("not ready");
    const malformed = setup(); malformed.port.receive(new ArrayBuffer(1)); await tick(); expect(malformed.errors[0]).toMatch(/truncated/);
    const barrier = setup(); barrier.hello(); await tick(); barrier.ready(3); await tick(); expect(barrier.errors[0]).toMatch(/Ready cursor/);
    const ordering = setup(); ordering.hello(); await tick(); ordering.ready(); await tick(); ordering.port.receive(frame(TerminalStreamKind.Output, 7, new Uint8Array([65]))); await tick(); expect(ordering.errors[0]).toMatch(/out of order/);
    const gap = setup(); gap.hello(); await tick(); gap.ready(); await tick(); gap.port.receive(frame(TerminalStreamKind.Error, 0, json({ code: "history_gap", message: "expired", recoverable: false }))); await tick(); expect(gap.gaps).toEqual(["expired"]);
    const wireEpoch = setup(); wireEpoch.port.receive(frame(TerminalStreamKind.Error, 0, json({ code: "epoch_mismatch", message: "different host", recoverable: false }))); await tick(); expect(wireEpoch.gaps).toEqual(["different host"]);
  });

  it("does not consume a co-batched Output after a fresh-reload error", async () => {
    let writes = 0;
    const current = setup({ consume: async () => { writes += 1; } });
    current.hello(); await tick(); current.ready(); await tick();
    current.port.receive(frame(TerminalStreamKind.Error, 0, json({ code: "epoch_mismatch", message: "new epoch", recoverable: false })));
    current.port.receive(frame(TerminalStreamKind.Output, 5, new Uint8Array([65])));
    await tick();
    expect(writes).toBe(0); expect(current.gaps).toEqual(["new epoch"]);
  });

  it("rejects dangling operations and closes previous ports on reattach/unmount", async () => {
    const current = setup(); current.hello(); await tick(); current.ready(); await tick(); const pending = current.controller.input(new Uint8Array([65]));
    const next = new Port(); current.controller.attach(next as unknown as MessagePort);
    expect(current.port.closed).toBe(true); await expect(pending).rejects.toThrow("reattached");
    current.controller.close(); expect(next.closed).toBe(true);
    const unmatched = setup(); unmatched.hello(); await tick(); unmatched.ready(); await tick(); unmatched.port.receive(frame(TerminalStreamKind.Result, 77, json({ ok: true }))); await tick(); expect(unmatched.errors[0]).toMatch(/did not match/);
  });

  it("keeps a clean Exit visible when the port closes afterwards", async () => {
    const current = setup(); current.hello(); await tick(); current.ready(); await tick();
    current.port.receive(frame(TerminalStreamKind.Exit, 0, json({ exitCode: 0 }))); await tick();
    current.port.onmessageerror?.(); await tick();
    expect(current.errors).toEqual([]);
  });
});
