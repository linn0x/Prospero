import { describe, expect, it, vi } from "vitest";
import {
  canDeliverTerminalInteraction,
  fitTerminalViewport,
  getTerminalEmptyFrameDelay,
  terminalBootstrapCursor,
  terminalClipboardAction,
  terminalInputShouldScrollToBottom,
  terminalNormalizeProposedSize,
  terminalProposedSizeDiffers,
  terminalSessionIsReadOnly,
  terminalShortcutAction,
} from "../src/renderer/src/TerminalPane";

function key(overrides: Partial<KeyboardEvent> = {}): Pick<KeyboardEvent, "type" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return {
    type: "keydown",
    code: "KeyC",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("terminal clipboard shortcuts", () => {
  it("backs off when an older daemon returns an immediate empty frame", () => {
    expect(getTerminalEmptyFrameDelay(5)).toBe(650);
    expect(getTerminalEmptyFrameDelay(20_000)).toBe(0);
  });

  it("bootstraps a cache miss from the output ring", () => {
    expect(terminalBootstrapCursor()).toBe(0);
    expect(terminalBootstrapCursor(42)).toBe(42);
    expect(terminalBootstrapCursor(-1)).toBe(0);
  });

  it("detects stale terminal geometry before tmux wheel handling", () => {
    expect(terminalNormalizeProposedSize(undefined)).toBeUndefined();
    expect(terminalNormalizeProposedSize({ cols: 1, rows: 1 })).toEqual({ cols: 20, rows: 5 });
    expect(terminalProposedSizeDiffers(120, 40, undefined)).toBe(false);
    expect(terminalProposedSizeDiffers(120, 40, { cols: 120, rows: 40 })).toBe(false);
    expect(terminalProposedSizeDiffers(120, 40, { cols: 121, rows: 40 })).toBe(true);
    expect(terminalProposedSizeDiffers(20, 5, { cols: 1, rows: 1 })).toBe(false);
  });

  it("does not snap tmux mouse wheel input back to the bottom", () => {
    expect(terminalInputShouldScrollToBottom("\x1b[<64;10;20M")).toBe(false);
    expect(terminalInputShouldScrollToBottom("\x1b[M`12")).toBe(false);
    expect(terminalInputShouldScrollToBottom("a")).toBe(true);
    expect(terminalInputShouldScrollToBottom("\x1b[<64;10;20Ma")).toBe(true);
  });

  it("keeps ended terminals read-only while draining accepted input", () => {
    expect(terminalSessionIsReadOnly("done")).toBe(true);
    expect(terminalSessionIsReadOnly("died")).toBe(true);
    expect(terminalSessionIsReadOnly("running")).toBe(false);
    expect(canDeliverTerminalInteraction(false, false, true)).toBe(true);
    expect(canDeliverTerminalInteraction(false, false)).toBe(false);
    expect(canDeliverTerminalInteraction(true, true, true)).toBe(false);
  });

  it("uses native Command shortcuts on macOS without swallowing Control-C", () => {
    expect(terminalClipboardAction(key({ metaKey: true }), true)).toBe("copy");
    expect(terminalClipboardAction(key({ metaKey: true, code: "KeyV" }), true)).toBe("paste");
    expect(terminalClipboardAction(key({ ctrlKey: true }), true)).toBeUndefined();
  });

  it("keeps Ctrl+Shift clipboard shortcuts on other platforms", () => {
    expect(terminalClipboardAction(key({ ctrlKey: true, shiftKey: true }), false)).toBe("copy");
    expect(terminalClipboardAction(key({ ctrlKey: true, shiftKey: true, code: "KeyV" }), false)).toBe("paste");
    expect(terminalClipboardAction(key({ ctrlKey: true }), false)).toBeUndefined();
  });

  it("does not hijack modified Command shortcuts or keyup events", () => {
    expect(terminalClipboardAction(key({ metaKey: true, altKey: true }), true)).toBeUndefined();
    expect(terminalClipboardAction(key({ metaKey: true, shiftKey: true }), true)).toBeUndefined();
    expect(terminalClipboardAction(key({ metaKey: true, type: "keyup" }), true)).toBeUndefined();
  });

  it("matches the Swift shell editing and Option-word shortcuts on macOS", () => {
    expect(terminalShortcutAction(key({ metaKey: true, code: "KeyA" }), true)).toBe("selectAll");
    expect(terminalShortcutAction(key({ metaKey: true, code: "KeyK" }), true)).toBe("clear");
    expect(terminalShortcutAction(key({ metaKey: true, code: "ArrowLeft", key: "ArrowLeft" }), true)).toBe("beginningOfLine");
    expect(terminalShortcutAction(key({ metaKey: true, code: "ArrowRight", key: "ArrowRight" }), true)).toBe("endOfLine");
    expect(terminalShortcutAction(key({ metaKey: true, code: "Backspace", key: "Backspace" }), true)).toBe("deleteToBeginning");
    expect(terminalShortcutAction(key({ altKey: true, code: "ArrowLeft", key: "ArrowLeft" }), true)).toBe("backwardWord");
    expect(terminalShortcutAction(key({ altKey: true, code: "ArrowRight", key: "ArrowRight" }), true)).toBe("forwardWord");
  });

  it("opens find on both platforms", () => {
    expect(terminalShortcutAction(key({ metaKey: true, code: "KeyF" }), true)).toBe("find");
    expect(terminalShortcutAction(key({ ctrlKey: true, shiftKey: true, code: "KeyF" }), false)).toBe("find");
    expect(terminalShortcutAction(key({ ctrlKey: true, code: "KeyF" }), false)).toBeUndefined();
  });

  it("does not treat find as a clipboard action", () => {
    // terminalClipboardAction 只该回报复制/粘贴;查找走的是另一条分支。
    expect(terminalClipboardAction(key({ metaKey: true, code: "KeyF" }), true)).toBeUndefined();
  });

  it("leaves bare Command-F alone on non-mac", () => {
    // 其它平台上裸 ⌘/Meta 不是剪贴板修饰键,不该被吞掉。
    expect(terminalShortcutAction(key({ metaKey: true, code: "KeyF" }), false)).toBeUndefined();
  });

  it("keeps Shift+Insert paste available outside macOS", () => {
    expect(terminalShortcutAction(key({ shiftKey: true, code: "Insert" }), false)).toBe("paste");
  });
});

describe("terminal viewport replay ordering", () => {
  it("requests daemon resize without reflowing the local event terminal", () => {
    const terminal = { cols: 120, rows: 40 };
    const fit = { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) };
    const resize = vi.fn();
    fitTerminalViewport(terminal, fit, { events: true, connected: true, readOnly: false, replaying: false, stable: true }, resize);
    expect(resize).toHaveBeenCalledExactlyOnceWith({ cols: 80, rows: 24 });
    expect(fit.fit).not.toHaveBeenCalled();
    expect(terminal).toEqual({ cols: 120, rows: 40 });
  });
  it.each([
    { connected: false, readOnly: false, replaying: false, stable: true },
    { connected: true, readOnly: false, replaying: true, stable: true },
    { connected: true, readOnly: false, replaying: false, stable: false },
    { connected: true, readOnly: true, replaying: false, stable: true },
  ])("does not change geometry while resuming or draining: %j", state => {
    const fit = { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })) };
    const resize = vi.fn();
    fitTerminalViewport({ cols: 120, rows: 40 }, fit, { events: true, ...state }, resize);
    expect(fit.fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });
});
