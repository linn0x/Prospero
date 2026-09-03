import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps } from "react";
import { Platform, Text, type StyleProp, type TextStyle } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

/**
 * 跨平台系统图标。
 *
 * iOS 上用系统符号 —— 和系统 App 同一套字形与光学重心,这是"看起来像原生"
 * 最省力也最有效的一步。Android 使用 Material Icons，避免 Emoji 的字形、颜色和
 * 对齐方式随 ROM 变化；Web（或符号不存在）才回落到文字，不影响功能。
 */
export type IconName =
  | "magnifyingglass"
  | "plus"
  | "arrow.up"
  | "mic.fill"
  | "xmark"
  | "stop.circle"
  | "trash"
  | "terminal"
  | "bubble.left.and.text.bubble.right"
  | "ellipsis.circle"
  | "doc.on.doc"
  | "paperclip"
  | "photo"
  | "arrow.clockwise"
  | "archivebox"
  | "chevron.down"
  | "chevron.left"
  | "qrcode.viewfinder"
  | "desktopcomputer"
  | "folder.fill"
  | "doc.fill"
  | "house.fill"
  | "chevron.right"
  | "checkmark.circle.fill"
  | "xmark.circle.fill"
  | "exclamationmark.triangle.fill"
  // shell / custom 用系统符号 —— 它们不是产品,没有标(见 AgentIcon)
  | "terminal.fill"
  | "command"
  | "point.3.connected.trianglepath.dotted"
  | "square.stack.3d.up"
  | "play.fill"
  | "speedometer"
  | "arrow.triangle.branch";

const FALLBACK: Record<IconName, string> = {
  magnifyingglass: "🔍",
  plus: "＋",
  "arrow.up": "↑",
  "mic.fill": "🎙",
  xmark: "×",
  "stop.circle": "■",
  trash: "🗑",
  terminal: "TTY",
  "bubble.left.and.text.bubble.right": "💬",
  "ellipsis.circle": "⋯",
  "doc.on.doc": "复制",
  paperclip: "＋",
  photo: "▧",
  "arrow.clockwise": "↻",
  archivebox: "归档",
  "chevron.down": "▾",
  "chevron.left": "‹",
  "qrcode.viewfinder": "⊞",
  desktopcomputer: "🖥",
  "folder.fill": "▰",
  "doc.fill": "▤",
  "house.fill": "⌂",
  "chevron.right": "›",
  "checkmark.circle.fill": "✓",
  "xmark.circle.fill": "✕",
  "exclamationmark.triangle.fill": "⚠︎",
  "terminal.fill": "TTY",
  command: "⌘",
  "point.3.connected.trianglepath.dotted": "⌘",
  "square.stack.3d.up": "▱",
  "play.fill": "▶︎",
  speedometer: "FPS",
  "arrow.triangle.branch": "⑂",
};

type MaterialIconName = ComponentProps<typeof MaterialIcons>["name"];

const ANDROID_ICON: Record<IconName, MaterialIconName> = {
  magnifyingglass: "search",
  plus: "add",
  "arrow.up": "arrow-upward",
  "mic.fill": "mic",
  xmark: "close",
  "stop.circle": "stop-circle",
  trash: "delete-outline",
  terminal: "terminal",
  "bubble.left.and.text.bubble.right": "forum",
  "ellipsis.circle": "more-horiz",
  "doc.on.doc": "content-copy",
  paperclip: "attach-file",
  photo: "photo",
  "arrow.clockwise": "refresh",
  archivebox: "archive",
  "chevron.down": "keyboard-arrow-down",
  "chevron.left": "keyboard-arrow-left",
  "qrcode.viewfinder": "qr-code-scanner",
  desktopcomputer: "computer",
  "folder.fill": "folder",
  "doc.fill": "description",
  "house.fill": "home",
  "chevron.right": "keyboard-arrow-right",
  "checkmark.circle.fill": "check-circle",
  "xmark.circle.fill": "cancel",
  "exclamationmark.triangle.fill": "warning",
  "terminal.fill": "terminal",
  command: "keyboard-command-key",
  "point.3.connected.trianglepath.dotted": "account-tree",
  "square.stack.3d.up": "layers",
  "play.fill": "play-arrow",
  speedometer: "speed",
  "arrow.triangle.branch": "call-split",
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

  if (Platform.OS === "android") {
    return (
      <MaterialIcons
        name={ANDROID_ICON[name]}
        size={size}
        color={color}
        allowFontScaling={false}
        style={style}
      />
    );
  }

  return <Text style={[{ color, fontSize: size * 0.8 }, style]}>{FALLBACK[name]}</Text>;
}
