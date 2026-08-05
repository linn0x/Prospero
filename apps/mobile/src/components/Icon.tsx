import { Platform, Text, type StyleProp, type TextStyle } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

/**
 * SF Symbols 图标。
 *
 * iOS 上用系统符号 —— 和系统 App 同一套字形与光学重心,这是"看起来像原生"
 * 最省力也最有效的一步。非 iOS(或符号不存在)回落到文字,不影响功能。
 */
export type IconName =
  | "magnifyingglass"
  | "plus"
  | "arrow.up"
  | "stop.circle"
  | "trash"
  | "terminal"
  | "bubble.left.and.text.bubble.right"
  | "ellipsis.circle"
  | "doc.on.doc"
  | "arrow.clockwise"
  | "chevron.down"
  | "qrcode.viewfinder"
  | "desktopcomputer"
  | "checkmark.circle.fill"
  | "xmark.circle.fill"
  | "exclamationmark.triangle.fill"
  // agent 标识(见 AgentIcon)—— 取各家的气质而非商标
  | "asterisk"
  | "chevron.left.forwardslash.chevron.right"
  | "curlybraces"
  | "bolt.fill"
  | "wand.and.stars"
  | "terminal.fill"
  | "command";

const FALLBACK: Record<IconName, string> = {
  magnifyingglass: "🔍",
  plus: "＋",
  "arrow.up": "↑",
  "stop.circle": "■",
  trash: "🗑",
  terminal: "TTY",
  "bubble.left.and.text.bubble.right": "💬",
  "ellipsis.circle": "⋯",
  "doc.on.doc": "复制",
  "arrow.clockwise": "↻",
  "chevron.down": "▾",
  "qrcode.viewfinder": "⊞",
  desktopcomputer: "🖥",
  "checkmark.circle.fill": "✓",
  "xmark.circle.fill": "✕",
  "exclamationmark.triangle.fill": "⚠︎",
  asterisk: "✳",
  "chevron.left.forwardslash.chevron.right": "</>",
  curlybraces: "{}",
  "bolt.fill": "⚡",
  "wand.and.stars": "✨",
  "terminal.fill": "TTY",
  command: "⌘",
};

export function Icon({
  name,
  size = 20,
  color = "#e8e8ee",
  weight = "regular",
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  weight?: SymbolViewProps["weight"];
  style?: StyleProp<TextStyle>;
}) {
  if (Platform.OS === "ios") {
    return (
      <SymbolView
        name={name}
        size={size}
        tintColor={color}
        weight={weight}
        resizeMode="scaleAspectFit"
        fallback={<Text style={[{ color, fontSize: size * 0.8 }, style]}>{FALLBACK[name]}</Text>}
      />
    );
  }
  return <Text style={[{ color, fontSize: size * 0.8 }, style]}>{FALLBACK[name]}</Text>;
}
