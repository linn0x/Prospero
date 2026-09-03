import { beforeEach, describe, expect, it } from "vitest";
import {
  parseMarkdown,
  parseMarkdownCached,
  parseMarkdownStream,
  resetMarkdownCache,
  type MarkdownStream,
} from "../src/lib/markdown";

/** 按字符逐步喂入,模拟流式输出;返回最终状态。 */
function stream(source: string, step = 1): MarkdownStream {
  let state: MarkdownStream | null = null;
  for (let i = step; i < source.length; i += step) {
    state = parseMarkdownStream(source.slice(0, i), state);
  }
  return parseMarkdownStream(source, state);
}

const SAMPLES: Record<string, string> = {
  段落与标题: "# 标题\n\n第一段第一行\n第一段第二行\n\n第二段\n",
  列表与引用: "- 一\n- 二\n\n> 引用\n\n1. 三\n2) 四\n",
  围栏代码块: "前言\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n收尾\n",
  未闭合代码块: "开头\n\n```py\nprint(1)\n\nprint(2)\n",
  展示公式: "前\n\n$$\na^2 + b^2\n\n= c^2\n$$\n\n后\n",
  行内与链接: "见 [文档](./a.md) 与 `code`,以及 **粗** 和 $x+1$。\n\n下一段\n",
  表格: "说明\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n尾\n",
  分隔线与图片: "上\n\n---\n\n![图](./x.png)\n\n下\n",
  空行密集: "a\n\n\n\nb\n\n\n",
  无空行长文: "行一\n行二\n行三\n行四\n行五\n",
};

describe("Markdown 流式增量解析", () => {
  for (const [name, source] of Object.entries(SAMPLES)) {
    it(`逐字符流入与整段解析等价:${name}`, () => {
      expect(stream(source).blocks).toEqual(parseMarkdown(source));
    });

    it(`分块流入与整段解析等价:${name}`, () => {
      expect(stream(source, 7).blocks).toEqual(parseMarkdown(source));
    });

    it(`任意前缀都与该前缀的整段解析等价:${name}`, () => {
      let state: MarkdownStream | null = null;
      for (let i = 0; i <= source.length; i++) {
        const prefix = source.slice(0, i);
        state = parseMarkdownStream(prefix, state);
        expect(state.blocks).toEqual(parseMarkdown(prefix));
      }
    });
  }

  it("源文本没变时复用同一个对象", () => {
    const first = parseMarkdownStream("hello\n\nworld", null);
    expect(parseMarkdownStream("hello\n\nworld", first)).toBe(first);
  });

  it("内容被改写而非追加时整段重来", () => {
    const first = parseMarkdownStream("原来的第一段\n\n第二段", null);
    const rewritten = parseMarkdownStream("换掉的第一段\n\n第二段", first);
    expect(rewritten.blocks).toEqual(parseMarkdown("换掉的第一段\n\n第二段"));
  });

  it("内容被截短时整段重来", () => {
    const first = parseMarkdownStream("一\n\n二\n\n三", null);
    const shorter = parseMarkdownStream("一\n\n二", first);
    expect(shorter.blocks).toEqual(parseMarkdown("一\n\n二"));
  });

  it("空行之后定稿,尾部之外的块不再重解析", () => {
    const state = parseMarkdownStream("第一段\n\n第二段还在写", null);
    expect(state.settled).toEqual(parseMarkdown("第一段\n"));
    expect(state.boundary).toBe("第一段\n\n".length);
  });

  it("围栏代码块内部的空行不是安全重启点", () => {
    const state = parseMarkdownStream("```ts\nconst a = 1;\n\nconst b = 2;\n", null);
    expect(state.boundary).toBe(0);
    expect(state.inFence).toBe(true);
  });

  it("展示公式内部的空行不是安全重启点", () => {
    const state = parseMarkdownStream("$$\na\n\nb\n", null);
    expect(state.boundary).toBe(0);
    expect(state.mathClose).toBe("$$");
  });

  it("同一行闭合的展示公式不会让扫描停在公式里", () => {
    const state = parseMarkdownStream("$$a+b$$\n\n后续\n", null);
    expect(state.mathClose).toBe(null);
    expect(state.boundary).toBeGreaterThan(0);
  });

  it("定稿之后尾部只剩未闭合部分", () => {
    const source = "一段\n\n二段\n\n```ts\nconst a = 1;\n";
    const state = parseMarkdownStream(source, null);
    expect(state.boundary).toBe("一段\n\n二段\n\n".length);
    expect(state.blocks).toEqual(parseMarkdown(source));
  });
});

describe("Markdown 流式解析缓存", () => {
  beforeEach(() => {
    resetMarkdownCache();
  });

  it("逐步追加时结果与整段解析一致", () => {
    const source = "一段\n\n```ts\nconst a = 1;\n```\n\n二段\n";
    for (let i = 1; i <= source.length; i++) {
      const prefix = source.slice(0, i);
      expect(parseMarkdownCached(prefix)).toEqual(parseMarkdown(prefix));
    }
  });

  it("定稿的块在后续追加中保持同一个对象引用", () => {
    const first = parseMarkdownCached("第一段\n\n第二段开始");
    const second = parseMarkdownCached("第一段\n\n第二段开始写完了");
    expect(second[0]).toBe(first[0]);
  });

  it("两个气泡交替追加互不干扰", () => {
    const a = "甲的第一段\n\n甲的第二段";
    const b = "乙的第一段\n\n乙的第二段";
    for (let i = 1; i <= Math.max(a.length, b.length); i++) {
      if (i <= a.length) expect(parseMarkdownCached(a.slice(0, i))).toEqual(parseMarkdown(a.slice(0, i)));
      if (i <= b.length) expect(parseMarkdownCached(b.slice(0, i))).toEqual(parseMarkdown(b.slice(0, i)));
    }
  });

  it("缓存被挤掉之后仍然给出正确结果", () => {
    for (let i = 0; i < 20; i++) parseMarkdownCached(`占位 ${String(i)}\n\n内容`);
    const source = "一\n\n二\n\n三";
    expect(parseMarkdownCached(source)).toEqual(parseMarkdown(source));
  });
});
