import { memo, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { CodeBlock } from "@/components/CodeBlock";
import {
  resolveProjectFileReference,
  type ProjectFileReference,
} from "@/lib/file-references";
import { parseMarkdown, type InlineSpan, type MdBlock } from "@/lib/markdown";
import { MONOSPACE_FONT } from "@/lib/theme";

/** agent 输出的 Markdown 渲染(标题/列表/引用/行内代码/代码块) */
export const Markdown = memo(function Markdown({
  source,
  projectRoot,
  onOpenFile,
}: {
  source: string;
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => (
        <Block
          key={i}
          block={b}
          projectRoot={projectRoot}
          onOpenFile={onOpenFile}
        />
      ))}
    </View>
  );
});

function Block({
  block,
  projectRoot,
  onOpenFile,
}: {
  block: MdBlock;
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
}) {
  switch (block.type) {
    case "heading":
      return (
        <Text style={[styles.heading, block.level >= 3 && styles.headingSmall]}>
          <Spans spans={block.spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
        </Text>
      );
    case "bullet":
      return (
        <View style={styles.bulletRow}>
          <Text style={styles.bulletMark}>{block.ordered ? `${block.ordered}.` : "•"}</Text>
          <Text style={styles.body}>
            <Spans spans={block.spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
          </Text>
        </View>
      );
    case "code":
      return <CodeBlock code={block.code} lang={block.lang} />;
    case "quote":
      return (
        <View style={styles.quote}>
          <Text style={styles.quoteText}>
            <Spans spans={block.spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
          </Text>
        </View>
      );
    case "rule":
      return <View style={styles.rule} />;
    case "table":
      return (
        <TableBlock
          headers={block.headers}
          rows={block.rows}
          projectRoot={projectRoot}
          onOpenFile={onOpenFile}
        />
      );
    case "paragraph":
      return (
        <Text style={styles.body}>
          <Spans spans={block.spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
        </Text>
      );
  }
}

function TableBlock({
  headers,
  rows,
  projectRoot,
  onOpenFile,
}: {
  headers: InlineSpan[][];
  rows: InlineSpan[][][];
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
}) {
  const renderCell = (spans: InlineSpan[], key: string, header = false) => (
    <View key={key} style={[styles.tableCell, header && styles.tableHeaderCell]}>
      <Text style={header ? styles.tableHeaderText : styles.tableText} selectable>
        <Spans spans={spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
      </Text>
    </View>
  );

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      style={styles.tableScroll}
      contentContainerStyle={styles.tableScrollContent}
      accessibilityRole="summary"
      accessibilityLabel={`${String(headers.length)} 列、${String(rows.length)} 行的表格`}
    >
      <View style={styles.table}>
        <View style={[styles.tableRow, styles.tableHeaderRow]}>
          {headers.map((cell, index) => renderCell(cell, `h:${String(index)}`, true))}
        </View>
        {rows.map((row, rowIndex) => (
          <View
            key={`r:${String(rowIndex)}`}
            style={[styles.tableRow, rowIndex % 2 === 1 && styles.tableAlternateRow]}
          >
            {headers.map((_, columnIndex) =>
              renderCell(row[columnIndex] ?? [{ text: "" }], `c:${String(columnIndex)}`),
            )}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Spans({
  spans,
  projectRoot,
  onOpenFile,
}: {
  spans: InlineSpan[];
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
}) {
  return (
    <>
      {spans.map((s, i) => {
        const reference =
          projectRoot && onOpenFile && (s.href !== undefined || s.code === true)
            ? resolveProjectFileReference(s.href ?? s.text, projectRoot, s.href !== undefined)
            : null;
        return (
          <Text
            key={i}
            style={[
              s.code === true && styles.inlineCode,
              s.bold === true && styles.bold,
              s.italic === true && styles.italic,
              reference !== null && styles.fileReference,
            ]}
            onPress={reference ? () => onOpenFile?.(reference) : undefined}
            accessibilityRole={reference ? "link" : undefined}
            accessibilityHint={reference ? "打开项目文件预览" : undefined}
          >
            {s.text}{reference ? " ↗" : ""}
          </Text>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  body: { color: "#e8e8ee", fontSize: 15, lineHeight: 22 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  heading: { color: "#fff", fontSize: 17, fontWeight: "700", lineHeight: 24, marginTop: 2 },
  headingSmall: { fontSize: 15 },
  bulletRow: { flexDirection: "row", gap: 8, paddingLeft: 2 },
  bulletMark: { color: "#7aa2f7", fontSize: 15, lineHeight: 22, minWidth: 14 },
  inlineCode: {
    fontFamily: MONOSPACE_FONT,
    fontSize: 13,
    color: "#9ad0a5",
    backgroundColor: "#1a1f1b",
  },
  fileReference: {
    color: "#8EB2FF",
    backgroundColor: "#17203A",
    textDecorationLine: "underline",
    textDecorationColor: "#526FAE",
  },
  quote: { borderLeftWidth: 3, borderLeftColor: "#3a3a46", paddingLeft: 10 },
  quoteText: { color: "#a8a8b4", fontSize: 14, lineHeight: 21 },
  rule: { height: 1, backgroundColor: "#26262e", marginVertical: 4 },
  tableScroll: {
    maxWidth: "100%",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#363642",
    borderRadius: 9,
  },
  tableScrollContent: { minWidth: "100%" },
  table: { minWidth: "100%" },
  tableRow: { flexDirection: "row", backgroundColor: "#15151B" },
  tableHeaderRow: { backgroundColor: "#20202A" },
  tableAlternateRow: { backgroundColor: "#1A1A21" },
  tableCell: {
    width: 148,
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "#363642",
  },
  tableHeaderCell: { minHeight: 40 },
  tableHeaderText: { color: "#F3F3F8", fontSize: 12.5, lineHeight: 18, fontWeight: "700" },
  tableText: { color: "#D8D8E1", fontSize: 12.5, lineHeight: 18 },
});
