import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

function terminalActivity() {
  const html = readFileSync(join(import.meta.dirname, "../../daemon/term.html"), "utf8")
    .replaceAll("\r\n", "\n");
  const start = html.indexOf("  // 首次尺寸");
  const end = html.indexOf("  /**\n   * 入口", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const write = vi.fn((_bytes: unknown, done?: () => void) => done?.());
  const fontLoads: (() => void)[] = [];
  const fit = vi.fn();
  const context = {
    performance: { now: () => 0 },
    requestAnimationFrame: (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    post: vi.fn(), renderer: "fixture", replaying: false,
    term: { write, reset: vi.fn(), resize: vi.fn(), cols: 80, rows: 24, options: {} },
    fit: { fit }, setTimeout, clearTimeout,
    document: { fonts: { load: vi.fn(() => new Promise<void>((resolve) => { fontLoads.push(resolve); })) } },
    fontStack: (family: string) => family,
    quotedCSSFontFamily: (family: string) => JSON.stringify(family),
    b64ToBytes: () => new Uint8Array([65]),
    handle: undefined as unknown as (message: object) => void,
  };
  runInNewContext(`${html.slice(start, end)}\nglobalThis.handle = handle;`, context);
  return { frames, write, fit, fontLoads, handle: context.handle, post: context.post };
}

afterEach(() => vi.useRealTimers());

describe("terminal activity bridge", () => {
  it("waits for the selected font before publishing terminal dimensions, including rapid font changes", async () => {
    vi.useFakeTimers();
    const terminal = terminalActivity();
    terminal.handle({ kind: "font", size: 12, family: "JetBrainsMono Nerd Font Mono" });
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.fit).not.toHaveBeenCalled();
    terminal.fontLoads[0]!();
    await Promise.resolve();
    // A size change while the previous fit is scheduled must wait for the new font.
    terminal.handle({ kind: "font", size: 14, family: "JetBrainsMono Nerd Font Mono" });
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.fit).not.toHaveBeenCalled();
    terminal.handle({ kind: "font", size: 16, family: "JetBrainsMono Nerd Font Mono" });
    terminal.fontLoads[1]!();
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.fit).not.toHaveBeenCalled();
    terminal.fontLoads[2]!();
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.fit).toHaveBeenCalledTimes(1);
    expect(terminal.post).toHaveBeenCalledWith({ kind: "resized", cols: 80, rows: 24 });
  });

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
