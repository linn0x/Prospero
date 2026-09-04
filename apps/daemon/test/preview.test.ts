import { describe, expect, it } from "vitest";
import {
  latestReplyPreview,
  stripMarkdown,
  StructuredSession,
  titleFor,
  titleFromUserPrompt,
} from "../src/structured-session.js";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";

function idleAdapter(): AgentAdapter {
  return {
    start: async (_context: AdapterContext) => {},
    send: async () => {},
    interrupt: async () => {},
    dispose: async () => {},
  };
}

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

  it("长回复保留开头并只在末尾省略", () => {
    const source = `开头说明 ${"中间内容 ".repeat(40)}最终结论：修复已经完成`;
    const preview = latestReplyPreview(source, 60);
    expect(preview).toMatch(/…$/);
    expect(preview).not.toMatch(/^…/);
    expect(preview).toContain("开头说明");
    expect(preview).not.toContain("最终结论：修复已经完成");
    expect(preview.length).toBeLessThanOrEqual(60);
  });

  it("短回复保持完整且继续剥离 Markdown", () => {
    expect(latestReplyPreview("**完成**：见 `src/app.ts`", 60)).toBe("完成：见 src/app.ts");
  });

  it("会话标题来自用户提问，而不是助手回复预览", () => {
    expect(titleFromUserPrompt("## 请修复\n**DeepSeek** 的会话标题")).toBe(
      "请修复 DeepSeek 的会话标题",
    );
    expect(titleFromUserPrompt("用户问题很长", 4)).toBe("用户问题");
  });

  it("新会话使用第一条用户提问，恢复的原生标题保持不变", async () => {
    const cwd = process.cwd();
    const fresh = new StructuredSession({
      id: "fresh-title",
      agent: "deepseek",
      title: titleFor("deepseek", cwd),
      cwd,
      adapter: idleAdapter(),
    });
    await fresh.start();
    await fresh.send("为什么会话标题显示了助手最后一段答复？");
    expect(fresh.info().title).toBe("为什么会话标题显示了助手最后一段答复？");
    await fresh.dispose();

    const resumed = new StructuredSession({
      id: "resumed-title",
      agent: "deepseek",
      title: "原本的 DeepSeek 会话标题",
      cwd,
      adapter: idleAdapter(),
    });
    await resumed.start();
    await resumed.send("后续提问不应覆盖标题");
    expect(resumed.info().title).toBe("原本的 DeepSeek 会话标题");
    await resumed.dispose();
  });
});
