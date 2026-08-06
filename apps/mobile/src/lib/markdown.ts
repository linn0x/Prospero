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
  /** Markdown `[label](target)`；渲染层只会激活受项目根约束的文件 target。 */
  href?: string;
}

export type MdBlock =
  | { type: "paragraph"; spans: InlineSpan[] }
  | { type: "heading"; level: number; spans: InlineSpan[] }
  | { type: "bullet"; spans: InlineSpan[]; ordered?: string }
  | { type: "code"; lang: string; code: string }
  | { type: "quote"; spans: InlineSpan[] }
  | { type: "table"; headers: InlineSpan[][]; rows: InlineSpan[][][] }
  | { type: "rule" };

/** GFM 表格行；反斜线转义的竖线与行内代码中的竖线都不切列。 */
function tableCells(line: string): string[] {
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\" && source[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (char === "`") {
      inCode = !inCode;
      cell += char;
    } else if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableDivider(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell)) ? cells : null;
}

/** 行内解析:链接、`code`、**bold**、*italic*(链接/code 优先,内部不再解析) */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  // 一次扫描所有标记,避免先解析粗体后破坏链接位置。带空格的 href 必须用 <…>。
  const re = /\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^\s)\n]+))(?:\s+"[^"\n]*")?\)|(`+)([^`]+?)\4|\*\*([^*]+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|__([^_]+?)__/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ text: m[1], href: m[2] ?? m[3] ?? "" });
    else if (m[5] !== undefined) spans.push({ text: m[5], code: true });
    else if (m[6] !== undefined) spans.push({ text: m[6], bold: true });
    else if (m[7] !== undefined) spans.push({ text: m[7], italic: true });
    else if (m[8] !== undefined) spans.push({ text: m[8], bold: true });
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

    // GFM 表格：当前行是表头，下一行每列必须是 --- / :---:。
    const headerCells = line.includes("|") ? tableCells(line) : [];
    const divider = i + 1 < lines.length ? tableDivider(lines[i + 1]!) : null;
    if (divider && headerCells.length === divider.length) {
      flushParagraph();
      i += 2;
      const rows: InlineSpan[][][] = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]!) && lines[i]!.includes("|")) {
        const cells = tableCells(lines[i]!);
        rows.push(
          Array.from({ length: headerCells.length }, (_, index) =>
            parseInline(cells[index] ?? ""),
          ),
        );
        i++;
      }
      blocks.push({
        type: "table",
        headers: headerCells.map(parseInline),
        rows,
      });
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
