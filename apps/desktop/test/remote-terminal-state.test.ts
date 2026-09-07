import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { RemoteTerminalBuffer, remoteInputBase64, remoteTerminalTheme } from "../src/renderer/src/remote-workspaces/remote-terminal-state";

function fixture(limit?: number) {
  const operations: string[] = [];
  const callbacks: Array<() => void> = [];
  const resync = vi.fn();
  const buffer = new RemoteTerminalBuffer({
    reset: (cols, rows) => { operations.push(`reset:${cols}:${rows}`); },
    write: (data, done) => { operations.push(typeof data === "string" ? data : new TextDecoder().decode(data)); callbacks.push(done); },
  }, resync, limit);
  return { buffer, operations, resync, finish: () => callbacks.shift()?.() };
}

describe("remote terminal stream", () => {
  it("preserves UTF-8, control sequences and bracketed paste bytes", () => {
    const input = "\x1b[200~中文 🧪\r\n\x03\x1b[A\x1b[201~";
    expect(new TextDecoder().decode(Uint8Array.from(atob(remoteInputBase64(input)), character => character.charCodeAt(0)))).toBe(input);
  });

  it("waits for the first snapshot and ignores duplicate output", () => {
    const f = fixture();
    f.buffer.output(1, remoteInputBase64("before snapshot"));
    expect(f.operations).toEqual([]);
    f.buffer.snapshot(4, "screen", 80, 24);
    f.buffer.output(4, remoteInputBase64("duplicate"));
    f.buffer.output(5, remoteInputBase64("next"));
    expect(f.operations).toEqual(["reset:80:24", "screen"]);
    f.finish();
    expect(f.operations.at(-1)).toBe("next");
    expect(f.resync).not.toHaveBeenCalled();
  });

  it("requests one fresh snapshot for a sequence gap", () => {
    const f = fixture();
    f.buffer.snapshot(4, "screen", 80, 24);
    f.finish();
    f.buffer.output(7, remoteInputBase64("gap"));
    f.buffer.output(8, remoteInputBase64("more"));
    expect(f.resync).toHaveBeenCalledOnce();
    f.buffer.snapshot(8, "restored", 80, 24);
    f.finish();
    f.buffer.output(9, remoteInputBase64("resumed"));
    expect(f.operations.at(-1)).toBe("resumed");
  });

  it("resets only after the active write and replaces queued old output", () => {
    const f = fixture();
    f.buffer.snapshot(0, "first", 80, 24);
    f.buffer.output(1, remoteInputBase64("old queued output"));
    f.buffer.snapshot(5, "latest", 100, 30);
    f.buffer.output(6, remoteInputBase64("after snapshot"));
    expect(f.operations).toEqual(["reset:80:24", "first"]);
    f.finish();
    expect(f.operations).toEqual(["reset:80:24", "first", "reset:100:30", "latest"]);
    f.finish();
    expect(f.operations.at(-1)).toBe("after snapshot");
    expect(f.operations).not.toContain("old queued output");
  });

  it("bounds queued bytes and stops processing after disposal", () => {
    const f = fixture(8);
    f.buffer.snapshot(0, "", 80, 24);
    f.buffer.output(1, remoteInputBase64("123456"));
    f.buffer.output(2, remoteInputBase64("123456"));
    expect(f.resync).toHaveBeenCalledOnce();
    f.buffer.dispose();
    f.finish();
    f.buffer.snapshot(3, "ignored", 80, 24);
    expect(f.operations).toEqual(["reset:80:24", ""]);
  });

  it("rejects invalid terminal dimensions before allocating the display", () => {
    const f = fixture();
    expect(() => f.buffer.snapshot(1, "", 100000, 24)).toThrow("dimensions");
    expect(f.operations).toEqual([]);
  });

  it("reads terminal colors from the active desktop semantic tokens", () => {
    const colors = new Map([["--surface-sunken", "#f4f4f4"], ["--foreground", "#121212"], ["--selection", "#cccccc"]]);
    const style = { getPropertyValue: (name: string) => colors.get(name) ?? "#888888" };
    expect(remoteTerminalTheme(style)).toMatchObject({ background: "#f4f4f4", foreground: "#121212", cursor: "#121212", selectionBackground: "#cccccc" });
    colors.set("--surface-sunken", "#111111");
    colors.set("--foreground", "#eeeeee");
    expect(remoteTerminalTheme(style)).toMatchObject({ background: "#111111", foreground: "#eeeeee" });
  });

  it("uses the desktop background for viewport pixels below the last terminal row", () => {
    const css = readFileSync(new URL("../src/renderer/src/remote-workspaces/remote-workspaces.css", import.meta.url), "utf8");
    expect(css).toContain(".remote-terminal-canvas .xterm .xterm-viewport { background-color: var(--surface-sunken); }");
  });
});
