export interface NumberedDiffLine {
  line: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * 把标准 unified diff 的 hunk 坐标接进窄屏 gutter。
 * 简化 patch 没有 hunk 时仍照常展示，只是不虚构行号。
 */
export function numberDiffLines(lines: string[]): NumberedDiffLine[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return lines.map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { line };
    }
    const numbered: NumberedDiffLine = { line };
    if (line.startsWith("-")) {
      if (oldLine !== undefined) numbered.oldLine = oldLine++;
    } else if (line.startsWith("+")) {
      if (newLine !== undefined) numbered.newLine = newLine++;
    } else if (!line.startsWith("\\")) {
      if (oldLine !== undefined) numbered.oldLine = oldLine++;
      if (newLine !== undefined) numbered.newLine = newLine++;
    }
    return numbered;
  });
}
