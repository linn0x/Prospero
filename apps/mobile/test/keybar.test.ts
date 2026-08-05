import { describe, expect, it } from "vitest";
import { ctrlCode } from "../src/lib/keys";

describe("Ctrl 组合键", () => {
  it("字母映射到对应控制码", () => {
    expect(ctrlCode("a")).toBe("\x01");
    expect(ctrlCode("c")).toBe("\x03"); // ^C 中断
    expect(ctrlCode("d")).toBe("\x04"); // ^D EOF
    expect(ctrlCode("r")).toBe("\x12"); // ^R 反查历史
    expect(ctrlCode("z")).toBe("\x1a");
  });

  it("大小写等价 —— 工具条上显示什么都行", () => {
    expect(ctrlCode("A")).toBe(ctrlCode("a"));
    expect(ctrlCode("R")).toBe("\x12");
  });

  it("非字母键原样返回,不被吞也不乱发", () => {
    // ctrl 亮着时点方向键,应该还是方向键
    expect(ctrlCode("\x1b[A")).toBe("\x1b[A");
    expect(ctrlCode("/")).toBe("/");
    expect(ctrlCode("-")).toBe("-");
    expect(ctrlCode("\r")).toBe("\r");
  });

  it("边界:紧邻字母区间的字符不参与映射", () => {
    // '`' 是 'a' 的前一个,'{' 是 'z' 的后一个 —— 都不该被当成字母
    expect(ctrlCode("`")).toBe("`");
    expect(ctrlCode("{")).toBe("{");
  });
});
