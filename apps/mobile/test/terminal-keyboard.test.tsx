import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toB64, utf8Encode } from "@prospero/protocol";
import type { HostConnection } from "../src/lib/connection";
import { terminalKeySequence } from "../src/lib/keys";
import { useTerminalKeyboard } from "../src/lib/use-terminal-keyboard";

const focus = vi.hoisted(() => ({ cleanup: null as (() => void) | null }));
// Run focus effects after rendering, like React Navigation; avoid server render setState loops.
const effects = vi.hoisted(() => [] as (() => () => void)[]);
vi.mock("../src/lib/use-focused-session-effect", () => ({ useFocusedSessionEffect: (effect: () => () => void) => { effects.push(effect); } }));
const ctrl = { ctrl: true, option: false };
const option = { ctrl: false, option: true };
beforeEach(() => { effects.length = 0; focus.cleanup = null; });

function keyboard(enabled = true) {
  const conn = { inputText: vi.fn().mockReturnValue({ accepted: true, disposition: "sent" }), inputB64: vi.fn().mockReturnValue({ accepted: true, disposition: "sent" }) };
  let input!: ReturnType<typeof useTerminalKeyboard>;
  function Fixture() { input = useTerminalKeyboard(conn as unknown as HostConnection, "shell-1", enabled); return null; }
  renderToStaticMarkup(createElement(Fixture));
  for (const effect of effects) focus.cleanup = effect();
  return { input, conn };
}

describe("remote terminal keyboard", () => {
  it("encodes macOS word navigation, Option delete and Ctrl/Option combinations", () => {
    expect(terminalKeySequence("\x1b[D", option)).toBe("\x1bb");
    expect(terminalKeySequence("\x1b[C", option)).toBe("\x1bf");
    expect(terminalKeySequence("\x7f", option)).toBe("\x1b\x7f");
    expect(terminalKeySequence("c", ctrl)).toBe("\x03");
    expect(terminalKeySequence(" ", ctrl)).toBe("\x00");
    expect(terminalKeySequence("[", ctrl)).toBe("\x1b");
    expect(terminalKeySequence("r", { ctrl: true, option: true })).toBe("\x1b\x12");
    expect(terminalKeySequence("\x1b[A", ctrl)).toBe("\x1b[1;5A");
    expect(terminalKeySequence("\x1b[3~", option)).toBe("\x1b[3;3~");
    expect(terminalKeySequence("中文输入", option)).toBe("中文输入");
  });
  it("applies a latched modifier to the next WebView input only", () => {
    const { input, conn } = keyboard();
    input.toggleModifier("option");
    input.inputB64(toB64(utf8Encode("b")));
    expect(conn.inputText).toHaveBeenCalledWith("shell-1", "\x1bb");
    input.inputB64(toB64(utf8Encode("next")));
    expect(conn.inputB64).toHaveBeenCalledWith("shell-1", toB64(utf8Encode("next")));
  });
  it("keeps toolbar, paste and focus changes on the same modifier state", () => {
    const { input, conn } = keyboard();
    input.toggleModifier("ctrl"); input.sendKey("C");
    expect(conn.inputText).toHaveBeenLastCalledWith("shell-1", "\x03");
    input.toggleModifier("option"); input.paste("b"); input.sendKey("f");
    expect(conn.inputText.mock.calls.slice(-2)).toEqual([["shell-1", "b"], ["shell-1", "f"]]);
    input.toggleModifier("ctrl"); focus.cleanup!();
    expect(input.sendKey("c").accepted).toBe(false);
    expect(input.inputB64("Yw==").accepted).toBe(false);
    focus.cleanup = effects[0]!(); input.sendKey("c");
    expect(conn.inputText).toHaveBeenLastCalledWith("shell-1", "c");
  });
  it("freezes every input path while disconnected and never buffers shell bytes", () => {
    const { input, conn } = keyboard(false);
    input.toggleModifier("ctrl");
    expect(input.sendKey("c")).toEqual({ accepted: false, reason: "offline" });
    expect(input.paste("pwd\n").accepted).toBe(false);
    expect(input.inputB64("Yw==").accepted).toBe(false);
    expect(conn.inputText).not.toHaveBeenCalled(); expect(conn.inputB64).not.toHaveBeenCalled();
  });
  it("retains a modifier after rejected delivery until a successful send or focus change", () => {
    const { input, conn } = keyboard();
    conn.inputText.mockReturnValueOnce({ accepted: false, reason: "transport_error" });
    input.toggleModifier("ctrl"); input.sendKey("c"); input.sendKey("c"); input.sendKey("c");
    expect(conn.inputText.mock.calls.map((call) => call[1])).toEqual(["\x03", "\x03", "c"]);
  });
});
