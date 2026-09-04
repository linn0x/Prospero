import type { DesktopSettings, JsonObject } from "./types";

const SETTING_KEYS = new Set<keyof DesktopSettings>([
  "startDaemonOnLaunch",
  "fullAccessPermission",
  "minimizeToTray",
  "launchAtLogin",
  "theme",
  "workspaceSort",
  "terminalFontFamily",
  "terminalFontSize",
  "daemonBind",
]);

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function desktopSettingsPatch(input: JsonObject, platform: NodeJS.Platform): Partial<DesktopSettings> {
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !SETTING_KEYS.has(key as keyof DesktopSettings))) throw new Error("设置项无效");
  const patch: Partial<DesktopSettings> = {};
  if (Object.hasOwn(input, "startDaemonOnLaunch")) {
    if (typeof input["startDaemonOnLaunch"] !== "boolean") throw new Error("启动设置无效");
    patch.startDaemonOnLaunch = input["startDaemonOnLaunch"];
  }
  if (Object.hasOwn(input, "fullAccessPermission")) {
    if (platform !== "win32") throw new Error("完整访问权限仅在 Windows 上可用");
    if (typeof input["fullAccessPermission"] !== "boolean") throw new Error("完整访问权限设置无效");
    patch.fullAccessPermission = input["fullAccessPermission"];
  }
  if (Object.hasOwn(input, "minimizeToTray")) {
    if (typeof input["minimizeToTray"] !== "boolean") throw new Error("后台运行设置无效");
    patch.minimizeToTray = input["minimizeToTray"];
  }
  if (Object.hasOwn(input, "launchAtLogin")) {
    if (typeof input["launchAtLogin"] !== "boolean") throw new Error("开机启动设置无效");
    patch.launchAtLogin = input["launchAtLogin"];
  }
  if (Object.hasOwn(input, "theme")) {
    if (input["theme"] !== "system" && input["theme"] !== "dark" && input["theme"] !== "light") throw new Error("主题设置无效");
    patch.theme = input["theme"];
  }
  if (Object.hasOwn(input, "workspaceSort")) {
    if (input["workspaceSort"] !== "recent" && input["workspaceSort"] !== "name") throw new Error("工作区排序设置无效");
    patch.workspaceSort = input["workspaceSort"];
  }
  if (Object.hasOwn(input, "terminalFontFamily")) {
    if (typeof input["terminalFontFamily"] !== "string" || !input["terminalFontFamily"].trim() || input["terminalFontFamily"].trim().length > 200) throw new Error("终端字体设置无效");
    patch.terminalFontFamily = input["terminalFontFamily"].trim();
  }
  if (Object.hasOwn(input, "terminalFontSize")) {
    if (typeof input["terminalFontSize"] !== "number" || !Number.isInteger(input["terminalFontSize"]) || input["terminalFontSize"] < 8 || input["terminalFontSize"] > 48) throw new Error("终端字号设置无效");
    patch.terminalFontSize = input["terminalFontSize"];
  }
  if (Object.hasOwn(input, "daemonBind")) {
    if (typeof input["daemonBind"] !== "string" || !validIpv4(input["daemonBind"].trim())) throw new Error("监听地址无效");
    patch.daemonBind = input["daemonBind"].trim();
  }
  return patch;
}
