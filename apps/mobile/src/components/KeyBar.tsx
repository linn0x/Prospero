import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { toast } from "@/components/Toast";
import { deliveryFailureText, type DeliveryResult } from "@/lib/outbound-queue";
import { ctrlCode } from "@/lib/keys";

interface KeyDef {
  label: string;
  seq: string;
}


/**
 * 常用键。原来是一排固定序列,缺了终端里最要紧的一类 ——
 * Ctrl 组合键。^R 反查历史、^A/^E 行首行尾、^W 删词、^K 删到行尾,
 * 这些是命令行日常,少了它们手机上的终端只能敲简单命令。
 *
 * 做成【粘滞 Ctrl】而不是把 ^A…^Z 全排上:一次点 Ctrl 再点字母,
 * 覆盖全部 26 个组合,而工具条只多一个键位。
 */
const KEYS: KeyDef[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "⏎", seq: "\r" },
  { label: "Home", seq: "\x1b[H" },
  { label: "End", seq: "\x1b[F" },
  { label: "PgUp", seq: "\x1b[5~" },
  { label: "PgDn", seq: "\x1b[6~" },
  // 手机键盘上这几个要切两层符号页才够得着,而它们在命令行里极高频
  { label: "/", seq: "/" },
  { label: "-", seq: "-" },
  { label: "~", seq: "~" },
  { label: "|", seq: "|" },
];

/** 常用 Ctrl 组合直接给快捷键位,省掉两次点击 */
const CTRL_SHORTCUTS: KeyDef[] = [
  { label: "^C", seq: "\x03" },
  { label: "^D", seq: "\x04" },
  { label: "^R", seq: "\x12" },
  { label: "^A", seq: "\x01" },
  { label: "^E", seq: "\x05" },
  { label: "^W", seq: "\x17" },
  { label: "^K", seq: "\x0b" },
];

