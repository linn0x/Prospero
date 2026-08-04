/**
 * 极简 Markdown 解析:够渲染 agent 输出即可(标题/列表/代码块/行内样式)。
 *
 * 为什么不用现成库:RN 的 markdown 库大多依赖 WebView 或体积很大,而 agent 输出
 * 的 Markdown 子集很窄。这里只解析实际会出现的结构,纯函数便于测试。
 */

export interface InlineSpan {
  text: string;
  code?: boolean;
  bold?: boolean;
  italic?: boolean;
}

export type MdBlock =
  | { type: "paragraph"; spans: InlineSpan[] }
  | { type: "heading"; level: number; spans: InlineSpan[] }
  | { type: "bullet"; spans: InlineSpan[]; ordered?: string }
  | { type: "code"; lang: string; code: string }
  | { type: "quote"; spans: InlineSpan[] }
  | { type: "rule" };

/** 行内解析:`code`、**bold**、*italic*(code 优先,内部不再解析) */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  // 一次扫描三种标记,避免嵌套歧义
  const re = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|__([^_]+?)__/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    if (m[2] !== undefined) spans.push({ text: m[2], code: true });
    else if (m[3] !== undefined) spans.push({ text: m[3], bold: true });
    else if (m[4] !== undefined) spans.push({ text: m[4], italic: true });
    else if (m[5] !== undefined) spans.push({ text: m[5], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length > 0 ? spans : [{ text }];
}

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.split("\n");
  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // 代码块(流式输出中可能尚未闭合,到文末即止)
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // 跳过结束栅栏(若存在)
      blocks.push({ type: "code", lang, code: body.join("\n") });
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        spans: parseInline(heading[2]!),
      });
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line.trim()) && line.trim().length >= 3) {
      flushParagraph();
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: "bullet", spans: parseInline(bullet[1]!) });
      i++;
      continue;
    }

    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      blocks.push({
        type: "bullet",
        ordered: ordered[1]!,
        spans: parseInline(ordered[2]!),
      });
      i++;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ type: "quote", spans: parseInline(quote[1]!) });
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}
