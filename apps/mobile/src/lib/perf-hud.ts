/**
 * 性能读数开关。
 *
 * 终端的 WebView 每秒上报一次帧率、吞吐和实际渲染器,但 Release 构建里 console
 * 是哑的,这些数字只能走 UI。开关持久化在本机,和会话、主机都无关。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "prospero.perfHud.v1";

export interface TerminalPerf {
  /** WebView 侧的渲染帧率 */
  fps: number;
  /** 该秒窗内收到的终端字节数(KB) */
  kb: number;
  /** xterm 实际启用的渲染器;webgl 会静默降级成 canvas 或 dom */
  renderer: string;
}

export async function getPerfHudEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY)) === "1";
  } catch {
    return false;
  }
}

export async function setPerfHudEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    // 读数开关丢了不影响使用,不打扰用户。
  }
}

/** 帧率配色:60 附近为好,50 以下开始能感觉到,40 以下是明显掉帧。 */
export function fpsTone(fps: number): "good" | "warn" | "bad" {
  if (fps >= 50) return "good";
  return fps >= 40 ? "warn" : "bad";
}

/** webgl 之外都是降级路径,值得直接标出来。 */
export function rendererTone(renderer: string): "good" | "warn" {
  return renderer === "webgl" ? "good" : "warn";
}
