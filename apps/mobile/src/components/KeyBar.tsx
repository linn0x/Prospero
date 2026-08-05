import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { toast } from "@/components/Toast";
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
  { label: "esc", seq: "\x1b" },
  { label: "tab", seq: "\t" },
  { label: "⏎", seq: "\r" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "home", seq: "\x1b[H" },
  { label: "end", seq: "\x1b[F" },
  { label: "pgup", seq: "\x1b[5~" },
  { label: "pgdn", seq: "\x1b[6~" },
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
];

export function KeyBar({
  onKey,
  onFontSize,
  onScrollBottom,
  onDismissKeyboard,
}: {
  onKey: (seq: string) => void;
  onFontSize?: (delta: number) => void;
  onScrollBottom?: () => void;
  onDismissKeyboard?: () => void;
}) {
  const [ctrl, setCtrl] = useState(false);

  const send = (seq: string): void => {
    if (ctrl) {
      onKey(ctrlCode(seq));
      setCtrl(false);
      return;
    }
    onKey(seq);
  };

  const paste = async (): Promise<void> => {
    const text = await Clipboard.getStringAsync();
    if (!text) {
      toast("剪贴板是空的");
      return;
    }
    // PTY 对大块粘贴有死锁报告,daemon 侧已分片写入;这里只管发
    onKey(text);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toast(`已粘贴 ${String(text.length)} 字`);
  };

  return (
    <View style={styles.bar}>
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
          style={({ pressed }) => [
            styles.key,
            styles.modifier,
            ctrl && styles.modifierOn,
            pressed && styles.keyPressed,
          ]}
        >
          <Text style={[styles.keyText, ctrl && styles.keyTextOn]}>ctrl</Text>
        </Pressable>

        {CTRL_SHORTCUTS.map((k) => (
          <Pressable
            key={k.label}
            onPress={() => {
              onKey(k.seq);
              setCtrl(false);
            }}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          >
            <Text style={styles.keyText}>{k.label}</Text>
          </Pressable>
        ))}

        <View style={styles.sep} />

        {KEYS.map((k) => (
          <Pressable
            key={k.label}
            onPress={() => send(k.seq)}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          >
            <Text style={styles.keyText}>{k.label}</Text>
          </Pressable>
        ))}

        <View style={styles.sep} />

        <Pressable
          onPress={() => void paste()}
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
        >
          <Text style={styles.keyText}>粘贴</Text>
        </Pressable>
        {onFontSize && (
          <>
            <Pressable
              onPress={() => onFontSize(-1)}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            >
              <Text style={styles.keyText}>A−</Text>
            </Pressable>
            <Pressable
              onPress={() => onFontSize(1)}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            >
              <Text style={styles.keyText}>A+</Text>
            </Pressable>
          </>
        )}
        {onDismissKeyboard && (
          <Pressable
            onPress={onDismissKeyboard}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          >
            <Text style={styles.keyText}>⌄收起</Text>
          </Pressable>
        )}
        {onScrollBottom && (
          <Pressable
            onPress={onScrollBottom}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          >
            <Text style={styles.keyText}>↧底</Text>
          </Pressable>
        )}
      </ScrollView>
      {ctrl && <Text style={styles.hint}>ctrl 已按下 —— 再点一个字母键</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: "#141419" },
  content: { paddingHorizontal: 8, paddingVertical: 6, gap: 6, alignItems: "center" },
  key: {
    backgroundColor: "#26262e",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 40,
    alignItems: "center",
  },
  keyPressed: { backgroundColor: "#3a3a46" },
  modifier: { borderWidth: 1, borderColor: "#3a3a46" },
  modifierOn: { backgroundColor: "#3557b7", borderColor: "#5a7fd0" },
  keyText: { color: "#e8e8ee", fontSize: 14, fontVariant: ["tabular-nums"] },
  keyTextOn: { color: "#fff", fontWeight: "600" },
  sep: { width: 1, alignSelf: "stretch", marginHorizontal: 3, backgroundColor: "#2a2a33" },
  hint: {
    color: "#7aa2f7",
    fontSize: 11,
    paddingHorizontal: 12,
    paddingBottom: 5,
  },
});
