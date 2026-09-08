import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "../src/renderer/src/chat/MarkdownContent";
import { LocaleProvider } from "../src/renderer/src/locale";

function render(value: string): string {
  vi.stubGlobal("localStorage", { getItem: () => "zh" });
  return renderToStaticMarkup(<LocaleProvider><MarkdownContent value={value} onError={() => {}} /></LocaleProvider>);
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
});
