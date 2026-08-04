import { memo, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CodeBlock } from "@/components/CodeBlock";
import { parseMarkdown, type InlineSpan, type MdBlock } from "@/lib/markdown";

/** agent 输出的 Markdown 渲染(标题/列表/引用/行内代码/代码块) */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </View>
  );
});

function Block({ block }: { block: MdBlock }) {
  switch (block.type) {
    case "heading":
      return (
        <Text style={[styles.heading, block.level >= 3 && styles.headingSmall]}>
          <Spans spans={block.spans} />
        </Text>
      );
    case "bullet":
      return (
        <View style={styles.bulletRow}>
          <Text style={styles.bulletMark}>{block.ordered ? `${block.ordered}.` : "•"}</Text>
          <Text style={styles.body}>
            <Spans spans={block.spans} />
          </Text>
        </View>
      );
    case "code":
      return <CodeBlock code={block.code} lang={block.lang} />;
    case "quote":
      return (
        <View style={styles.quote}>
          <Text style={styles.quoteText}>
            <Spans spans={block.spans} />
          </Text>
        </View>
      );
    case "rule":
      return <View style={styles.rule} />;
    case "paragraph":
      return (
        <Text style={styles.body}>
          <Spans spans={block.spans} />
        </Text>
      );
  }
}

function Spans({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <Text
          key={i}
          style={[
            s.code === true && styles.inlineCode,
            s.bold === true && styles.bold,
            s.italic === true && styles.italic,
          ]}
        >
          {s.text}
        </Text>
      ))}
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
    fontFamily: "Menlo",
    fontSize: 13,
    color: "#9ad0a5",
    backgroundColor: "#1a1f1b",
  },
  quote: { borderLeftWidth: 3, borderLeftColor: "#3a3a46", paddingLeft: 10 },
  quoteText: { color: "#a8a8b4", fontSize: 14, lineHeight: 21 },
  rule: { height: 1, backgroundColor: "#26262e", marginVertical: 4 },
});
