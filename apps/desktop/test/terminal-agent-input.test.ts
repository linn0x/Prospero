import { expect, it } from "vitest";
import { terminalAgentImageReference, terminalAgentNewline } from "../src/renderer/src/terminal-agent-input";

const key = { type: "keydown", code: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };

it("preserves supported agents' modified Enter identities without remapping shell input", () => {
  expect(terminalAgentNewline(key, "claude")).toBe("\x1b\r");
  expect(terminalAgentNewline(key, "codex")).toBe("\x1b[13;2u");
  expect(terminalAgentNewline(key, "shell")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, shiftKey: false }, "claude")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, type: "keyup" }, "codex")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, isComposing: true }, "codex")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, defaultPrevented: true }, "claude")).toBeUndefined();
  expect(terminalAgentNewline({ ...key, ctrlKey: true }, "codex")).toBeUndefined();
});

it("quotes saved image paths without sending Enter or injecting a reference into a shell", () => {
  expect(terminalAgentImageReference("codex", "/tmp/My screenshot.png")).toBe('"/tmp/My screenshot.png"');
  expect(terminalAgentImageReference("claude", "/tmp/截屏.png")).toBe('"/tmp/截屏.png"');
  expect(terminalAgentImageReference("codex", "C:\\Users\\Jane Doe\\shot.png")).toBe('"C:\\Users\\Jane Doe\\shot.png"');
  expect(terminalAgentImageReference("codex", "\\\\server\\Jane Doe\\shot.png")).toBe('"\\\\server\\Jane Doe\\shot.png"');
  expect(terminalAgentImageReference("codex", '/tmp/quote" image.png')).toBe('"/tmp/quote\\" image.png"');
  expect(terminalAgentImageReference("codex", "/tmp/back\\slash.png")).toBe('"/tmp/back\\\\slash.png"');
  expect(terminalAgentImageReference("codex", "/tmp/line\nimage.png")).toBe('"/tmp/line\nimage.png"');
  expect(terminalAgentImageReference("shell", "/tmp/image.png")).toBeUndefined();
});
