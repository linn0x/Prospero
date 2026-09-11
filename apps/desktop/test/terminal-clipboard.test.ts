import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { allowNativeTerminalPaste, bindTerminalPaste, consumeTerminalKey, terminalClipboardShortcut } from "../src/renderer/src/terminal-clipboard";

function pasteEvent(value: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? value : "" } });
  return event;
}

describe("terminal paste ownership", () => {
  it("allows native key paste only when input is ready", () => {
    const allowed = new Event("keydown", { cancelable: true });
    expect(allowNativeTerminalPaste(allowed, true)).toBe(true);
    expect(allowed.defaultPrevented).toBe(false);
    const blocked = new Event("keydown", { cancelable: true });
    expect(allowNativeTerminalPaste(blocked, false)).toBe(false);
    expect(blocked.defaultPrevented).toBe(true);
  });
  it("delivers one native paste once and stops the competing xterm listener", () => {
    const target = new EventTarget();
    const terminal = { paste: vi.fn() }; const native = vi.fn();
    const dispose = bindTerminalPaste(target, terminal, () => true);
    target.addEventListener("paste", native);
    const event = pasteEvent("中文 🦀\nnext");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(native).not.toHaveBeenCalled();
    expect(terminal.paste).toHaveBeenCalledExactlyOnceWith("中文 🦀\nnext");
    target.dispatchEvent(pasteEvent("中文 🦀\nnext"));
    expect(terminal.paste).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("blocks native menu paste while disconnected or read-only and disposes its listener", () => {
    const target = new EventTarget(); const terminal = { paste: vi.fn() }; const blocked = vi.fn();
    let allowed = false;
    const dispose = bindTerminalPaste(target, terminal, () => allowed, blocked);
    target.dispatchEvent(pasteEvent("blocked"));
    expect(terminal.paste).not.toHaveBeenCalled(); expect(blocked).toHaveBeenCalledOnce();
    allowed = true;
    const cancelled = pasteEvent("already handled"); cancelled.preventDefault(); target.dispatchEvent(cancelled);
    expect(terminal.paste).not.toHaveBeenCalled();
    dispose(); target.dispatchEvent(pasteEvent("disposed"));
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("uses the real xterm paste path for line endings and bracketed paste, without adding Enter", async () => {
    const terminal = new Terminal();
    (terminal as unknown as { _core: { textarea: { value: string } } })._core.textarea = { value: "" };
    const output: string[] = [];
    const input = terminal.onData(value => output.push(value));
    const target = new EventTarget(); const dispose = bindTerminalPaste(target, terminal, () => true);
    try {
      target.dispatchEvent(pasteEvent("first\nsecond\r\nthird"));
      expect(output).toEqual(["first\rsecond\rthird"]);
      await new Promise<void>(done => terminal.write("\x1b[?2004h", done));
      output.length = 0;
      target.dispatchEvent(pasteEvent("中文 🦀\nline"));
      expect(output).toEqual(["\x1b[200~中文 🦀\rline\x1b[201~"]);
      terminal.input("\r");
      expect(output).toEqual(["\x1b[200~中文 🦀\rline\x1b[201~", "\r"]);
      terminal.options.disableStdin = true;
      target.dispatchEvent(pasteEvent("not delivered"));
      expect(output).toHaveLength(2);
    } finally { dispose(); input.dispose(); terminal.dispose(); }
  });

  it("keeps control input, composition and extra modifiers outside clipboard shortcuts", () => {
    const key = { type: "keydown", code: "KeyV", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(terminalClipboardShortcut(key, true)).toBe("paste");
    expect(terminalClipboardShortcut({ ...key, isComposing: true }, true)).toBeUndefined();
    expect(terminalClipboardShortcut({ ...key, defaultPrevented: true }, true)).toBeUndefined();
    expect(terminalClipboardShortcut({ ...key, metaKey: false, ctrlKey: true }, true)).toBeUndefined();
    expect(terminalClipboardShortcut({ ...key, metaKey: false, ctrlKey: true, shiftKey: true }, false)).toBe("paste");
    expect(terminalClipboardShortcut({ ...key, metaKey: false, ctrlKey: true, shiftKey: true, altKey: true }, false)).toBeUndefined();
    const event = new Event("keydown", { cancelable: true });
    consumeTerminalKey(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
