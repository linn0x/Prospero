import { describe, expect, it } from "vitest";
import { validateFileName } from "../src/lib/file-names";

describe("文件名校验", () => {
  it("拒绝空名字、路径分隔符和特殊目录", () => {
    expect(validateFileName("   ")).toContain("不能为空");
    expect(validateFileName("a/b")).toContain("不能含 /");
    expect(validateFileName(".")).toContain("不能使用");
    expect(validateFileName("..")).toContain("不能使用");
  });

  it("重命名必须实际变化且不能覆盖现有条目", () => {
    expect(validateFileName("old", { originalName: "old" })).toContain("相同");
    expect(
      validateFileName("taken", {
        originalName: "old",
        existingNames: ["old", "taken"],
      }),
    ).toContain("已经存在");
  });

  it("允许中文、空格与 macOS 合法文件名", () => {
    expect(validateFileName("项目 计划.md", { existingNames: ["README.md"] })).toBeNull();
  });
});
