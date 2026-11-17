import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { toast } from "@/components/Toast";
import { deliveryFailureText, type DeliveryResult } from "@/lib/outbound-queue";
import type { TerminalModifiers } from "@/lib/keys";
import { MIN_TOUCH_TARGET, type TerminalFontPreference } from "@/lib/terminal-font-size";

interface KeyDef {
  label: string;
  seq: string;
  repeatable?: boolean;
  accessibilityLabel?: string;
}

const KEYS: KeyDef[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "⇧Tab", seq: "\x1b[Z", accessibilityLabel: "Shift Tab 切换模式" },
  { label: "↑", seq: "\x1b[A", repeatable: true },
  { label: "↓", seq: "\x1b[B", repeatable: true },
  { label: "←", seq: "\x1b[D", repeatable: true },
  { label: "→", seq: "\x1b[C", repeatable: true },
  { label: "␣", seq: " ", accessibilityLabel: "空格" },
  { label: "⏎", seq: "\r" },
  { label: "⌫", seq: "\x7f", repeatable: true },
  { label: "Del", seq: "\x1b[3~", repeatable: true },
  { label: "Home", seq: "\x1b[H" },
  { label: "End", seq: "\x1b[F" },
  { label: "PgUp", seq: "\x1b[5~" },
  { label: "PgDn", seq: "\x1b[6~" },
  { label: "/", seq: "/" },
  { label: "-", seq: "-" },
  { label: "~", seq: "~" },
  { label: "|", seq: "|" },
];

const PRIMARY_KEYS = new Set(["Esc", "Tab", "⇧Tab", "↑", "↓", "←", "→", "␣", "⏎"]);

const CTRL_SHORTCUTS: KeyDef[] = [
  { label: "^C", seq: "\x03" },
  { label: "^O", seq: "\x0f", accessibilityLabel: "Ctrl O 展开或收起详情" },
  { label: "^D", seq: "\x04" },
  { label: "^Z", seq: "\x1a" },
  { label: "^L", seq: "\x0c" },
  { label: "^R", seq: "\x12" },
  { label: "^A", seq: "\x01" },
  { label: "^E", seq: "\x05" },
  { label: "^W", seq: "\x17" },
  { label: "^K", seq: "\x0b" },
];

const CTRL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const MAX_COMPOSER_HISTORY = 30;

export interface KeyBarHandle {
  focusComposer(): boolean;
  isComposerOpen(): boolean;
}

export interface KeyBarProps {
  onKey: (seq: string) => DeliveryResult;
  onPaste: (text: string) => Promise<DeliveryResult>;
  onShortcut: (seq: string) => DeliveryResult;
  modifiers: TerminalModifiers;
  onToggleModifier: (key: keyof TerminalModifiers) => void;
  /** 提供时默认展示原生中文 / 多行命令输入栏，彻底解决手机输入法在 WebView 终端里吞字和不弹键盘的问题。 */
  onSendText?: (text: string, submit: boolean) => Promise<DeliveryResult>;
  defaultComposerOpen?: boolean;
  composerPlaceholder?: string;
  /** 提供时可提取当前终端屏幕文字与链接，支持自由划选复制或直接打开 OAuth 链接。 */
  onExtractText?: () => void;
  wideColsActive?: boolean;
  onToggleWideCols?: () => void;
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
}

