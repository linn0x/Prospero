import { Fragment, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { toast } from "@/components/Toast";
import { deliveryFailureText, type DeliveryResult } from "@/lib/outbound-queue";
import type { TerminalModifiers } from "@/lib/keys";
import { MIN_TOUCH_TARGET, type TerminalFontPreference } from "@/lib/terminal-font-size";

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
  { label: "⌫", seq: "\x7f" },
  { label: "Del", seq: "\x1b[3~" },
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
const PRIMARY_KEYS = new Set(["Esc", "Tab", "↑", "↓", "←", "→", "⏎"]);

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
  onPaste,
  onShortcut,
  modifiers,
  onToggleModifier,
  onFontSize,
  onResetFontSize,
  fontSizeMode = "system",
  onScrollBottom,
  onDismissKeyboard,
  onCopyAll,
  onSearch,
  newlineSequence,
  enabled = true,
  disabledMessage = "主机未连接；终端输入已冻结。",
  onRetry,
}: {
  onKey: (seq: string) => DeliveryResult;
  onPaste: (text: string) => Promise<DeliveryResult>;
  onShortcut: (seq: string) => DeliveryResult;
  modifiers: TerminalModifiers;
  onToggleModifier: (key: keyof TerminalModifiers) => void;
  onFontSize?: (delta: number) => void;
  /** 清除自定义档位，回到当前系统 Dynamic Type。 */
  onResetFontSize?: () => void;
  fontSizeMode?: TerminalFontPreference["mode"];
  onScrollBottom?: () => void;
  onDismissKeyboard?: () => void;
  onCopyAll?: () => void;
  onSearch?: () => void;
  newlineSequence?: string;
  /** Shell 字节不可安全重放，断线时所有会投递的按键必须冻结。 */
  enabled?: boolean;
  disabledMessage?: string;
  onRetry?: () => void;
}) {
  const { ctrl, option } = modifiers;
  const [expanded, setExpanded] = useState(false);

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
    // 终端先按当前粘贴模式编码，连接层再按宿主限制分块；断线时不重放。
    const result = await onPaste(text);
    if (!result.accepted) {
      toast(deliveryFailureText(result));
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toast(`已提交 ${String(text.length)} 字到终端`);
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
      {enabled && (ctrl || option) && (
        <View style={styles.ctrlTray}>
          <Text style={styles.ctrlLabel}>{[ctrl && "Ctrl", option && "Opt"].filter(Boolean).join(" + ")} +</Text>
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
                  send(option ? letter.toLowerCase() : letter);
                }}
                style={({ pressed }) => [styles.ctrlKey, pressed && styles.keyPressed]}
                accessibilityRole="keyboardkey"
                accessibilityLabel={`${ctrl ? "Control " : ""}${option ? "Option " : ""}${letter}`}
              >
                <Text style={styles.ctrlKeyText}>{letter}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
      <View style={styles.primaryRow}>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        <Pressable
          onPress={() => {
            onToggleModifier("ctrl");
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

        {expanded && <Pressable onPress={() => { onToggleModifier("option"); void Haptics.selectionAsync(); }}
          disabled={!enabled} accessibilityRole="button" accessibilityLabel="Option / Alt 组合键"
          accessibilityHint="点选后搭配下一个按键；Option 加左右方向键按词移动"
          accessibilityState={{ selected: option, disabled: !enabled }}
          style={({ pressed }) => [styles.key, styles.modifier, option && styles.modifierOn, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}>
          <Text style={[styles.keyText, option && styles.keyTextOn]}>Opt ⌥</Text>
        </Pressable>}

        <View style={styles.sep} />

        {KEYS.filter((k) => PRIMARY_KEYS.has(k.label) || expanded).map((k) => <Fragment key={k.label}>
          <Pressable
            onPress={() => send(k.seq)}
            disabled={!enabled}
            style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
            accessibilityRole="keyboardkey"
            accessibilityLabel={k.label}
          >
            <Text style={styles.keyText}>{k.label}</Text>
          </Pressable>
        {k.label === "Tab" && newlineSequence && <Pressable onPress={() => {
          const result = onShortcut(newlineSequence);
          if (!result.accepted) toast(deliveryFailureText(result));
          else void Haptics.selectionAsync();
        }} disabled={!enabled} style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
          accessibilityRole="keyboardkey" accessibilityLabel="在 Agent 中换行">
          <Text style={styles.keyText}>↵ 换行</Text>
        </Pressable>}
        </Fragment>)}
        <Pressable onPress={() => void paste()} disabled={!enabled} accessibilityRole="button"
          accessibilityLabel="粘贴剪贴板内容" style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}>
          <Text style={styles.keyText}>粘贴</Text>
        </Pressable>

      </ScrollView>
      <Pressable onPress={() => setExpanded((value) => !value)} style={({ pressed }) => [styles.moreKey, pressed && styles.keyPressed]}
        accessibilityRole="button" accessibilityLabel={expanded ? "收起终端工具" : "展开终端工具"} accessibilityState={{ expanded }}>
        <Text style={styles.moreText}>{expanded ? "−" : option ? "⌥" : "···"}</Text>
      </Pressable>
      </View>
      {expanded && <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}>
        {CTRL_SHORTCUTS.map((k) => (
          <Pressable key={k.label} onPress={() => {
            const result = onShortcut(k.seq);
            if (!result.accepted) toast(deliveryFailureText(result));
            else void Haptics.selectionAsync();
          }} disabled={!enabled} accessibilityRole="keyboardkey" accessibilityLabel={k.label}
            style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}>
            <Text style={styles.keyText}>{k.label}</Text>
          </Pressable>
        ))}

        <View style={styles.sep} />

        {onCopyAll && <Pressable onPress={onCopyAll} style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          accessibilityRole="button" accessibilityLabel="复制终端全部内容"><Text style={styles.keyText}>复制全部</Text></Pressable>}
        {onSearch && <Pressable onPress={onSearch} style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          accessibilityRole="button" accessibilityLabel="搜索终端内容"><Text style={styles.keyText}>查找</Text></Pressable>}
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
            {onResetFontSize && (
              <Pressable
                onPress={onResetFontSize}
                style={({ pressed }) => [
                  styles.key,
                  styles.followSystemKey,
                  fontSizeMode === "system" && styles.followSystemKeyActive,
                  pressed && styles.keyPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={
                  fontSizeMode === "custom"
                    ? "将终端字号重置为跟随系统"
                    : "终端字号已跟随系统"
                }
              >
                <Text style={[styles.keyText, fontSizeMode === "system" && styles.followSystemKeyText]}>
                  跟随系统
                </Text>
              </Pressable>
            )}
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
      </ScrollView>}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: "#1a1b26",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#343747",
  },
  primaryRow: { flexDirection: "row", alignItems: "center" },
  content: { paddingHorizontal: 8, paddingVertical: 5, gap: 5, alignItems: "center" },
  moreKey: { width: 46, minHeight: MIN_TOUCH_TARGET, alignItems: "center", justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: "#343747" },
  moreText: { color: "#9aa5ce", fontSize: 20, fontWeight: "600" },
  key: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    backgroundColor: "#292e42",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  keyPressed: { backgroundColor: "#3A3A45", transform: [{ scale: 0.96 }] },
  keyDisabled: { opacity: 0.38 },
  modifier: { borderWidth: 1, borderColor: "#3A3A45" },
  modifierOn: { backgroundColor: "#3A5BA8", borderColor: "#7AA2F7" },
  keyText: { color: "#E8E8EE", fontSize: 13, fontVariant: ["tabular-nums"] },
  keyTextOn: { color: "#fff", fontWeight: "600" },
  followSystemKey: { paddingHorizontal: 12 },
  followSystemKeyActive: { backgroundColor: "#223354", borderWidth: 1, borderColor: "#3A5BA8" },
  followSystemKeyText: { color: "#AFC8FF" },
  sep: { width: 1, alignSelf: "stretch", marginHorizontal: 3, backgroundColor: "#303038" },
  ctrlTray: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#26262D",
  },
  ctrlLabel: { color: "#7AA2F7", fontSize: 12, fontWeight: "600", marginRight: 6 },
  ctrlContent: { gap: 5, paddingVertical: 4, paddingRight: 12 },
  ctrlKey: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
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
