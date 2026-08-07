import { describe, expect, it } from "vitest";
import {
  activeComposerToken,
  replaceComposerToken,
} from "../src/lib/composer-completion";
import { commandsFor } from "../src/lib/slash-commands";

describe("对话输入补全", () => {
  it("识别任意位置的 @文件 与 $Skill", () => {
    expect(activeComposerToken("看看 @src/app", 11)).toMatchObject({
      kind: "file",
      query: "src/app",
      start: 3,
    });
    expect(activeComposerToken("用 $openai-do")).toMatchObject({
      kind: "skill",
      query: "openai-do",
    });
    expect(activeComposerToken("mail@example.com")).toBeNull();
  });

  it("/skills 是所有 agent 的 Skill 浏览入口", () => {
    expect(activeComposerToken("/ski")).toMatchObject({ kind: "command", query: "ski" });
    expect(activeComposerToken("/skills docs")).toEqual({
      kind: "skill",
      start: 0,
      end: 12,
      query: "docs",
      trigger: "/skills",
    });
    for (const agent of ["codex", "claude", "opencode", "grok"] as const) {
      expect(commandsFor(agent).some((command) => command.cmd === "/skills")).toBe(true);
    }
  });

  it("插入相对路径并保留光标后的正文", () => {
    const text = "查看 @sr 然后修复";
    const token = activeComposerToken(text, 6)!;
    const result = replaceComposerToken(text, token, {
      kind: "file",
      value: "src/index.ts",
      label: "index.ts",
    });
    expect(result.text).toBe("查看 @src/index.ts 然后修复");
    expect(result.cursor).toBe("查看 @src/index.ts".length);
  });

  it("带空格的文件会加引号，目录则继续保持补全", () => {
    const file = replaceComposerToken("@my", activeComposerToken("@my")!, {
      kind: "file",
      value: "My Project/read me.md",
      label: "read me.md",
    });
    expect(file.text).toBe('@"My Project/read me.md" ');

    const directory = replaceComposerToken("@sr", activeComposerToken("@sr")!, {
      kind: "file",
      value: "src/",
      label: "src",
    });
    expect(directory.text).toBe("@src/");
  });

  it("Skill 用官方 $name 形式插入", () => {
    const result = replaceComposerToken("请用 $doc", activeComposerToken("请用 $doc")!, {
      kind: "skill",
      value: "openai-docs",
      label: "openai-docs",
    });
    expect(result.text).toBe("请用 $openai-docs ");
  });
});
