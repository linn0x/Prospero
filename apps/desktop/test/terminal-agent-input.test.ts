import { expect, it } from "vitest";
import { parseFontFamilies } from "../src/main/native-ghostty";
import { supportsTerminalImagePaste, terminalAgentImageReference, terminalAgentNewline } from "../src/renderer/src/terminal-agent-input";

const key = { type: "keydown", code: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };

it("preserves supported agents' modified Enter identities without remapping shell input", () => {
  expect(terminalAgentNewline(key, "claude")).toBe("\x1b\r");
  expect(terminalAgentNewline({ ...key, code: "NumpadEnter" }, "claude")).toBe("\x1b\r");
  for (const agent of ["codex", "pi", "agy", "opencode", "grok", "trae", "deepseek"]) {
    expect(terminalAgentNewline(key, agent)).toBe("\x1b[13;2u");
    expect(terminalAgentNewline({ ...key, code: "NumpadEnter" }, agent)).toBe("\x1b[13;2u");
  }
  expect(terminalAgentNewline(key, "shell")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, shiftKey: false }, "claude")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, type: "keyup" }, "codex")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, isComposing: true }, "codex")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, defaultPrevented: true }, "claude")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, ctrlKey: true }, "codex")).toBeUndefined();
});

it("formats escaped pasted image paths across CLI agents and shell without sending Enter", () => {
  for (const agent of ["codex", "claude", "pi", "agy", "opencode", "grok", "trae", "deepseek"]) {
    expect(supportsTerminalImagePaste(agent)).toBe(true);
    expect(terminalAgentImageReference(agent, "/tmp/My screenshot.png")).toBe('"/tmp/My screenshot.png"');
    expect(terminalAgentImageReference(agent, "/tmp/截屏.png")).toBe('"/tmp/截屏.png"');
    expect(terminalAgentImageReference(agent, "C:\\Users\\Jane Doe\\shot.png")).toBe('"C:\\Users\\Jane Doe\\shot.png"');
    expect(terminalAgentImageReference(agent, "\\\\server\\Jane Doe\\shot.png")).toBe('"\\\\server\\Jane Doe\\shot.png"');
    expect(terminalAgentImageReference(agent, '/tmp/quote" image.png')).toBe('"/tmp/quote\\" image.png"');
    expect(terminalAgentImageReference(agent, "/tmp/back\\slash.png")).toBe('"/tmp/back\\\\slash.png"');
    expect(terminalAgentImageReference(agent, "/tmp/line\nimage.png")).toBe('"/tmp/line\nimage.png"');
  }
  expect(supportsTerminalImagePaste("shell")).toBe(true);
  expect(terminalAgentImageReference("shell", "/tmp/My screenshot.png")).toBe("'/tmp/My screenshot.png'");
  expect(terminalAgentImageReference("shell", "/tmp/截屏'1.png")).toBe("'/tmp/截屏'\\''1.png'");
  expect(terminalAgentImageReference("shell", "/tmp/$(whoami)`id`.png")).toBe("'/tmp/$(whoami)`id`.png'");
  expect(terminalAgentImageReference("shell", "C:\\Users\\Jane Doe\\shot.png")).toBe('"C:\\Users\\Jane Doe\\shot.png"');
  expect(supportsTerminalImagePaste("unknown")).toBe(false);
  expect(terminalAgentImageReference("unknown", "/tmp/image.png")).toBeUndefined();
  expect(terminalAgentImageReference("codex", "")).toBeUndefined();
});

it("parses comma-separated fallback font chains and rejects control characters", () => {
  expect(parseFontFamilies(undefined)).toBeUndefined();
  expect(parseFontFamilies('JetBrains Mono, "PingFang SC", \'Apple Color Emoji\'')).toEqual([
    "JetBrains Mono",
    "PingFang SC",
    "Apple Color Emoji",
  ]);
  expect(parseFontFamilies("Menlo, Menlo, PingFang SC,")).toEqual(["Menlo", "PingFang SC"]);
  expect(() => parseFontFamilies("")).toThrow("Native terminal font family is invalid");
  expect(() => parseFontFamilies("Menlo\nkeybind = csi:13u")).toThrow("Native terminal font family is invalid");
});
