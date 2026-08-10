import { describe, expect, it } from "vitest";
import { mathMl } from "../src/lib/math";

describe("LaTeX → MathML", () => {
  it("离线渲染上下标、分式与中文文本", () => {
    const output = mathMl("\\tau_\\text{执行器} > \\frac{F}{r}", true);
    expect(output).toContain("<math");
    expect(output).toContain("<mfrac>");
    expect(output).toContain("执行器");
  });

  it("不信任可加载外部资源的 LaTeX 命令", () => {
    const output = mathMl("\\includegraphics{https://example.com/x.png}", false);
    expect(output).toContain("\\includegraphics");
    expect(output).not.toContain("<img");
    expect(output).not.toContain("href=");
  });
});
