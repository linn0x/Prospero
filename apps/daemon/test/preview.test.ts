import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../src/structured-session.js";

describe("会话列表预览:剥离 Markdown", () => {
  it("去掉标题与列表标记", () => {
    expect(stripMarkdown("# 进展\n- 第一条\n- 第二条")).toBe("进展 第一条 第二条");
    expect(stripMarkdown("1. 甲\n2) 乙")).toBe("甲 乙");
  });

  it("行内代码保留内容,代码块整体丢弃", () => {
    expect(stripMarkdown("可通过 `npm test` 验证")).toBe("可通过 npm test 验证");
    expect(stripMarkdown("步骤:\n```bash\nnpm i\nnpm test\n```\n完成")).toBe("步骤: 完成");
  });

  it("未闭合的代码块也不会泄漏(流式输出中途)", () => {
    expect(stripMarkdown("开始\n```sh\nrm -rf /")).toBe("开始");
  });

  it("粗体/斜体/引用/链接", () => {
    expect(stripMarkdown("**重要**与*次要*")).toBe("重要与次要");
    expect(stripMarkdown("> 注意事项")).toBe("注意事项");
    expect(stripMarkdown("见 [文档](https://example.com)")).toBe("见 文档");
  });

  it("空白折叠为单空格", () => {
    expect(stripMarkdown("a\n\n\nb   c")).toBe("a b c");
  });

  it("纯文本原样返回", () => {
    expect(stripMarkdown("就是一句普通的话")).toBe("就是一句普通的话");
  });
});
