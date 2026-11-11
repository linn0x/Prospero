import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKDOWN_STREAM_THROTTLE_MS, MarkdownContent, createMarkdownStreamThrottle } from "../src/renderer/src/chat/MarkdownContent";
import { LocaleProvider } from "../src/renderer/src/locale";

function render(value: string, projectRoot?: string): string {
  vi.stubGlobal("localStorage", { getItem: () => "zh" });
  return renderToStaticMarkup(<LocaleProvider><MarkdownContent value={value} projectRoot={projectRoot} onError={() => {}} /></LocaleProvider>);
}
afterEach(() => vi.unstubAllGlobals());
describe("Markdown rendering", () => {
  it("renders GFM, local math, emoji and highlighted code together", () => {
    const html = render("## 中文标题 :smile:\n\n**粗体**和~~删除~~\n\n- [x] 完成\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$E=mc^2$\n\n\\[\\frac{1}{2}\\]\n\n```js\nconst value = 42;\n```");
    for (const expected of ["<h2>", "😄", "<strong>粗体</strong>", "<del>删除</del>", "<table>", 'type="checkbox"', 'class="katex"', 'class="katex-display"', "hljs-keyword", "复制"]) expect(html).toContain(expected);
  });
  it("does not execute model-provided HTML, scripts or unsafe links", () => {
    const html = render('<script>alert(1)</script>\n\n[click](javascript:alert)\n\n<img src="x" onerror="alert(1)">');
    for (const unsafe of ["<script", "javascript:", "onerror=", "<img"]) expect(html).not.toContain(unsafe);
  });
  it("remains renderable with incomplete code and formulas while streaming", () => {
    expect(render("```python\nprint('中文')")).toContain("中文");
    expect(render("partial $x^{")).toContain("partial");
  });
  it("preserves project file links and Windows drive paths without enabling unsafe URLs", () => {
    const html = render('[source](D:/project/src/app.ts:12) [report](report.md) [outside](D:/private/secret.md) [script](javascript:alert)', 'D:/project');
    expect(html).toContain('href="D:/project/src/app.ts:12"');
    expect(html).toContain('href="report.md"');
    expect(html).not.toContain('href="D:/private/secret.md"');
    expect(html).not.toContain('javascript:');
  });
  it("strips terminal control bytes before markdown rendering", () => {
    const html = render('\x1b[31m### 中文标题\x1b[0m\r\n正文\b本\x1b]8;;https://example.test\x1b\\链接\x1b]8;;\x1b\\');
    expect(html).toContain("<h3>中文标题</h3>");
    expect(html).toContain("正本");
    expect(html).toContain("链接");
    for (const leaked of ["\\u001b", "[31m", "]8;;", "\\u0008"]) expect(html).not.toContain(leaked);
  });
  it("skips expensive 190-language auto-detection on unlabelled streaming code fences while highlighting labelled blocks", () => {
    expect(MARKDOWN_STREAM_THROTTLE_MS).toBeGreaterThanOrEqual(50);
    const unlabelled = render("```\nfunction demo() { return 42; }\n```");
    expect(unlabelled).toContain("function demo() { return 42; }");
    expect(unlabelled).not.toContain("hljs-keyword");

    const labelled = render("```js\nfunction demo() { return 42; }\n```");
    expect(labelled).toContain("hljs-keyword");
  });
  it("throttles rapid streaming Markdown deltas to ~65ms intervals and flushes final text via trailing timer or completion", () => {
    vi.useFakeTimers();
    const committed: string[] = [];
    const throttle = createMarkdownStreamThrottle((next) => committed.push(next));
    throttle.init("t0");

    // Push 20 rapid tokens 5ms apart (100ms total): should commit only ~1-2 times instead of 20 O(L^2) parses
    for (let index = 1; index <= 20; index++) {
      vi.advanceTimersByTime(5);
      throttle.push(`t${index}`, true);
    }
    expect(committed.length).toBeLessThanOrEqual(2);

    // Trailing timer flushes the exact latest token when streaming pauses
    vi.advanceTimersByTime(MARKDOWN_STREAM_THROTTLE_MS);
    expect(committed.at(-1)).toBe("t20");

    // When streaming finishes (streaming === false), final text flushes synchronously without waiting for timer
    vi.advanceTimersByTime(5);
    throttle.push("t21-partial", true);
    throttle.push("t21-final", false);
    expect(committed.at(-1)).toBe("t21-final");

    throttle.dispose();
    vi.useRealTimers();
  });
});
