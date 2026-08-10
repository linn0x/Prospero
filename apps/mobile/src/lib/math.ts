import katex from "katex";

/** 把不可信的 Agent LaTeX 转成不含脚本/外部资源的 MathML。 */
export function mathMl(expression: string, display: boolean): string {
  return katex.renderToString(expression, {
    displayMode: display,
    output: "mathml",
    throwOnError: true,
    strict: "ignore",
    trust: false,
    maxExpand: 1_000,
    maxSize: 20,
  });
}
