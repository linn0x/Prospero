import { memo, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CodeBlock } from "@/components/CodeBlock";
import { Icon } from "@/components/Icon";
import { MathFormula, MathSpans } from "@/components/MathView";
import {
  resolveProjectFileReference,
  type ProjectFileReference,
} from "@/lib/file-references";
import { parseMarkdownCached, type InlineSpan, type MdBlock } from "@/lib/markdown";
import { color, MONOSPACE_FONT } from "@/lib/theme";

export type ProjectImageLoader = (reference: ProjectFileReference) => Promise<string>;

/** agent 输出的 Markdown 渲染(标题/列表/引用/行内代码/代码块) */
export const Markdown = memo(function Markdown({
  source,
  projectRoot,
  onOpenFile,
  loadProjectImage,
}: {
  source: string;
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
  loadProjectImage?: ProjectImageLoader;
}) {
  // 流式期间 source 每帧变长,整段重解析的总开销随长度平方增长。改成只解析仍在
  // 增长的尾部,已定稿的块连同它们的对象引用一起复用。
  const blocks = useMemo(() => parseMarkdownCached(source), [source]);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => (
        <Block
          key={i}
          block={b}
          projectRoot={projectRoot}
          onOpenFile={onOpenFile}
          loadProjectImage={loadProjectImage}
        />
      ))}
    </View>
  );
});

