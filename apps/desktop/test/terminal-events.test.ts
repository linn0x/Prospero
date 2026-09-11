import { expect, it, vi } from "vitest";
import { writeTerminalEvents } from "../src/renderer/src/terminal-events";

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
