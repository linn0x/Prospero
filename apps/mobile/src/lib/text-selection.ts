export interface TextSelectionRange {
  start: number;
  end: number;
}

/** React Native 的选区索引与 JS 字符串同为 UTF-16 offset，可直接安全截取。 */
export function textInSelection(source: string, selection: TextSelectionRange): string {
  const start = Math.max(0, Math.min(source.length, Math.min(selection.start, selection.end)));
  const end = Math.max(start, Math.min(source.length, Math.max(selection.start, selection.end)));
  return source.slice(start, end);
}
