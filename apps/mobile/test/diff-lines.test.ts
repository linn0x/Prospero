import { describe, expect, it } from "vitest";
import { numberDiffLines } from "../src/lib/diff-lines";

describe("numberDiffLines", () => {
  it("从 unified diff hunk 推导新增、删除与上下文的行号", () => {
    expect(numberDiffLines([
      "@@ -8,3 +8,4 @@ export function run() {",
      " const before = true;",
      "-const oldValue = 1;",
      "+const nextValue = 2;",
      "+const extra = 3;",
      " return nextValue;",
      "\\ No newline at end of file",
    ])).toEqual([
      { line: "@@ -8,3 +8,4 @@ export function run() {" },
      { line: " const before = true;", oldLine: 8, newLine: 8 },
      { line: "-const oldValue = 1;", oldLine: 9 },
      { line: "+const nextValue = 2;", newLine: 9 },
      { line: "+const extra = 3;", newLine: 10 },
      { line: " return nextValue;", oldLine: 10, newLine: 11 },
      { line: "\\ No newline at end of file" },
    ]);
  });

  it("简化 patch 没有 hunk 时不编造行号", () => {
    expect(numberDiffLines(["-old", "+new"])) .toEqual([
      { line: "-old" },
      { line: "+new" },
    ]);
  });
});
