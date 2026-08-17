import { Platform } from "react-native";

/**
 * 视觉语言的单一来源。
 *
 * 之前每个屏各写各的十六进制色和边距,结果是同一个"次要文字"在不同页面
 * 有三种灰,卡片圆角有 8/10/12 三档 —— 单看每屏都说得过去,连起来就显得脏。
 *
 * 取值原则:
 * - 层级靠【表面亮度】拉开,不靠边框。深色界面里堆边框会显得脏。
 * - 文字只有三级(主/次/弱)。第四级永远是设计没想清楚的信号。
 * - 间距走 4 的倍数,圆角只有三档。约束越少,越不容易走样。
 */

/** Menlo 不随 Android 分发；monospace 会映射到设备自带的等宽字体。 */
export const MONOSPACE_FONT = Platform.OS === "ios" ? "Menlo" : "monospace";

export const color = {
  /** 页面底色 */
  bg: "#0A0A0C",
  /** 卡片、输入框 */
  surface: "#16161A",
  /** 卡片上再叠一层(代码块、缩略图底) */
  surfaceRaised: "#1F1F25",
  /** 按下态 */
  pressed: "#26262D",
  /** 分隔线 —— 极低对比,只做暗示 */
  border: "#26262D",

  text: "#F2F2F5",
  textDim: "#9B9BA6",
  textFaint: "#61616B",

  accent: "#7AA2F7",
  accentDim: "#3A5BA8",

  success: "#5BC98C",
  warn: "#E5A341",
  danger: "#EF5F5F",

  /** 状态点/徽标用的低饱和底色 */
  successBg: "#16301F",
  warnBg: "#33270F",
  dangerBg: "#3A1A1A",
  accentBg: "#17203A",
} as const;

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
  /** 屏内大标题 */
  title: { fontSize: 20, fontWeight: "700" as const, color: color.text },
  /** 卡片标题、列表主文本 */
  body: { fontSize: 15, fontWeight: "500" as const, color: color.text },
  /** 次要说明 */
  sub: { fontSize: 13, color: color.textDim },
  /** 元信息、时间戳 */
  meta: { fontSize: 11, color: color.textFaint },
  mono: { fontFamily: MONOSPACE_FONT, fontSize: 12, color: color.text },
} as const;

/** 会话/连接状态到颜色 —— 全 App 一套,不再各屏各写 */
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
