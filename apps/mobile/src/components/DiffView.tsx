import { memo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { FileDiff } from "@prospero/protocol";
import { numberDiffLines, type NumberedDiffLine } from "@/lib/diff-lines";
import { color, MONOSPACE_FONT } from "@/lib/theme";

/**
 * 改动查看。手机屏窄,所以:
 * - 不做左右分栏,只做单栏 +/- 着色;
 * - 默认只展开前若干行,长 diff 需点开(审批时一眼看不完反而干扰决策);
 * - 横向可滚动,不折行 —— 折行会让缩进和 diff 结构彻底乱掉。
 */
const COLLAPSED_LINES = 14;

export const DiffView = memo(function DiffView({ diff }: { diff: FileDiff }) {
  const [expanded, setExpanded] = useState(false);
  const lines = diff.patch.length > 0 ? diff.patch.split("\n") : [];
  const numbered = numberDiffLines(lines);
  const shown = expanded ? numbered : numbered.slice(0, COLLAPSED_LINES);
  const hidden = lines.length - shown.length;
  const fileName = diff.path.split("/").pop() ?? diff.path;

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.file} numberOfLines={1}>
          {fileName}
        </Text>
        <Text style={styles.add}>+{diff.additions}</Text>
        <Text style={styles.del}>−{diff.deletions}</Text>
      </View>
      {lines.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            {shown.map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </View>
        </ScrollView>
      )}
      {(hidden > 0 || expanded) && (
        <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={6}>
          <Text style={styles.more}>
            {expanded ? "收起" : `展开其余 ${String(hidden)} 行`}
          </Text>
        </Pressable>
      )}
      {diff.truncated === true && <Text style={styles.truncated}>改动过大,已截断</Text>}
    </View>
  );
});

function DiffLine({ line }: { line: NumberedDiffLine }) {
  if (line.line === "@@") {
    return (
      <View style={styles.gapRow}>
        <Text style={styles.gapText}>⋯</Text>
      </View>
    );
  }
  if (line.line.startsWith("@@")) {
    return (
      <View style={styles.hunkRow}>
        <Text style={styles.hunkText}>{line.line}</Text>
      </View>
    );
  }
  const sign = line.line.charAt(0);
  const body = line.line.slice(1);
  const isAdd = sign === "+";
  const isDel = sign === "-";
  return (
    <View style={[styles.row, isAdd && styles.rowAdd, isDel && styles.rowDel]}>
      <Text style={styles.lineNumber}>{line.oldLine ?? ""}</Text>
      <Text style={styles.lineNumber}>{line.newLine ?? ""}</Text>
      <Text style={[styles.sign, isAdd && styles.signAdd, isDel && styles.signDel]}>
        {isAdd ? "+" : isDel ? "−" : " "}
      </Text>
      <Text style={[styles.code, isAdd && styles.codeAdd, isDel && styles.codeDel]}>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: color.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: color.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: color.surfaceRaised,
  },
  file: { color: color.text, fontSize: 12, fontWeight: "600", flex: 1 },
  add: { color: color.success, fontSize: 11, fontVariant: ["tabular-nums"] },
  del: { color: color.danger, fontSize: 11, fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", paddingHorizontal: 8, minWidth: "100%" },
  rowAdd: { backgroundColor: color.successBg },
  rowDel: { backgroundColor: color.dangerBg },
  sign: { fontFamily: MONOSPACE_FONT, fontSize: 11, color: color.textFaint, width: 12 },
  signAdd: { color: color.success },
  signDel: { color: color.danger },
  code: { fontFamily: MONOSPACE_FONT, fontSize: 11, lineHeight: 17, color: color.textDim },
  codeAdd: { color: color.success },
  codeDel: { color: color.danger },
  lineNumber: {
    width: 32,
    paddingRight: 5,
    color: color.textFaint,
    fontFamily: MONOSPACE_FONT,
    fontSize: 10,
    lineHeight: 17,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  hunkRow: { paddingHorizontal: 8, paddingVertical: 3, backgroundColor: color.accentBg, minWidth: "100%" },
  hunkText: { color: color.accent, fontFamily: MONOSPACE_FONT, fontSize: 10.5, lineHeight: 16 },
  gapRow: { paddingHorizontal: 8, paddingVertical: 2, backgroundColor: color.surfaceRaised },
  gapText: { fontFamily: MONOSPACE_FONT, fontSize: 11, color: color.textFaint },
  more: {
    color: color.accent,
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  truncated: {
    color: color.warn,
    fontSize: 11,
    paddingHorizontal: 10,
    paddingBottom: 7,
  },
});
