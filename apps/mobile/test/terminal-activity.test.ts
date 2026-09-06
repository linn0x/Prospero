import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function terminalActivity() {
  const html = readFileSync(join(import.meta.dirname, "../../daemon/term.html"), "utf8");
  const start = html.indexOf("  // 性能打点");
  const end = html.indexOf("  /**\n   * 入口", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const write = vi.fn((_bytes: unknown, done?: () => void) => done?.());
  const context = {
    performance: { now: () => 0 },
    requestAnimationFrame: (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    post: vi.fn(), renderer: "fixture", replaying: false,
    term: { write, reset: vi.fn(), resize: vi.fn(), cols: 80, rows: 24 },
    b64ToBytes: () => new Uint8Array([65]),
    handle: undefined as unknown as (message: object) => void,
  };
  runInNewContext(`${html.slice(start, end)}\nglobalThis.handle = handle;`, context);
  return { frames, write, handle: context.handle };
}

describe("terminal activity bridge", () => {
  it("preserves the metrics default for existing clients, then cancels hidden-page animation work", () => {
    const terminal = terminalActivity();
    expect(terminal.frames.size).toBe(1);
    terminal.handle({ kind: "activity", active: false, metrics: true });
    expect(terminal.frames.size).toBe(0);
    terminal.handle({ kind: "output", dataB64: "QQ==" });
    terminal.handle({ kind: "snapshot", ansi: "retained", cols: 80, rows: 24 });
    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(terminal.frames.size).toBe(0);
  });

  it("does not run metrics without the HUD and resumes with exactly one frame loop", () => {
    const terminal = terminalActivity();
    terminal.handle({ kind: "activity", active: true, metrics: false });
    expect(terminal.frames.size).toBe(0);
    terminal.handle({ kind: "activity", active: true, metrics: true });
    terminal.handle({ kind: "activity", active: true, metrics: true });
    expect(terminal.frames.size).toBe(1);
    terminal.handle({ kind: "activity", active: false });
    expect(terminal.frames.size).toBe(0);
  });
});
