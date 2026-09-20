import { describe, expect, it } from "vitest";
import { terminalPlainText } from "../src/renderer/src/terminal-text";

describe("terminalPlainText", () => {
  it.each([
    ["\x1b[31m中文 🦀\x1b[0m\r\nok\bx\x1b]0;title\x07", "中文 🦀\nox"],
    ["a\r\n\n\nb\x00\x07", "a\n\nb"],
    ["one\r\ntwo\rthree", "one\ntwo\nthree"],
    ["a🦀\bx", "ax"],
    ["中\b文", "文"],
    ["\b\bok", "ok"],
    ["\x1b]8;;https://example.test\x1b\\链接\x1b]8;;\x1b\\", "链接"],
    ["a\x1bPignored payload\x1b\\b", "ab"],
    ["ok\x1b[31", "ok"],
    ["plain 中文 👩‍💻", "plain 中文 👩‍💻"],
  ])("cleans %j without corrupting readable text", (raw, expected) => {
    expect(terminalPlainText(raw)).toBe(expected);
  });
});
