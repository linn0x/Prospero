import { expect, it, vi } from "vitest";
import { suppressDaemonTerminalQueries, writeTerminalEvents } from "../src/renderer/src/terminal-events";

it("finishes an output write before applying resize and cancels later events", async () => {
  let finish: (() => void) | undefined; let active = true;
  const terminal = { write: vi.fn((_bytes: unknown, done?: () => void) => { finish = done; }), resize: vi.fn() };
  const events = [{ type: "output", dataB64: btoa("first") }, { type: "resize", size: { cols: 100, rows: 30 } }];
  const pending = writeTerminalEvents(terminal, events, () => active);
  expect(terminal.resize).not.toHaveBeenCalled();
  active = false; finish!(); await pending;
  expect(terminal.resize).not.toHaveBeenCalled();
  active = true;
  const completed = writeTerminalEvents(terminal, events, () => active);
  finish!(); await completed;
  expect(terminal.resize).toHaveBeenCalledExactlyOnceWith(100, 30);
});

it("rejects invalid and oversized terminal event pages", async () => {
  const terminal = { write: vi.fn(), resize: vi.fn() };
  await expect(writeTerminalEvents(terminal, Array(65).fill({}), () => true)).rejects.toThrow();
  await expect(writeTerminalEvents(terminal, [{ type: "resize", size: { cols: 0, rows: 1 } }], () => true)).rejects.toThrow();
});

it("merges adjacent output without crossing a resize boundary", async () => {
  const terminal = { write: vi.fn((_bytes: Uint8Array, done?: () => void) => done?.()), resize: vi.fn() };
  await writeTerminalEvents(terminal, [
    { type: "output", dataB64: btoa("a") },
    { type: "output", dataB64: btoa("b") },
    { type: "resize", size: { cols: 80, rows: 24 } },
    { type: "output", dataB64: btoa("c") },
  ], () => true);
  expect(terminal.write).toHaveBeenCalledTimes(2);
  expect(Array.from(terminal.write.mock.calls[0]![0] as Uint8Array)).toEqual([97, 98]);
  expect(terminal.resize).toHaveBeenCalledOnce();
});

it("suppresses only daemon owned terminal queries", () => {
  const csi = new Map<string, (params: (number | number[])[]) => boolean>();
  const osc = new Map<number, (data: string) => boolean>();
  const dispose = suppressDaemonTerminalQueries({
    registerCsiHandler: (id, handler) => { csi.set(id.final, handler); return { dispose: vi.fn() }; },
    registerOscHandler: (id, handler) => { osc.set(id, handler); return { dispose: vi.fn() }; },
  });
  expect(csi.get("c")!([])).toBe(true);
  expect(csi.get("n")!([6])).toBe(true);
  expect(csi.get("n")!([5])).toBe(false);
  expect(osc.get(10)!("?")).toBe(true);
  expect(osc.get(10)!("#fff")).toBe(false);
  dispose();
});

it("does not emit xterm auto replies when event mode owns queries", async () => {
  const terminal = new (await import("@xterm/xterm")).Terminal();
  const output: string[] = [];
  const input = terminal.onData(value => output.push(value));
  const dispose = suppressDaemonTerminalQueries(terminal.parser);
  try {
    await new Promise<void>(done => terminal.write("\x1b[c\x1b[6n\x1b]10;?\x07", done));
    expect(output).toEqual([]);
  } finally {
    dispose(); input.dispose(); terminal.dispose();
  }
});
