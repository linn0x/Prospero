import { describe, expect, it } from "vitest";
import {
  getTerminalEmptyFrameDelay,
  terminalClipboardAction,
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
    // ⌘F 在 mac、Ctrl+Shift+F 在其它平台 —— 查找不该只有一个平台能用。
    expect(terminalShortcutAction(key({ metaKey: true, code: "KeyF" }), true)).toBe("find");
    expect(terminalShortcutAction(key({ ctrlKey: true, shiftKey: true, code: "KeyF" }), false)).toBe("find");
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