// 增量解析让定稿的块保持同一个对象引用,memo 的浅比较据此整段跳过重渲染;
// 少了这层,流式期间前面所有块仍会跟着每帧重新渲染,缓存解析结果就白做了。
const Block = memo(function Block({
  block,
  projectRoot,
  onOpenFile,
  loadProjectImage,
}: {
  block: MdBlock;
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
  loadProjectImage?: ProjectImageLoader;
}) {
  switch (block.type) {
    case "heading":
      if (hasMath(block.spans)) {
        return (
          <View style={styles.mathHeading}>
            <MathSpans
              spans={block.spans}
              variant={block.level >= 3 ? "headingSmall" : "heading"}
            />
          </View>
        );
      }
      return (
        <Text style={[styles.heading, block.level >= 3 && styles.headingSmall]} selectable>
          <Spans spans={block.spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
        </Text>
      );
    case "bullet":
      return (
        <View style={styles.bulletRow}>
          <Text style={styles.bulletMark} selectable>{block.ordered ? `${block.ordered}.` : "•"}</Text>
          {hasMath(block.spans) ? (
            <View style={styles.mathBulletBody}>
              <MathSpans spans={block.spans} />
            </View>
          ) : (
            <Text style={styles.body} selectable>
              <Spans spans={block.spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
            </Text>
          )}
        </View>
      );
    case "code":
      return <CodeBlock code={block.code} lang={block.lang} />;
    case "math":
      return <MathFormula expression={block.expression} />;
    case "image":
      return (
        <MarkdownImage
          alt={block.alt}
          target={block.target}
          title={block.title}
          projectRoot={projectRoot}
          onOpenFile={onOpenFile}
          loadProjectImage={loadProjectImage}
        />
      );
    case "quote":
      return (
        <View style={styles.quote}>
          {hasMath(block.spans) ? (
            <MathSpans spans={block.spans} variant="quote" />
          ) : (
            <Text style={styles.quoteText} selectable>
              <Spans spans={block.spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
            </Text>
          )}
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
      if (hasMath(block.spans)) return <MathSpans spans={block.spans} />;
      return (
        <Text style={styles.body} selectable>
          <Spans spans={block.spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
        </Text>
      );
  }
});

function hasMath(spans: InlineSpan[]): boolean {
  return spans.some((span) => span.math === true);
}

function directImageUri(target: string): string | null {
  const value = target.trim();
  if (/^https?:\/\/[^\s]+$/i.test(value)) return value;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(value)) {
    // 防止一条 agent 消息直接塞入无限大的 data URI。
    return value.length <= 8 * 1024 * 1024 ? value.replace(/\s/g, "") : null;
  }
  return null;
}

const MarkdownImage = memo(function MarkdownImage({
  alt,
  target,
  title,
  projectRoot,
  onOpenFile,
  loadProjectImage,
}: {
  alt: string;
  target: string;
  title?: string;
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
  loadProjectImage?: ProjectImageLoader;
}) {
  const direct = useMemo(() => directImageUri(target), [target]);
  const reference = useMemo(
    () => (projectRoot ? resolveProjectFileReference(target, projectRoot, true) : null),
    [target, projectRoot],
  );
  const [uri, setUri] = useState<string | null>(direct);
  const [loading, setLoading] = useState(direct === null && reference !== null);
  const [error, setError] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setError(null);
      setAspectRatio(16 / 9);
      if (direct !== null) {
        setUri(direct);
        setLoading(false);
        return;
      }
      setUri(null);
      if (!reference || !loadProjectImage) {
        setLoading(false);
        setError(reference ? "无法从电脑读取这张图片" : "不支持的图片地址");
        return;
      }
      setLoading(true);
      void loadProjectImage(reference)
        .then((value) => {
          if (alive) setUri(value);
        })
        .catch((reason: unknown) => {
          if (alive) setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [direct, reference, loadProjectImage]);

  const caption = title || alt;
  const open = reference && onOpenFile ? () => onOpenFile(reference) : undefined;
  return (
    <View style={styles.imageCard}>
      <Pressable
        disabled={!open}
        onPress={open}
        accessibilityRole={open ? "imagebutton" : "image"}
        accessibilityLabel={alt || title || "Markdown 图片"}
        accessibilityHint={open ? "打开原图预览" : undefined}
      >
        {loading ? (
          <View style={styles.imagePlaceholder}>
            <ActivityIndicator color={color.accent} />
            <Text style={styles.imageStatus}>正在从电脑读取图片…</Text>
          </View>
        ) : uri !== null && error === null ? (
          <Image
            source={{ uri }}
            resizeMode="contain"
            style={[styles.image, { aspectRatio }]}
            onLoad={(event) => {
              const { width, height } = event.nativeEvent.source;
              if (width > 0 && height > 0) setAspectRatio(width / height);
            }}
            onError={() => setError("图片解码失败")}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Icon name="photo" size={25} color={color.textFaint} />
            <Text style={styles.imageError}>{error ?? "图片无法显示"}</Text>
            {open && <Text style={styles.imageOpen}>点按打开文件预览</Text>}
          </View>
        )}
      </Pressable>
      {caption ? <Text style={styles.imageCaption} selectable>{caption}</Text> : null}
    </View>
  );
});

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
      {hasMath(spans) ? (
        <MathSpans spans={spans} variant={header ? "tableHeader" : "table"} />
      ) : (
        <Text style={header ? styles.tableHeaderText : styles.tableText} selectable>
          <Spans spans={spans} projectRoot={projectRoot} onOpenFile={onOpenFile} />
        </Text>
      )}
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
  body: { color: color.text, fontSize: 15, lineHeight: 22 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  heading: { color: color.text, fontSize: 17, fontWeight: "700", lineHeight: 24, marginTop: 2 },
  headingSmall: { fontSize: 15 },
  mathHeading: { marginTop: 2 },
  bulletRow: { flexDirection: "row", gap: 8, paddingLeft: 2 },
  bulletMark: { color: color.accent, fontSize: 15, lineHeight: 22, minWidth: 14 },
  mathBulletBody: { flex: 1 },
  inlineCode: {
    fontFamily: MONOSPACE_FONT,
    fontSize: 13,
    color: color.success,
    backgroundColor: color.successBg,
  },
  fileReference: {
    color: color.accent,
    backgroundColor: color.accentBg,
    textDecorationLine: "underline",
    textDecorationColor: color.accent,
  },
  quote: { borderLeftWidth: 3, borderLeftColor: color.border, paddingLeft: 10 },
  quoteText: { color: color.textDim, fontSize: 14, lineHeight: 21 },
  rule: { height: 1, backgroundColor: color.border, marginVertical: 4 },
  imageCard: {
    width: "100%",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: 10,
    backgroundColor: color.surface,
  },
  image: { width: "100%", minHeight: 120, maxHeight: 420, backgroundColor: color.surfaceRaised },
  imagePlaceholder: {
    minHeight: 150,
    padding: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  imageStatus: { color: color.textDim, fontSize: 12 },
  imageError: { color: color.warn, fontSize: 12, lineHeight: 17, textAlign: "center" },
  imageOpen: { color: color.accent, fontSize: 11 },
  imageCaption: {
    color: color.textFaint,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  tableScroll: {
    maxWidth: "100%",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: 9,
  },
  tableScrollContent: { minWidth: "100%" },
  table: { minWidth: "100%" },
  tableRow: { flexDirection: "row", backgroundColor: color.surface },
  tableHeaderRow: { backgroundColor: color.surfaceRaised },
  tableAlternateRow: { backgroundColor: color.bg },
  tableCell: {
    width: 148,
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  tableHeaderCell: { minHeight: 40 },
  tableHeaderText: { color: color.text, fontSize: 12.5, lineHeight: 18, fontWeight: "700" },
  tableText: { color: color.textDim, fontSize: 12.5, lineHeight: 18 },
});
