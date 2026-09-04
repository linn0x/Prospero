import { createContext, useContext } from "react";
import {
  Appearance,
  DynamicColorIOS,
  Platform,
  PlatformColor,
  type ColorSchemeName,
} from "react-native";

/** Menlo 不随 Android 分发；monospace 会映射到设备自带的等宽字体。 */
export const MONOSPACE_FONT = Platform.OS === "ios" ? "Menlo" : "monospace";

/**
 * 明暗两套视觉令牌。字符串版本用于导航主题等要求普通字符串的 API；
 * `color` 则在原生层使用动态颜色，已有 StyleSheet 无需逐页重建也会随主题切换。
 */
export const darkColor = {
  bg: "#0B0D12",
  surface: "#151820",
  surfaceRaised: "#20242D",
  pressed: "#2A303B",
  border: "#343A46",
  text: "#F5F7FA",
  textDim: "#C1C7D0",
  textFaint: "#929BA8",
  accent: "#7EA7FF",
  accentDim: "#294A82",
  onAccent: "#071224",
  success: "#5BC98C",
  warn: "#E5A341",
  danger: "#EF5F5F",
  successBg: "#16301F",
  warnBg: "#33270F",
  dangerBg: "#3A1A1A",
  accentBg: "#17203A",
} as const;

export const lightColor: { [Key in keyof typeof darkColor]: string } = {
  bg: "#F2F4F7",
  surface: "#FFFFFF",
  surfaceRaised: "#E8ECF2",
  pressed: "#DCE2EA",
  border: "#C4CBD5",
  text: "#11151B",
  textDim: "#404957",
  textFaint: "#667180",
  accent: "#315EA8",
  accentDim: "#D7E3F8",
  onAccent: "#FFFFFF",
  success: "#1E7049",
  warn: "#87530A",
  danger: "#AD3030",
  successBg: "#DDF1E7",
  warnBg: "#F7E8CC",
  dangerBg: "#F8DEDE",
  accentBg: "#E4ECFB",
};

export type ThemePalette = { [Key in keyof typeof darkColor]: string };
export type ThemeScheme = "light" | "dark";
export type ThemeMode = ThemeScheme | "system";
export type MobileTheme = { scheme: ThemeScheme; palette: ThemePalette };
export const MobileThemeContext = createContext<MobileTheme>({
  scheme: "dark",
  palette: darkColor,
});
let lastAppliedNativeThemeMode: ThemeMode | undefined;

/** 显式主题上下文用于需要在同一 React 提交内完成换色的页面。 */
export function useMobileTheme(): MobileTheme {
  return useContext(MobileThemeContext);
}

/** 应用主题使用用户偏好作为即时状态；系统模式才读取设备外观。 */
export function resolveThemeScheme(
  mode: ThemeMode,
  systemScheme: ColorSchemeName,
): ThemeScheme {
  return mode === "system" ? (systemScheme === "light" ? "light" : "dark") : mode;
}

/**
 * 在 React 提交后同步 Android uiMode。Appearance.setColorScheme 本身不会主动派发
 * change 事件，因此固定明/暗模式的界面状态不能依赖 useColorScheme 回传。
 */
export function applyNativeThemeMode(mode: ThemeMode): void {
  if (lastAppliedNativeThemeMode === mode) return;
  lastAppliedNativeThemeMode = mode;
  Appearance.setColorScheme(mode === "system" ? "unspecified" : mode);
}

const androidResource: Record<keyof ThemePalette, string> = {
  bg: "prospero_bg",
  surface: "prospero_surface",
  surfaceRaised: "prospero_surface_raised",
  pressed: "prospero_pressed",
  border: "prospero_border",
  text: "prospero_text",
  textDim: "prospero_text_dim",
  textFaint: "prospero_text_faint",
  accent: "prospero_accent",
  accentDim: "prospero_accent_dim",
  onAccent: "prospero_on_accent",
  success: "prospero_success",
  warn: "prospero_warn",
  danger: "prospero_danger",
  successBg: "prospero_success_bg",
  warnBg: "prospero_warn_bg",
  dangerBg: "prospero_danger_bg",
  accentBg: "prospero_accent_bg",
};

function adaptiveColor(name: keyof ThemePalette): string {
  if (Platform.OS === "ios") {
    return DynamicColorIOS({ light: lightColor[name], dark: darkColor[name] }) as unknown as string;
  }
  if (Platform.OS === "android") {
    return PlatformColor(`@color/${androidResource[name]}`) as unknown as string;
  }
  // Web 仍有完整的深色基线；移动端的 iOS / Android 使用真正的原生动态颜色。
  return darkColor[name];
}

export const color: ThemePalette = {
  bg: adaptiveColor("bg"),
  surface: adaptiveColor("surface"),
  surfaceRaised: adaptiveColor("surfaceRaised"),
  pressed: adaptiveColor("pressed"),
  border: adaptiveColor("border"),
  text: adaptiveColor("text"),
  textDim: adaptiveColor("textDim"),
  textFaint: adaptiveColor("textFaint"),
  accent: adaptiveColor("accent"),
  accentDim: adaptiveColor("accentDim"),
  onAccent: adaptiveColor("onAccent"),
  success: adaptiveColor("success"),
  warn: adaptiveColor("warn"),
  danger: adaptiveColor("danger"),
  successBg: adaptiveColor("successBg"),
  warnBg: adaptiveColor("warnBg"),
  dangerBg: adaptiveColor("dangerBg"),
  accentBg: adaptiveColor("accentBg"),
};

export function paletteForScheme(scheme: ThemeScheme): ThemePalette {
  return scheme === "light" ? lightColor : darkColor;
}

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
} as const;

export const font = {
  title: { fontSize: 20, fontWeight: "700" as const, color: color.text },
  body: { fontSize: 15, fontWeight: "500" as const, color: color.text },
  sub: { fontSize: 13, color: color.textDim },
  meta: { fontSize: 11, color: color.textFaint },
  mono: { fontFamily: MONOSPACE_FONT, fontSize: 12, color: color.text },
} as const;

/** 会话/连接状态到颜色 —— 全 App 一套。 */
export const statusColor: Record<string, string> = {
  running: color.warn,
  starting: color.warn,
  waiting_approval: color.warn,
  waiting_input: color.accent,
  idle: color.accent,
  completed: color.success,
  done: color.textFaint,
  died: color.danger,
  connected: color.success,
  connecting: color.warn,
  reconnecting: color.warn,
  failed: color.danger,
};

/** 利用率 → 颜色。80% 起变暖,95% 起告警 */
export function utilizationColor(pct: number): string {
  if (pct >= 95) return color.danger;
  if (pct >= 80) return color.warn;
  return color.accent;
}

/** 订阅余额颜色：余额越少越紧急，低于 15% 明确标红。 */
export function quotaRemainingColor(remaining: number): string {
  if (remaining < 15) return color.danger;
  if (remaining < 35) return color.warn;
  return color.accent;
}

/** 服务端上报已用比例；进度条统一表达为 100% → 0% 的剩余额度。 */
export function quotaRemainingPct(utilization: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - utilization)));
}
