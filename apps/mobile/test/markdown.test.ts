import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/lib/markdown";

describe("Markdown 解析", () => {
  it("段落合并连续行", () => {
    expect(parseMarkdown("hello\nworld")).toEqual([
      { type: "paragraph", spans: [{ text: "hello world" }] },
    ]);
  });

  it("标题带级别", () => {
    const b = parseMarkdown("## 结论\n正文");
    expect(b[0]).toMatchObject({ type: "heading", level: 2 });
    expect(b[1]).toMatchObject({ type: "paragraph" });
  });

  it("无序与有序列表", () => {
    const b = parseMarkdown("- 一\n* 二\n1. 三\n2) 四");
    expect(b).toHaveLength(4);
    expect(b.every((x) => x.type === "bullet")).toBe(true);
    expect(b[2]).toMatchObject({ ordered: "1" });
    expect(b[3]).toMatchObject({ ordered: "2" });
  });

  it("代码块保留原始换行与语言", () => {
    const b = parseMarkdown("```ts\nconst a = 1;\nconst b = 2;\n```");
    expect(b[0]).toEqual({ type: "code", lang: "ts", code: "const a = 1;\nconst b = 2;" });
  });

  it("未闭合的代码块也能渲染(流式输出中途)", () => {
    const b = parseMarkdown("```sh\nnpm test");
    expect(b[0]).toMatchObject({ type: "code", code: "npm test" });
  });

  it("代码块内的 markdown 标记不被解析", () => {
    const b = parseMarkdown("```\n- not a bullet\n**not bold**\n```");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ type: "code" });
  });

  it("引用与分隔线", () => {
    const b = parseMarkdown("> 注意\n\n---");
    expect(b[0]).toMatchObject({ type: "quote" });
    expect(b[1]).toEqual({ type: "rule" });
  });

  it("GFM 表格保留表头、行与行内样式", () => {
    const b = parseMarkdown([
      "| 文件 | 状态 |",
      "| :--- | ---: |",
      "| `src/app.ts` | **完成** |",
      "| [配置](config/app.json) | 待检查 |",
    ].join("\n"));
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({
      type: "table",
      headers: [[{ text: "文件" }], [{ text: "状态" }]],
      rows: [
        [[{ text: "src/app.ts", code: true }], [{ text: "完成", bold: true }]],
        [[{ text: "配置", href: "config/app.json" }], [{ text: "待检查" }]],
      ],
    });
  });

  it("表格不会按转义竖线或行内代码里的竖线拆列", () => {
    const b = parseMarkdown("左 | 右\n--- | ---\na\\|b | `x|y`");
    expect(b).toEqual([{
      type: "table",
      headers: [[{ text: "左" }], [{ text: "右" }]],
      rows: [[[{ text: "a|b" }], [{ text: "x|y", code: true }]]],
    }]);
  });

  it("行内:代码 / 粗体 / 斜体", () => {
    expect(parseInline("run `npm test` now")).toEqual([
      { text: "run " },
      { text: "npm test", code: true },
      { text: " now" },
    ]);
    expect(parseInline("**重要**提示")).toEqual([
      { text: "重要", bold: true },
      { text: "提示" },
    ]);
    expect(parseInline("这是 *斜* 体")).toEqual([
      { text: "这是 " },
      { text: "斜", italic: true },
      { text: " 体" },
    ]);
  });

  it("保留 agent 的 Markdown 文件链接", () => {
    expect(parseInline("见 [app.ts](src/app.ts:12) 和 [配置](</tmp/My Project/app.json#L3>)")).toEqual([
      { text: "见 " },
      { text: "app.ts", href: "src/app.ts:12" },
      { text: " 和 " },
      { text: "配置", href: "/tmp/My Project/app.json#L3" },
    ]);
  });

  it("行内代码里的星号不当作粗体", () => {
    expect(parseInline("`a ** b`")).toEqual([{ text: "a ** b", code: true }]);
  });

  it("纯文本无标记时原样返回", () => {
    expect(parseInline("just text")).toEqual([{ text: "just text" }]);
  });

  it("真实 agent 输出片段", () => {
    const src = [
      "文件里还明确记录了:",
      "",
      "- 当前 46.0.3 到底证明了什么;",
      "- `red_team_skill` 不得修改。",
      "",
      "```bash",
      "npm run build",
      "```",
    ].join("\n");
    const b = parseMarkdown(src);
    expect(b.map((x) => x.type)).toEqual([
      "paragraph",
      "bullet",
      "bullet",
      "code",
    ]);
    const secondBullet = b[2] as { spans: { text: string; code?: boolean }[] };
    expect(secondBullet.spans[0]).toEqual({ text: "red_team_skill", code: true });
  });
});