function HoldRepeatKey({
  label,
  accessibilityLabel,
  disabled,
  repeatable,
  onTrigger,
}: {
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  repeatable?: boolean;
  onTrigger: () => void;
}) {
  const triggerRef = useRef(onTrigger);
  useEffect(() => {
    triggerRef.current = onTrigger;
  }, [onTrigger]);

  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const repeatedRef = useRef(false);

  const stopRepeat = useCallback(() => {
    if (delayRef.current !== null) {
      clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    if (repeatRef.current !== null) {
      clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  }, []);

  useEffect(() => stopRepeat, [stopRepeat]);
  useEffect(() => {
    if (disabled) stopRepeat();
  }, [disabled, stopRepeat]);

  if (!repeatable) {
    return (
      <Pressable
        onPress={onTrigger}
        disabled={disabled}
        style={({ pressed }) => [styles.key, disabled && styles.keyDisabled, pressed && styles.keyPressed]}
        accessibilityRole="keyboardkey"
        accessibilityLabel={accessibilityLabel}
      >
        <Text style={styles.keyText}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      disabled={disabled}
      onPressIn={() => {
        if (disabled) return;
        repeatedRef.current = false;
        stopRepeat();
        delayRef.current = setTimeout(() => {
          repeatedRef.current = true;
          triggerRef.current();
          repeatRef.current = setInterval(() => {
            triggerRef.current();
          }, 68);
        }, 260);
      }}
      onPressOut={stopRepeat}
      onPress={() => {
        stopRepeat();
        if (!repeatedRef.current) onTrigger();
        repeatedRef.current = false;
      }}
      style={({ pressed }) => [styles.key, disabled && styles.keyDisabled, pressed && styles.keyPressed]}
      accessibilityRole="keyboardkey"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  );
}

export const KeyBar = forwardRef<KeyBarHandle, KeyBarProps>(function KeyBar(
  {
    onKey,
    onPaste,
    onShortcut,
    modifiers,
    onToggleModifier,
    onSendText,
    defaultComposerOpen,
    composerPlaceholder = "输入消息或终端命令（支持中文与语音）…",
    onExtractText,
    wideColsActive = false,
    onToggleWideCols,
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
  },
  ref,
) {
  const { ctrl, option } = modifiers;
  const [expanded, setExpanded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(() => defaultComposerOpen ?? Boolean(onSendText));
  const [composerText, setComposerText] = useState("");
  const [composerSending, setComposerSending] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const composerInputRef = useRef<TextInput>(null);

  useImperativeHandle(
    ref,
    () => ({
      focusComposer: () => {
        if (!onSendText || !enabled) return false;
        if (!composerOpen) {
          setComposerOpen(true);
          setTimeout(() => composerInputRef.current?.focus(), 30);
          return true;
        }
        composerInputRef.current?.focus();
        return true;
      },
      isComposerOpen: () => Boolean(onSendText && composerOpen),
    }),
    [composerOpen, enabled, onSendText],
  );

  const send = (seq: string): void => {
    const result = onKey(seq);
    if (!result.accepted) {
      toast(deliveryFailureText(result));
      return;
    }
    void Haptics.selectionAsync();
  };

  const sendRawShortcut = (seq: string): void => {
    const result = onShortcut(seq);
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
    const result = await onPaste(text);
    if (!result.accepted) {
      toast(deliveryFailureText(result));
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toast(`已提交 ${String(text.length)} 字到终端`);
  };

  const submitComposer = async (submitWithEnter: boolean): Promise<void> => {
    if (!onSendText || !enabled || composerSending) return;
    if (composerText.length === 0) {
      if (submitWithEnter) send("\r");
      return;
    }
    setComposerSending(true);
    try {
      const result = await onSendText(composerText, submitWithEnter);
      if (!result.accepted) {
        toast(deliveryFailureText(result));
        return;
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const trimmed = composerText.trim();
      if (trimmed) {
        setHistory((prev) => {
          const deduped = [trimmed, ...prev.filter((item) => item !== trimmed)];
          return deduped.slice(0, MAX_COMPOSER_HISTORY);
        });
      }
      setComposerText("");
      setHistoryIndex(-1);
    } finally {
      setComposerSending(false);
    }
  };

  const stepHistory = (delta: 1 | -1): void => {
    if (history.length === 0) return;
    const nextIndex = Math.max(-1, Math.min(history.length - 1, historyIndex + delta));
    setHistoryIndex(nextIndex);
    setComposerText(nextIndex >= 0 ? (history[nextIndex] ?? "") : "");
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

      {onSendText && composerOpen && (
        <View style={styles.composerRow}>
          <Pressable
            onPress={() => sendRawShortcut("\x1b")}
            disabled={!enabled}
            style={({ pressed }) => [
              styles.composerEscBtn,
              !enabled && styles.keyDisabled,
              pressed && styles.keyPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="发送 Esc 中断或取消"
          >
            <Text style={styles.composerEscText}>Esc</Text>
          </Pressable>
          {history.length > 0 && (
            <Pressable
              onPress={() => stepHistory(1)}
              disabled={!enabled || historyIndex >= history.length - 1}
              style={({ pressed }) => [
                styles.composerIconBtn,
                (!enabled || historyIndex >= history.length - 1) && styles.keyDisabled,
                pressed && styles.keyPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="上一条已发送命令"
            >
              <Text style={styles.composerSecondaryText}>↺</Text>
            </Pressable>
          )}
          <TextInput
            ref={composerInputRef}
            style={styles.composerInput}
            value={composerText}
            onChangeText={(next) => {
              setComposerText(next);
              if (historyIndex !== -1) setHistoryIndex(-1);
            }}
            placeholder={composerPlaceholder}
            placeholderTextColor="#8B93A6"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            editable={enabled && !composerSending}
            accessibilityLabel="终端命令与提示词输入框"
          />
          {composerText.length > 0 && (
            <Pressable
              onPress={() => void submitComposer(false)}
              disabled={!enabled || composerSending}
              style={({ pressed }) => [
                styles.composerSecondaryBtn,
                (!enabled || composerSending) && styles.keyDisabled,
                pressed && styles.keyPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="仅填入终端不回车"
            >
              <Text style={styles.composerSecondaryText}>填入</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => void submitComposer(true)}
            disabled={!enabled || composerSending}
            style={({ pressed }) => [
              styles.composerSendBtn,
              (!enabled || composerSending) && styles.keyDisabled,
              pressed && styles.composerSendPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="发送到终端并执行"
          >
            <Text style={styles.composerSendText}>{composerText.length > 0 ? "发送 ⏎" : "回车 ⏎"}</Text>
          </Pressable>
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
          {onSendText && (
            <>
              <Pressable
                onPress={() => {
                  const next = !composerOpen;
                  setComposerOpen(next);
                  void Haptics.selectionAsync();
                  if (next) {
                    setTimeout(() => composerInputRef.current?.focus(), 40);
                  } else {
                    composerInputRef.current?.blur();
                  }
                }}
                disabled={!enabled}
                style={({ pressed }) => [
                  styles.key,
                  styles.composerToggleKey,
                  composerOpen && styles.modifierOn,
                  !enabled && styles.keyDisabled,
                  pressed && styles.keyPressed,
                ]}
                accessibilityRole="button"
                accessibilityState={{ expanded: composerOpen, disabled: !enabled }}
                accessibilityLabel={composerOpen ? "收起命令输入栏" : "打开命令输入栏"}
              >
                <Text style={[styles.keyText, styles.composerToggleText, composerOpen && styles.keyTextOn]}>
                  {composerOpen ? "⌨ 输入栏" : "⌨ 输入"}
                </Text>
              </Pressable>
              <View style={styles.sep} />
            </>
          )}

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

          {expanded && (
            <Pressable
              onPress={() => {
                onToggleModifier("option");
                void Haptics.selectionAsync();
              }}
              disabled={!enabled}
              accessibilityRole="button"
              accessibilityLabel="Option / Alt 组合键"
              accessibilityHint="点选后搭配下一个按键；Option 加左右方向键按词移动"
              accessibilityState={{ selected: option, disabled: !enabled }}
              style={({ pressed }) => [
                styles.key,
                styles.modifier,
                option && styles.modifierOn,
                !enabled && styles.keyDisabled,
                pressed && styles.keyPressed,
              ]}
            >
              <Text style={[styles.keyText, option && styles.keyTextOn]}>Opt ⌥</Text>
            </Pressable>
          )}

          <View style={styles.sep} />

          {KEYS.filter((k) => PRIMARY_KEYS.has(k.label) || expanded).map((k) => (
            <Fragment key={k.label}>
              <HoldRepeatKey
                label={k.label}
                accessibilityLabel={k.accessibilityLabel ?? k.label}
                disabled={!enabled}
                repeatable={k.repeatable}
                onTrigger={() => {
                  if (k.seq === "\x1b[Z") sendRawShortcut(k.seq);
                  else send(k.seq);
                }}
              />
              {k.label === "Tab" && newlineSequence && (
                <Pressable
                  onPress={() => sendRawShortcut(newlineSequence)}
                  disabled={!enabled}
                  style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
                  accessibilityRole="keyboardkey"
                  accessibilityLabel="在 Agent 中换行"
                >
                  <Text style={styles.keyText}>↵ 换行</Text>
                </Pressable>
              )}
            </Fragment>
          ))}

          <Pressable
            onPress={() => sendRawShortcut("\x0f")}
            disabled={!enabled}
            accessibilityRole="keyboardkey"
            accessibilityLabel="Ctrl O 展开详情"
            style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
          >
            <Text style={styles.keyText}>^O</Text>
          </Pressable>

          <Pressable
            onPress={() => void paste()}
            disabled={!enabled}
            accessibilityRole="button"
            accessibilityLabel="粘贴剪贴板内容"
            style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
          >
            <Text style={styles.keyText}>粘贴</Text>
          </Pressable>

          {onExtractText && (
            <Pressable
              onPress={onExtractText}
              accessibilityRole="button"
              accessibilityLabel="提取终端文字与链接"
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            >
              <Text style={styles.keyText}>选词/链接</Text>
            </Pressable>
          )}
        </ScrollView>

        <Pressable
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [styles.moreKey, pressed && styles.keyPressed]}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "收起终端工具" : "展开终端工具"}
          accessibilityState={{ expanded }}
        >
          <Text style={styles.moreText}>{expanded ? "−" : option ? "⌥" : "···"}</Text>
        </Pressable>
      </View>

      {expanded && (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.content}
        >
          {CTRL_SHORTCUTS.map((k) => (
            <Pressable
              key={k.label}
              onPress={() => sendRawShortcut(k.seq)}
              disabled={!enabled}
              accessibilityRole="keyboardkey"
              accessibilityLabel={k.accessibilityLabel ?? k.label}
              style={({ pressed }) => [styles.key, !enabled && styles.keyDisabled, pressed && styles.keyPressed]}
            >
              <Text style={styles.keyText}>{k.label}</Text>
            </Pressable>
          ))}

          <View style={styles.sep} />

          {onToggleWideCols && (
            <Pressable
              onPress={onToggleWideCols}
              style={({ pressed }) => [
                styles.key,
                styles.followSystemKey,
                wideColsActive && styles.modifierOn,
                pressed && styles.keyPressed,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: wideColsActive }}
              accessibilityLabel={wideColsActive ? "关闭 88 列宽屏适配" : "开启 88 列宽屏适配"}
            >
              <Text style={[styles.keyText, wideColsActive && styles.keyTextOn]}>88列宽屏</Text>
            </Pressable>
          )}

          {onCopyAll && (
            <Pressable
              onPress={onCopyAll}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              accessibilityRole="button"
              accessibilityLabel="复制终端全部内容"
            >
              <Text style={styles.keyText}>复制全部</Text>
            </Pressable>
          )}
          {onSearch && (
            <Pressable
              onPress={onSearch}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              accessibilityRole="button"
              accessibilityLabel="搜索终端内容"
            >
              <Text style={styles.keyText}>查找</Text>
            </Pressable>
          )}
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
                    fontSizeMode === "custom" ? "将终端字号重置为跟随系统" : "终端字号已跟随系统"
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
              onPress={() => {
                composerInputRef.current?.blur();
                onDismissKeyboard();
              }}
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
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    backgroundColor: "#14161B",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#272B36",
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#242833",
    backgroundColor: "#101217",
  },
  composerEscBtn: {
    minHeight: 40,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#3D2B2E",
    backgroundColor: "#251A1D",
    alignItems: "center",
    justifyContent: "center",
  },
  composerEscText: {
    color: "#F78C8C",
    fontSize: 12.5,
    fontWeight: "700",
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 118,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#343A4C",
    backgroundColor: "#1B1F29",
    color: "#F3F5FA",
    fontSize: 14,
    lineHeight: 20,
  },
  composerIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2E3342",
    backgroundColor: "#1E222C",
    alignItems: "center",
    justifyContent: "center",
  },
  composerSecondaryBtn: {
    minHeight: 40,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2E3342",
    backgroundColor: "#1E222C",
    alignItems: "center",
    justifyContent: "center",
  },
  composerSecondaryText: {
    color: "#CBD2E0",
    fontSize: 12.5,
    fontWeight: "600",
  },
  composerSendBtn: {
    minHeight: 40,
    paddingHorizontal: 13,
    borderRadius: 10,
    backgroundColor: "#F3F5FA",
    alignItems: "center",
    justifyContent: "center",
  },
  composerSendPressed: {
    opacity: 0.84,
  },
  composerSendText: {
    color: "#0F1218",
    fontSize: 13,
    fontWeight: "700",
  },
  primaryRow: { flexDirection: "row", alignItems: "center" },
  content: { paddingHorizontal: 8, paddingVertical: 5, gap: 5, alignItems: "center" },
  moreKey: {
    width: 46,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: "#272B36",
  },
  moreText: { color: "#A7AFBF", fontSize: 19, fontWeight: "600" },
  key: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    backgroundColor: "#1F232D",
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2E3342",
    paddingHorizontal: 10,
    paddingVertical: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  composerToggleKey: {
    paddingHorizontal: 11,
    backgroundColor: "#232836",
    borderColor: "#384056",
  },
  composerToggleText: {
    fontWeight: "600",
  },
  keyPressed: { backgroundColor: "#2D3240", transform: [{ scale: 0.96 }] },
  keyDisabled: { opacity: 0.38 },
  modifier: { borderWidth: 1, borderColor: "#383E4E" },
  modifierOn: { backgroundColor: "#26467D", borderColor: "#7EA7FF" },
  keyText: { color: "#EAECEF", fontSize: 13, fontVariant: ["tabular-nums"] },
  keyTextOn: { color: "#FFFFFF", fontWeight: "700" },
  followSystemKey: { paddingHorizontal: 12 },
  followSystemKeyActive: { backgroundColor: "#1E3050", borderWidth: 1, borderColor: "#3A5BA8" },
  followSystemKeyText: { color: "#AFC8FF" },
  sep: { width: 1, alignSelf: "stretch", marginHorizontal: 3, backgroundColor: "#272B36" },
  ctrlTray: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#242833",
  },
  ctrlLabel: { color: "#7EA7FF", fontSize: 12, fontWeight: "600", marginRight: 6 },
  ctrlContent: { gap: 5, paddingVertical: 4, paddingRight: 12 },
  ctrlKey: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2E3342",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1E222B",
  },
  ctrlKeyText: { color: "#EAECEF", fontSize: 12, fontWeight: "600" },
  offlineNotice: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    backgroundColor: "#3A2E17",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#655022",
  },
  offlineText: { flex: 1, color: "#EAC77C", fontSize: 11.5, lineHeight: 16 },
  offlineRetry: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
});
