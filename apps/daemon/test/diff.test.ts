import { describe, expect, it } from "vitest";
import {
  diffFromToolInput,
  fromUnifiedPatch,
  makeCreateDiff,
  makeDiff,
} from "../src/adapters/diff.js";

describe("diff 生成", () => {
  it("单行修改:一增一删,上下文保留", () => {
    const d = makeDiff("a.ts", "const a = 1;\nconst b = 2;\n", "const a = 1;\nconst b = 3;\n");
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.patch).toContain(" const a = 1;");
    expect(d.patch).toContain("-const b = 2;");
    expect(d.patch).toContain("+const b = 3;");
  });

  it("新建文件:全部为新增", () => {
    const d = makeCreateDiff("new.txt", "hello\nworld\n");
    expect(d.deletions).toBe(0);
    expect(d.additions).toBe(2);
    expect(d.patch.split("\n").every((l) => l.startsWith("+"))).toBe(true);
  });

  it("纯新增不产生删除行", () => {
    const d = makeDiff("a.txt", "one\ntwo\n", "one\ntwo\nthree\n");
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(0);
  });

  it("纯删除不产生新增行", () => {
    const d = makeDiff("a.txt", "one\ntwo\nthree\n", "one\nthree\n");
    expect(d.deletions).toBe(1);
    expect(d.additions).toBe(0);
  });

  it("无改动时 patch 为空", () => {
    const d = makeDiff("a.txt", "same\n", "same\n");
    expect(d.additions + d.deletions).toBe(0);
  });

  it("远离改动的大段上下文被折叠为 @@", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join("\n");
    const after = before.replace("line 20", "line twenty");
    const d = makeDiff("big.txt", before, after);
    expect(d.patch).toContain("@@");
    // 只保留改动附近数行,不是整份文件
    expect(d.patch.split("\n").length).toBeLessThan(20);
  });

  it("超大 patch 被截断并标记", () => {
    const before = "";
    const after = Array.from({ length: 5000 }, (_, i) => `line ${String(i)}`).join("\n");
    const d = makeDiff("huge.txt", before, after);
    expect(d.truncated).toBe(true);
    expect(d.patch.length).toBeLessThanOrEqual(8000);
  });

  it("超大文件对比不卡死(退化为整体替换)", () => {
    const before = Array.from({ length: 2500 }, (_, i) => `a${String(i)}`).join("\n");
    const after = Array.from({ length: 2500 }, (_, i) => `b${String(i)}`).join("\n");
    const started = Date.now();
    const d = makeDiff("x.txt", before, after);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(d.additions).toBeGreaterThan(0);
  });
});

describe("从工具参数提取 diff", () => {
  it("Write:整份内容视为新建", () => {
    const d = diffFromToolInput("Write", { file_path: "/tmp/x.ts", content: "a\nb\n" });
    expect(d).not.toBeNull();
    expect(d!.path).toBe("/tmp/x.ts");
    expect(d!.additions).toBe(2);
  });

  it("Edit:old/new 生成改动", () => {
    const d = diffFromToolInput("Edit", {
      file_path: "/tmp/x.ts",
      old_string: "foo",
      new_string: "bar",
    });
    expect(d!.additions).toBe(1);
    expect(d!.deletions).toBe(1);
  });

  it("MultiEdit:多段改动合并计数", () => {
    const d = diffFromToolInput("MultiEdit", {
      file_path: "/tmp/x.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
      ],
    });
    expect(d!.additions).toBe(2);
    expect(d!.deletions).toBe(2);
  });

  it("非文件类工具返回 null", () => {
    expect(diffFromToolInput("Bash", { command: "ls" })).toBeNull();
    expect(diffFromToolInput("Read", { file_path: "/tmp/x" })).toBeNull();
  });
});

describe("解析已有 unified patch(Codex)", () => {
  it("统计增删并去掉文件头", () => {
    const d = fromUnifiedPatch(
      "src/a.ts",
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const x = 1;\n-const y = 2;\n+const y = 3;\n",
    );
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.patch).not.toContain("--- a/");
    expect(d.patch).not.toContain("+++ b/");
  });
});
