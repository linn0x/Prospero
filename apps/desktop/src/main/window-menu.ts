import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { WindowMenuAction, WindowMenuRequest } from "../shared/window-menu";

/** Use native menus and native window buttons on Windows/Linux. macOS uses its menu bar. */
export function popupWindowMenu(window: BrowserWindow, request: WindowMenuRequest): Promise<WindowMenuAction | null> {
  if (process.platform === "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = (zh: string, en: string): string => request.language === "zh" ? zh : en;
    const action = (label: string, value: WindowMenuAction): MenuItemConstructorOptions => ({ label, click: () => resolve(value) });
    const templates: Record<WindowMenuRequest["menu"], MenuItemConstructorOptions[]> = {
      file: [action(t("新建会话", "New session"), "new-session"), action(t("设置", "Settings"), "settings"), { type: "separator" }, { label: t("关闭窗口", "Close window"), role: "close" }, { label: t("退出 Prospero", "Quit Prospero"), role: "quit" }],
      edit: [{ label: t("撤销", "Undo"), role: "undo" }, { label: t("重做", "Redo"), role: "redo" }, { type: "separator" }, { label: t("剪切", "Cut"), role: "cut" }, { label: t("复制", "Copy"), role: "copy", registerAccelerator: false }, { label: t("粘贴", "Paste"), role: "paste", registerAccelerator: false }, { label: t("全选", "Select all"), role: "selectAll", registerAccelerator: false }],
      view: [action(t("切换侧边栏", "Toggle sidebar"), "toggle-sidebar"), action(t("命令面板", "Command palette"), "command"), { type: "separator" }, { label: t("实际大小", "Actual size"), role: "resetZoom" }, { label: t("放大", "Zoom in"), role: "zoomIn" }, { label: t("缩小", "Zoom out"), role: "zoomOut" }, { type: "separator" }, { label: t("切换全屏", "Toggle fullscreen"), role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }])],
      help: [{ label: t("关于 Prospero", "About Prospero"), role: "about" }],
    };
    Menu.buildFromTemplate(templates[request.menu]).popup({ window, x: request.x, y: request.y, callback: () => resolve(null) });
  });
}
