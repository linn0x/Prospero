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
    search: { findNext: vi.fn(), findPrevious: vi.fn(), clearDecorations: vi.fn() },
    term: { write, reset: vi.fn(), resize: vi.fn(), cols: 80, rows: 24, options: {} },
    fit: { fit }, setTimeout, clearTimeout,
    document: { fonts: { load: vi.fn(() => new Promise<void>((resolve) => { fontLoads.push(resolve); })) } },
    fontStack: (family: string) => family,
    quotedCSSFontFamily: (family: string) => JSON.stringify(family),
    b64ToBytes: (data: string) => new Uint8Array(Buffer.from(data, "base64")),
    handle: undefined as unknown as (message: object) => void,
  };
  runInNewContext(`${html.slice(start, end)}\nglobalThis.handle = handle;`, context);
  return { frames, write, fit, fontLoads, handle: context.handle, post: context.post, search: context.search };
}

afterEach(() => vi.useRealTimers());

describe("terminal activity bridge", () => {
  it("searches in both directions and clears its decorations", () => {
    const terminal = terminalActivity();
    terminal.handle({ kind: "search", text: "Claude", incremental: true });
    terminal.handle({ kind: "search", text: "Claude", previous: true });
    terminal.handle({ kind: "search", text: "" });
    expect(terminal.search.findNext).toHaveBeenCalledWith("Claude", { incremental: true });
    expect(terminal.search.findPrevious).toHaveBeenCalledWith("Claude");
    expect(terminal.search.clearDecorations).toHaveBeenCalledOnce();
  });
  it("encodes a paste after earlier terminal output without sending it as ordinary input", () => {
    const html = readFileSync(join(import.meta.dirname, "../../daemon/term.html"), "utf8");
    const start = html.indexOf("  let replaying = false;");
    const end = html.indexOf("  /**\n   * 入口", start);
    let onData: (data: string) => void = () => {};
    let finishWrite: (() => void) | undefined;
    let bracketed = false;
    const post = vi.fn();
    const context = {
      term: {
        onData: (handler: typeof onData) => { onData = handler; },
        write: (_bytes: unknown, done: () => void) => { finishWrite = () => { bracketed = true; done(); }; },
        paste: (text: string) => onData(bracketed ? `\x1b[200~${text}\x1b[201~` : text),
        reset: vi.fn(), resize: vi.fn(), cols: 80, rows: 24, options: {},
      },
      post, te: new TextEncoder(), bytesToB64: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
      b64ToBytes: (data: string) => new Uint8Array(Buffer.from(data, "base64")),
      performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame: vi.fn(),
      renderer: "fixture", fit: { fit: vi.fn() }, setTimeout, clearTimeout,
      document: {}, fontStack: (family: string) => family, quotedCSSFontFamily: JSON.stringify,
      handle: undefined as unknown as (message: object) => void,
    };
    runInNewContext(`${html.slice(start, end)}\nglobalThis.handle = handle;`, context);
    context.handle({ kind: "output", dataB64: "QQ==" });
    context.handle({ kind: "encodePaste", requestId: 7, text: "first\nsecond" });
    expect(post).not.toHaveBeenCalled();
    finishWrite!();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ kind: "pasteInput", requestId: 7, data: Buffer.from("\x1b[200~first\nsecond\x1b[201~").toString("base64") });
  });
  it("restores binary UTF-8 snapshots and retains the legacy ANSI fallback", () => {
    const terminal = terminalActivity();
    const bytes = Buffer.from("\x1b[31m中文\x1b[0m\r\n");
    terminal.handle({ kind: "snapshot", ansi: "", dataB64: bytes.toString("base64"), cols: 80, rows: 24 });
    expect(terminal.write.mock.calls[0]?.[0]).toEqual(new Uint8Array(bytes));
    terminal.handle({ kind: "snapshot", ansi: "old server", cols: 80, rows: 24 });
    expect(terminal.write.mock.calls[1]?.[0]).toBe("old server");
  });

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
