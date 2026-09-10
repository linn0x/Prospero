import { describe, expect, it } from "vitest";
import { codeLanguage, highlightCode, isMarkdownFile, MAX_HIGHLIGHT_CHARS } from "../src/lib/code-highlight";

describe("file syntax highlighting", () => {
  it.each([
    ["app.TSX", "typescript"], ["src/main.py", "python"], ["Main.kt", "kotlin"], ["D:\\work\\run.ps1", "powershell"],
    ["Dockerfile.dev", "dockerfile"], ["Makefile", "makefile"], [".env.local", "ini"], ["a.rs", "rust"],
    ["a.cpp", "cpp"], ["a.swift", "swift"], ["a.dart", "dart"], ["app.vue", "xml"], ["a.unknown", null],
  ])("detects %s", (file, expected) => expect(codeLanguage(file)).toBe(expected));

  it.each([
    ["typescript", 'const value: string = "<&amp;>"; // 注释\nfunction f() { return 42; }'],
    ["python", 'def f():\n  # 注释\n  return "hello"'],
    ["json", '{"name":"中文", "count":2, "ok":true}'],
    ["kotlin", 'fun main() { val answer = 42; println("hello") }'],
    ["xml", '<div class="hero"><script>alert("<test>")</script></div>'],
    ["powershell", '$name = "hello"\nWrite-Host $name'],
    ["rust", 'fn main() { let value = Some(1); }'],
  ])("preserves every source character for %s while applying multiple colors", (language, source) => {
    const result = highlightCode(source, language);
    expect(result.limited).toBe(false);
    expect(result.tokens.map((token) => token.text).join("")).toBe(source);
    expect(new Set(result.tokens.map((token) => token.kind)).size).toBeGreaterThan(1);
  });

  it("pairs rainbow brackets by nesting and ignores brackets inside strings and comments", () => {
    const result = highlightCode('const a = { b: [f(1)], s: "[)]" }; // ({[', "javascript");
    expect(result.tokens.filter((token) => token.rainbow !== undefined).map(({ text, rainbow }) => [text, rainbow])).toEqual([
      ["{", 0], ["[", 1], ["(", 2], [")", 2], ["]", 1], ["}", 0],
    ]);
    expect(highlightCode('f([1])', "javascript", false).tokens.every((token) => token.rainbow === undefined)).toBe(true);
  });

  it("shows unknown and oversized files intact without expensive tokenization", () => {
    const source = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(highlightCode(source, "typescript")).toMatchObject({ tokens: [{ text: source, kind: "plain" }], limited: true });
    expect(highlightCode("raw <text> & value", "unknown").tokens).toEqual([{ text: "raw <text> & value", kind: "plain" }]);
    expect(isMarkdownFile("notes.MD")).toBe(true);
    expect(isMarkdownFile("notes.markdown")).toBe(true);
    expect(isMarkdownFile("notes.txt")).toBe(false);
  });
});
