import AsyncStorage from "@react-native-async-storage/async-storage";

const LAST_HOME_HOST_KEY = "prospero.home.lastHost.v1";
const HOME_SETTINGS_KEY = "prospero.home.settings.v1";

export const HOME_RECENT_SESSION_LIMITS = [3, 5, 8, 10] as const;
export type HomeRecentSessionLimit = (typeof HOME_RECENT_SESSION_LIMITS)[number];
export const HOME_THEME_MODES = ["system", "light", "dark"] as const;
export type HomeThemeMode = (typeof HOME_THEME_MODES)[number];

export interface HomeSettings {
  recentSessionLimit: HomeRecentSessionLimit;
  backgroundProgressEnabled: boolean;
  overlayProgressEnabled: boolean;
  themeMode: HomeThemeMode;
  /** 仅改变本机 UI 的显示名称，不修改远端目录或已有会话 cwd。 */
  workspaceAliases: Record<string, string>;
}

export const DEFAULT_HOME_SETTINGS: HomeSettings = {
  recentSessionLimit: 5,
  backgroundProgressEnabled: true,
  overlayProgressEnabled: false,
  themeMode: "system",
  workspaceAliases: {},
};

export function workspaceAliasKey(hostId: string, path: string): string {
  return `${hostId}\u001f${path.trim().replace(/[\\/]+$/u, "") || "/"}`;
}

function validWorkspaceAliases(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const aliases: Record<string, string> = {};
  for (const [key, alias] of Object.entries(value)) {
    if (key.length > 20_000 || typeof alias !== "string") continue;
    const trimmed = alias.trim();
    if (trimmed.length > 0 && trimmed.length <= 60) aliases[key] = trimmed;
  }
  return aliases;
}

/** 兼容旧版持久化数据和 Fast Refresh 保留下来的旧状态形状。 */
export function normalizeHomeSettings(value: unknown): HomeSettings {
  const settings =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<HomeSettings>)
      : {};
  return {
    recentSessionLimit: HOME_RECENT_SESSION_LIMITS.includes(
      settings.recentSessionLimit as HomeRecentSessionLimit,
    )
      ? (settings.recentSessionLimit as HomeRecentSessionLimit)
      : DEFAULT_HOME_SETTINGS.recentSessionLimit,
    backgroundProgressEnabled:
      typeof settings.backgroundProgressEnabled === "boolean"
        ? settings.backgroundProgressEnabled
        : DEFAULT_HOME_SETTINGS.backgroundProgressEnabled,
    overlayProgressEnabled:
      typeof settings.overlayProgressEnabled === "boolean"
        ? settings.overlayProgressEnabled
        : DEFAULT_HOME_SETTINGS.overlayProgressEnabled,
    themeMode: HOME_THEME_MODES.includes(settings.themeMode as HomeThemeMode)
      ? (settings.themeMode as HomeThemeMode)
      : DEFAULT_HOME_SETTINGS.themeMode,
    workspaceAliases: validWorkspaceAliases(settings.workspaceAliases),
  };
}

function parseHomeSettings(raw: string | null): HomeSettings {
  if (!raw) return normalizeHomeSettings(null);
  try {
    return normalizeHomeSettings(JSON.parse(raw));
  } catch {
    return normalizeHomeSettings(null);
  }
}

/** 最近在首页主动选择的设备；读取失败不应阻塞冷启动。 */
export async function getLastHomeHostId(): Promise<string | null> {
  try {
    const hostId = (await AsyncStorage.getItem(LAST_HOME_HOST_KEY))?.trim();
    return hostId ? hostId : null;
  } catch {
    return null;
  }
}

export async function rememberLastHomeHost(hostId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_HOME_HOST_KEY, hostId);
  } catch {
    // 设备切换已经发生；偏好写入失败不能让首页操作报错。
  }
}

export async function getHomeSettings(): Promise<HomeSettings> {
  try {
    return parseHomeSettings(await AsyncStorage.getItem(HOME_SETTINGS_KEY));
  } catch {
    return DEFAULT_HOME_SETTINGS;
  }
}

export async function rememberHomeSettings(settings: HomeSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(HOME_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 设置已经在内存中生效；持久化失败不应阻塞首页交互。
  }
}
