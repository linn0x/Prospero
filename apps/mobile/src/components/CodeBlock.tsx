import { memo, useState } from "react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { color, MONOSPACE_FONT } from "@/lib/theme";

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
          {code}
        </Text>
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: color.surfaceRaised,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: color.border,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: color.surface,
  },
  lang: { color: color.textFaint, fontSize: 11, flex: 1 },
  copyBtn: { paddingHorizontal: 4 },
  copyText: { color: color.accent, fontSize: 11, fontWeight: "600" },
  copiedText: { color: color.success },
  scroll: { maxHeight: 280 },
  code: {
    fontFamily: MONOSPACE_FONT,
    fontSize: 12,
    color: color.text,
    lineHeight: 18,
    padding: 10,
  },
});
