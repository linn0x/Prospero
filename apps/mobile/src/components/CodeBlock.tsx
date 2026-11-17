import { memo, useState } from "react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ConversationText as Text } from "./ConversationTypography";
import { CodeHighlight } from "./CodeHighlight";
import { MONOSPACE_FONT, createThemedStyles } from "@/lib/theme";

/**
 * 代码块。带复制按钮 —— 手机上长按选中再拖两端去选一段命令是最折磨的操作之一,
 * 而 agent 给的代码块八成是拿来照抄执行的。
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
}: {
  code: string;
  lang?: string;
}) {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void Clipboard.setStringAsync(code);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Text style={styles.lang}>{lang !== undefined && lang !== "" ? lang : "code"}</Text>
        <Pressable onPress={copy} hitSlop={8} style={styles.copyBtn}>
          <Text style={[styles.copyText, copied && styles.copiedText]}>
            {copied ? "已复制" : "复制"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll}>
        <Text style={styles.code} selectable>
          <CodeHighlight code={code} language={lang} />
        </Text>
      </ScrollView>
    </View>
  );
});

const useStyles = createThemedStyles((color) => StyleSheet.create({
  wrap: {
    backgroundColor: color.surfaceRaised,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  lang: { color: color.textDim, fontSize: 11.5, fontWeight: "600", flex: 1 },
  copyBtn: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: color.surfaceRaised,
  },
  copyText: { color: color.textDim, fontSize: 11, fontWeight: "600" },
  copiedText: { color: color.success },
  scroll: { maxHeight: 280 },
  code: {
    fontFamily: MONOSPACE_FONT,
    fontSize: 12.5,
    color: color.text,
    lineHeight: 19,
    padding: 12,
  },
}));