const CTRL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function KeyBar({
  onKey,
  onFontSize,
  onScrollBottom,
  onDismissKeyboard,
  enabled = true,
  disabledMessage = "主机未连接；终端输入已冻结。",
  onRetry,
}: {
  onKey: (seq: string) => DeliveryResult;
  onFontSize?: (delta: number) => void;
  onScrollBottom?: () => void;
  onDismissKeyboard?: () => void;
  /** Shell 字节不可安全重放，断线时所有会投递的按键必须冻结。 */
  enabled?: boolean;
  disabledMessage?: string;
  onRetry?: () => void;
}) {
  const [ctrl, setCtrl] = useState(false);

  const send = (seq: string): void => {
    const result = onKey(seq);
    if (!result.accepted) {
      toast(deliveryFailureText(result));
      return;
    }
    void Haptics.selectionAsync();
  };

  const paste = async (): Promise<void> => {
    const text = await Clipboard.getStringAsync();
    if (!text) {
      toast("剪贴板是空的");
      return;
    }
    // PTY 对大块粘贴有死锁报告,daemon 侧已分片写入;这里只管发。
    // 输入在断线期间绝不排队，重连后执行旧 shell 字节比丢弃更危险。
    const result = onKey(text);
    if (!result.accepted) {
      toast(deliveryFailureText(result));
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toast(`已粘贴 ${String(text.length)} 字`);
  };

  return (
    <View style={styles.bar}>
      {!enabled && (
        <View
          style={styles.offlineNotice}
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={disabledMessage}
        >
          <Text style={styles.offlineText}>{disabledMessage}</Text>
          {onRetry && (
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              accessibilityLabel="重新连接主机"
            >
              <Text style={styles.offlineRetry}>重试</Text>
            </Pressable>
          )}
        </View>
      )}
      {enabled && ctrl && (
        <View style={styles.ctrlTray}>
          <Text style={styles.ctrlLabel}>Ctrl +</Text>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.ctrlContent}
          >
            {CTRL_LETTERS.map((letter) => (
              <Pressable
                key={letter}
                onPress={() => {
                  send(ctrlCode(letter));
                  setCtrl(false);
                }}
                style={({ pressed }) => [styles.ctrlKey, pressed && styles.keyPressed]}
                accessibilityRole="keyboardkey"
                accessibilityLabel={`Control ${letter}`}
              >
                <Text style={styles.ctrlKeyText}>{letter}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        <Pressable
          onPress={() => {
            setCtrl((v) => !v);
            void Haptics.selectionAsync();
          }}
          disabled={!enabled}
          style={({ pressed }) => [
            styles.key,
            styles.modifier,
            ctrl && styles.modifierOn,
            !enabled && styles.keyDisabled,
            pressed && styles.keyPressed,
          ]}
          accessibilityRole="button"
          accessibilityState={{ selected: ctrl }}
          accessibilityLabel="Control 组合键"
        >
          <Text style={[styles.keyText, ctrl && styles.keyTextOn]}>Ctrl</Text>
        </Pressable>

        {CTRL_SHORTCUTS.map((k) => (
          <Pressable
            key={k.label}
            onPress={() => {
              send(k.seq);
              setCtrl(false);
            }}
            disabled={!enabled}
            style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
            accessibilityRole="keyboardkey"
            accessibilityLabel={k.label}
          >
            <Text style={styles.keyText}>{k.label}</Text>
          </Pressable>
        ))}

        <View style={styles.sep} />

        {KEYS.map((k) => (
          <Pressable
            key={k.label}
            onPress={() => send(k.seq)}
            disabled={!enabled}
            style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
            accessibilityRole="keyboardkey"
            accessibilityLabel={k.label}
          >
            <Text style={styles.keyText}>{k.label}</Text>
          </Pressable>
        ))}

        <View style={styles.sep} />

        <Pressable
          onPress={() => void paste()}
          disabled={!enabled}
          style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
          accessibilityRole="button"
          accessibilityLabel="粘贴剪贴板内容"
        >
          <Text style={styles.keyText}>粘贴</Text>
        </Pressable>
        {onFontSize && (
          <>
            <Pressable
              onPress={() => onFontSize(-1)}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              accessibilityRole="button"
              accessibilityLabel="缩小终端文字"
            >
              <Text style={styles.keyText}>A−</Text>
            </Pressable>
            <Pressable
              onPress={() => onFontSize(1)}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              accessibilityRole="button"
              accessibilityLabel="放大终端文字"
            >
              <Text style={styles.keyText}>A+</Text>
            </Pressable>
          </>
        )}
        {onDismissKeyboard && (
          <Pressable
            onPress={onDismissKeyboard}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            accessibilityRole="button"
            accessibilityLabel="收起键盘"
          >
            <Text style={styles.keyText}>⌄ 键盘</Text>
          </Pressable>
        )}
        {onScrollBottom && (
          <Pressable
            onPress={onScrollBottom}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            accessibilityRole="button"
            accessibilityLabel="滚动到底部"
          >
            <Text style={styles.keyText}>↧ 底部</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: "#141419",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#26262D",
  },
  content: { paddingHorizontal: 8, paddingVertical: 7, gap: 6, alignItems: "center" },
  key: {
    minHeight: 36,
    backgroundColor: "#24242B",
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 7,
    minWidth: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  keyPressed: { backgroundColor: "#3A3A45", transform: [{ scale: 0.96 }] },
  keyDisabled: { opacity: 0.38 },
  modifier: { borderWidth: 1, borderColor: "#3A3A45" },
  modifierOn: { backgroundColor: "#3A5BA8", borderColor: "#7AA2F7" },
  keyText: { color: "#E8E8EE", fontSize: 13, fontVariant: ["tabular-nums"] },
  keyTextOn: { color: "#fff", fontWeight: "600" },
  sep: { width: 1, alignSelf: "stretch", marginHorizontal: 3, backgroundColor: "#303038" },
  ctrlTray: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#26262D",
  },
  ctrlLabel: { color: "#7AA2F7", fontSize: 12, fontWeight: "600", marginRight: 6 },
  ctrlContent: { gap: 5, paddingVertical: 6, paddingRight: 12 },
  ctrlKey: {
    width: 31,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#24242B",
  },
  ctrlKeyText: { color: "#E8E8EE", fontSize: 12, fontWeight: "600" },
  offlineNotice: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    backgroundColor: "#3a2e17",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#655022",
  },
  offlineText: { flex: 1, color: "#EAC77C", fontSize: 11.5, lineHeight: 16 },
  offlineRetry: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
