import { describe, expect, it } from "vitest";
import { textInSelection } from "../src/lib/text-selection";

describe("回复选区复制", () => {
  it("只返回用户圈选的范围", () => {
    expect(textInSelection("先检查测试，再发布。", { start: 2, end: 6 })).toBe("查测试，");
  });

  it("兼容反向拖动并把越界索引收进正文", () => {
    expect(textInSelection("abcdef", { start: 99, end: 2 })).toBe("cdef");
    expect(textInSelection("abcdef", { start: -5, end: 2 })).toBe("ab");
  });
});
