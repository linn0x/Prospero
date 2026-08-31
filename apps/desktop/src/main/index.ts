import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray } from "electron";
import type { MenuItemConstructorOptions, Rectangle } from "electron";
import type { DesktopSettings, JsonObject, SessionCreateInput, WorkflowTemplate } from "../shared/types";
import { diffDesktopSnapshot, isEmptyDesktopSnapshotPatch } from "../shared/snapshot-patch";
import { isSessionLaunchWorkspace } from "../shared/session-launch-options";
import { loginPath, resolveNodeExecutable } from "./host-environment.js";
import { DaemonRuntime } from "./daemon-runtime";
import { StateStore } from "./state-store";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const ORCHESTRATION_METHODS = new Set([
  "run.create", "run.complete", "run.abandon", "run.delete",
  "task.create", "task.cancel", "task.retry",
  "worker.start", "worker.stop",
  "graph.create", "graph.apply",
  "automation.start", "automation.pause",
  "worktree.inspect", "worktree.cleanup",
]);
const INTERACTION_TYPES = new Set([
  "chat.send", "term.input", "term.resize", "permission.respond",
  "question.respond", "approval.policy.set",
]);
const ACCOUNT_METHODS = new Set([
  "agent.accounts.list", "agent.account.create", "agent.account.api.create",
  "agent.account.api.configure", "agent.account.rename", "agent.account.default",
  "agent.account.login", "agent.account.credential.set", "agent.account.logout",
  "agent.account.delete",
]);
const SMOKE_TEST = process.argv.includes("--smoke-test");
const SELF_CHECK = process.argv.includes("--self-check");
const START_HIDDEN = process.argv.includes("--background") || SMOKE_TEST;
if (SMOKE_TEST) app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let previousPendingInteractions = 0;
let lastBroadcastSnapshot: ReturnType<StateStore["snapshot"]> | undefined;
let lastBroadcastWindowId: number | undefined;
let windowStateTimer: ReturnType<typeof setTimeout> | undefined;
const store = new StateStore();
const runtime = new DaemonRuntime(store);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", () => {
  showMainWindow();
});

interface PersistedWindowState extends Rectangle {
  maximized?: boolean;
}

const DEFAULT_WINDOW_WIDTH = 1480;
const DEFAULT_WINDOW_HEIGHT = 920;
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 560;

function readWindowState(): PersistedWindowState | undefined {
  try {
    const value = JSON.parse(readFileSync(resolve(app.getPath("userData"), "window-state.json"), "utf8")) as Partial<PersistedWindowState>;
    if (![value.x, value.y, value.width, value.height].every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
    if (Number(value.width) <= 0 || Number(value.height) <= 0) return undefined;
    return value as PersistedWindowState;
  } catch {
    return undefined;
  }
}

function visibleWindowState(saved: PersistedWindowState | undefined): PersistedWindowState {
  const candidate = saved ?? screen.getPrimaryDisplay().workArea;
  const workArea = (saved ? screen.getDisplayMatching(candidate) : screen.getPrimaryDisplay()).workArea;
  const minWidth = Math.min(MIN_WINDOW_WIDTH, workArea.width);
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, workArea.height);
  const width = Math.min(workArea.width, Math.max(minWidth, saved?.width ?? DEFAULT_WINDOW_WIDTH));
  const height = Math.min(workArea.height, Math.max(minHeight, saved?.height ?? DEFAULT_WINDOW_HEIGHT));
  const centeredX = workArea.x + Math.round((workArea.width - width) / 2);
  const centeredY = workArea.y + Math.round((workArea.height - height) / 2);
  const x = Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, saved?.x ?? centeredX));
  const y = Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, saved?.y ?? centeredY));
  return { x, y, width, height, ...(saved?.maximized ? { maximized: true } : {}) };
}

function persistWindowState(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  const bounds = window.getNormalBounds();
  try {
    writeFileSync(resolve(app.getPath("userData"), "window-state.json"), JSON.stringify({ ...bounds, maximized: window.isMaximized() } satisfies PersistedWindowState));
  } catch {
    // Window placement is a convenience; a read-only profile must not block shutdown.
  }
}

function scheduleWindowStateSave(window: BrowserWindow): void {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = undefined;
    persistWindowState(window);
  }, 250);
  windowStateTimer.unref();
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} 无效`);
  return value;
}

function requireSelection(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} 无效`);
  const selection = value.trim();
  if (!selection || selection.length > max || /[\u0000-\u001f\u007f]/.test(selection)) throw new Error(`${label} 无效`);
  return selection;
}

function requireObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("参数格式无效");
  return value as JsonObject;
}

function applyTheme(settings: DesktopSettings): void {
  nativeTheme.themeSource = settings.theme;
  const dark = nativeTheme.shouldUseDarkColors;
  if (mainWindow && !mainWindow.isDestroyed()) {
    // setTitleBarOverlay 只存在于 Windows/Linux —— macOS 上窗口控件是系统画的
    // 红黄绿,没有可着色的 overlay。不加这个判断,每次切换主题都会抛
    // "setTitleBarOverlay is not a function",而它发生在主进程里,
    // 界面上只会看到一条没头没尾的报错。
    if (process.platform !== "darwin") {
      mainWindow.setTitleBarOverlay({
        color: dark ? "#161619" : "#f8f8f9",
        symbolColor: dark ? "#eeeef0" : "#202024",
        height: 42,
      });
    }
    mainWindow.setBackgroundColor(dark ? "#111114" : "#f4f4f5");
  }
}

function broadcastSnapshot(snapshot: ReturnType<StateStore["snapshot"]> = store.snapshot()): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (snapshot === lastBroadcastSnapshot && mainWindow.id === lastBroadcastWindowId) return;
  const patch = mainWindow.id === lastBroadcastWindowId
    ? diffDesktopSnapshot(lastBroadcastSnapshot, snapshot)
    : diffDesktopSnapshot(undefined, snapshot);
  lastBroadcastSnapshot = snapshot;
  lastBroadcastWindowId = mainWindow.id;
  if (isEmptyDesktopSnapshotPatch(patch)) return;
  mainWindow.webContents.send("snapshot:changed", patch);
  const pending = snapshot.daemon.sessions.reduce((total, session) => total + (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0), 0);
  const active = snapshot.daemon.sessions.some((session) => session.status === "running" || session.status === "starting");
  mainWindow.setProgressBar(pending > 0 ? 1 : active ? 2 : -1, { mode: pending > 0 ? "paused" : active ? "indeterminate" : "none" });
  if (pending > previousPendingInteractions) {
    mainWindow.flashFrame(true);
    if (Notification.isSupported()) new Notification({ title: "Prospero 等待你的处理", body: `${String(pending)} 个审批或问题需要处理`, silent: false }).show();
  }
  previousPendingInteractions = pending;
  refreshTrayMenu();
}

function createWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const placement = visibleWindowState(readWindowState());
  const display = screen.getDisplayMatching(placement);
  const window = new BrowserWindow({
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    minWidth: Math.min(MIN_WINDOW_WIDTH, display.workArea.width),
    minHeight: Math.min(MIN_WINDOW_HEIGHT, display.workArea.height),
    show: false,
    backgroundColor: dark ? "#111114" : "#f4f4f5",
    title: "Prospero",
    // macOS 的红黄绿按钮固定在窗口左上角,会浮在侧栏头部之上 —— 而这块布局是按
    // Windows 设计的(那边窗口控件在右上角,左上角是空的)。hiddenInset 把按钮往内缩,
    // 再显式给一个与侧栏头部垂直居中的位置;渲染层那边相应留出上边距。
    // titleBarOverlay 只对 Windows/Linux 生效,macOS 传了也会被忽略。
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 18 } }
      : { titleBarOverlay: { color: dark ? "#161619" : "#f8f8f9", symbolColor: dark ? "#eeeef0" : "#202024", height: 42 } }),
    webPreferences: {
      preload: resolve(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (SMOKE_TEST) window.webContents.on("console-message", (details) => process.stderr.write(`[renderer:${details.level}] ${details.message}\n`));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.once("ready-to-show", () => { if (!START_HIDDEN) window.show(); });
  if (placement.maximized) window.maximize();
  window.on("move", () => scheduleWindowStateSave(window));
  window.on("resize", () => scheduleWindowStateSave(window));
  window.on("close", (event) => {
    persistWindowState(window);
    if (!quitting && store.snapshot().settings.minimizeToTray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
    if (!quitting && !store.snapshot().settings.minimizeToTray) {
      quitting = true;
      app.quit();
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(resolve(__dirname, "../renderer/index.html"));
  }
  return window;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  const window = mainWindow;
  const reveal = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  if (window.webContents.isLoading()) window.once("ready-to-show", reveal);
  else reveal();
}

function createTray(): void {
  if (tray) return;
  const iconPath = app.isPackaged
    ? resolve(process.resourcesPath, "assets", "AppIcon.png")
    : resolve(app.getAppPath(), "..", "shell", "Resources", "AppIcon-1024.png");
  const source = nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) return;
  // macOS 菜单栏图标必须是模板图:系统按明暗自动反色。不标记的话深色菜单栏上
  // 会挂着一块彩色方块,和其它菜单栏项格格不入。
  // macOS 会从原图创建适合当前菜单栏 scale factor 的 image representation。
  // 先缩成单一 16px 位图会让 Retina 菜单栏只能插值放大，笔画明显发糊。
  const icon = process.platform === "darwin"
    ? source
    : source.resize({ width: 16, height: 16 });
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Prospero · Agent 工作台");
  refreshTrayMenu();
  tray.on("double-click", showMainWindow);
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Prospero", click: showMainWindow },
    { label: "启动 daemon", click: () => void runtime.start() },
    { label: "重启 daemon", click: () => void runtime.restart(), enabled: runtime.managed },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") return;
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      role: "editMenu",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" },
        { role: "delete" }, { role: "selectAll" },
      ],
    },
    {
      role: "viewMenu",
      submenu: [
        ...(app.isPackaged ? [] : [{ role: "reload" as const }, { role: "toggleDevTools" as const }, { type: "separator" as const }]),
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function runDesktopSelfCheck(window: BrowserWindow): Promise<void> {
  const smoke = SMOKE_TEST;
  const screenshotArg = process.argv.find((argument) => argument.startsWith("--screenshot="));
  if (!smoke && !screenshotArg) return;
  if (window.webContents.isLoading()) {
    await new Promise<void>((done) => window.webContents.once("did-finish-load", () => done()));
  }
  await new Promise((done) => setTimeout(done, 600));
  const bridgeReady = await window.webContents.executeJavaScript("typeof window.prospero?.getSnapshot === 'function'") as boolean;
  if (!bridgeReady) throw new Error("preload bridge is unavailable");
  if (screenshotArg) {
    const screenshotView = process.argv.find((argument) => argument.startsWith("--screenshot-view="))?.slice("--screenshot-view=".length);
    if (screenshotView === "settings") {
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-sidebar="menu-button"]')).find((button) => button.textContent?.includes('设置') || button.textContent?.includes('Settings'))?.click()`);
      const settingsReady = await window.webContents.executeJavaScript(`new Promise((resolve) => { const started = Date.now(); const check = () => document.querySelector('.settings-page') ? resolve(true) : Date.now() - started > 5_000 ? resolve(false) : setTimeout(check, 100); check(); })`) as boolean;
      if (!settingsReady) throw new Error("settings page did not finish loading");
      await new Promise((done) => setTimeout(done, 250));
    }
    if (screenshotView === "workspaces") {
      const workspaceReady = await window.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms));
        let session = document.querySelector('.workspace-session-link');
        if (!session) {
          document.querySelector('.workspace-project-button')?.click();
          await wait(180);
          session = document.querySelector('.workspace-session-link');
        }
        if (!session) return false;
        session.click();
        const started = Date.now();
        while (!document.querySelector('.workspace-tab-main')) {
          if (Date.now() - started > 5_000) return false;
          await wait(100);
        }
        await wait(250);
        return true;
      })()` ) as boolean;
      if (!workspaceReady) throw new Error("workspace page did not finish loading");
      const workspaceStyles = await window.webContents.executeJavaScript(`(() => {
        const inspect = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return { found: false };
          const style = getComputedStyle(element);
          const svg = element.querySelector('svg');
          const svgRect = svg?.getBoundingClientRect();
          return {
            found: true,
            borderWidth: style.borderWidth,
            boxShadow: style.boxShadow,
            padding: style.padding,
            svgWidth: svgRect?.width ?? 0,
            svgHeight: svgRect?.height ?? 0,
            svgClass: svg?.getAttribute('class') ?? '',
          };
        };
        const result = {
          sessionPin: inspect('[data-testid="workspace-session-pin"]'),
          tabMain: inspect('.workspace-tab-main'),
          tabPin: inspect('[data-testid="workspace-tab-pin"]'),
          tabClose: inspect('[data-testid="workspace-tab-close"]'),
          agentLogo: inspect('.workspace-session-link .session-agent-icon'),
        };
        const controls = [result.sessionPin, result.tabMain, result.tabPin, result.tabClose];
        return {
          ...result,
          healthy: controls.every((item) => item.found && item.borderWidth === '0px' && item.boxShadow === 'none' && item.svgWidth >= 12 && item.svgHeight >= 12)
            && result.agentLogo.found && result.agentLogo.svgClass.includes('agent-logo'),
        };
      })()`);
      if (!workspaceStyles.healthy) throw new Error(`workspace chrome rendering failed: ${JSON.stringify(workspaceStyles)}`);
      process.stdout.write(`Prospero workspace styles: ${JSON.stringify(workspaceStyles)}\n`);
    }
    const path = screenshotArg.slice("--screenshot=".length);
    if (!isAbsolute(path)) throw new Error("screenshot path must be absolute");
    writeFileSync(path, (await window.webContents.capturePage()).toPNG());
  }
  const sidebarMenuCheck = await window.webContents.executeJavaScript(`(async () => {
    const openAndCheck = async (selector) => {
      const trigger = document.querySelector(selector);
      if (!trigger) return { selector, skipped: selector === '[data-testid="workspace-project-more"]', found: false, popup: false, healthyRoot: Boolean(document.querySelector('#root')?.childElementCount) };
      trigger.click();
      await new Promise((done) => setTimeout(done, 120));
      const popup = document.querySelector('[data-slot="dropdown-menu-content"]');
      const root = document.querySelector('#root');
      const healthyRoot = Boolean(root && root.childElementCount > 0);
      trigger.click();
      await new Promise((done) => setTimeout(done, 60));
      return { selector, skipped: false, found: true, popup: Boolean(popup), healthyRoot };
    };
    const mobileViewport = matchMedia('(max-width: 767px)').matches;
    let sidebar;
    let rail;
    let mobileTrigger;
    const controlsStarted = Date.now();
    do {
      sidebar = document.querySelector('[data-slot="sidebar"][data-state]');
      rail = document.querySelector('[data-testid="sidebar-rail"]');
      mobileTrigger = document.querySelector('[data-slot="sidebar-trigger"]');
      const controlsReady = mobileViewport
        ? Boolean(mobileTrigger && !sidebar)
        : Boolean(sidebar && rail);
      if (controlsReady || Date.now() - controlsStarted > 2_000) break;
      await new Promise((done) => setTimeout(done, 50));
    } while (true);
    let sidebarToggle;
    if (!mobileViewport && sidebar && rail) {
      // Compact desktop layouts intentionally start in icon mode. Expand them
      // before exercising controls that are hidden while collapsed.
      if (sidebar.getAttribute('data-state') === 'collapsed') {
        rail.click();
        await new Promise((done) => setTimeout(done, 240));
      }
      const before = sidebar.getAttribute('data-state') ?? '';
      rail.click();
      await new Promise((done) => setTimeout(done, 240));
      const after = sidebar.getAttribute('data-state') ?? '';
      rail.click();
      await new Promise((done) => setTimeout(done, 240));
      const restored = sidebar.getAttribute('data-state') ?? '';
      sidebarToggle = { mode: 'desktop', found: true, before, after, restored, ready: restored };
    } else {
      // A hosted runner can constrain the 760px minimum window below the
      // component's 768px mobile breakpoint. Exercise the sheet trigger in
      // that layout and leave the sheet open for the menu checks below.
      const mobileState = () => {
        const panel = document.querySelector('[data-slot="sidebar"][data-mobile="true"]');
        if (!panel) return 'closed';
        const state = panel.getAttribute('data-state');
        if (state === 'open' || state === 'closed') return state;
        const style = getComputedStyle(panel);
        const rect = panel.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 ? 'open' : 'closed';
      };
      const before = mobileState();
      if (before !== 'open') mobileTrigger?.click();
      const openStarted = Date.now();
      while (mobileState() !== 'open' && Date.now() - openStarted <= 1_000) {
        await new Promise((done) => setTimeout(done, 50));
      }
      const after = mobileState();
      // The modal sheet makes the page root inert while open, so its original
      // trigger cannot be used as a close control. Keep it open for the menu,
      // footer and daemon interactions that follow.
      sidebarToggle = { mode: 'mobile', found: Boolean(mobileTrigger), before, after, ready: mobileState() };
    }
    const contextTrigger = document.querySelector('[data-slot="context-menu-trigger"]');
    let context = { skipped: !contextTrigger, popup: false, healthyRoot: Boolean(document.querySelector('#root')?.childElementCount) };
    if (contextTrigger) {
      const bounds = contextTrigger.getBoundingClientRect();
      contextTrigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: bounds.left + 8, clientY: bounds.top + 8 }));
      await new Promise((done) => setTimeout(done, 120));
      context = { skipped: false, popup: Boolean(document.querySelector('[data-slot="context-menu-content"]')), healthyRoot: Boolean(document.querySelector('#root')?.childElementCount) };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    const group = await openAndCheck('[data-testid="workspace-more"]');
    const project = await openAndCheck('[data-testid="workspace-project-more"]');
    const directoryButton = document.querySelector('.workspace-project-button');
    const directoryMore = document.querySelector('[data-testid="workspace-project-more"]');
    const directoryCount = document.querySelector('.workspace-session-count');
    directoryButton?.focus();
    await new Promise((done) => setTimeout(done, 60));
    const directoryFocus = directoryButton && directoryMore && directoryCount
      ? { skipped: false, moreOpacity: getComputedStyle(directoryMore).opacity, countOpacity: getComputedStyle(directoryCount).opacity }
      : { skipped: true, moreOpacity: '', countOpacity: '' };
    directoryButton?.blur();
    const pinFixture = document.createElement('div');
    pinFixture.className = 'prospero-sidebar';
    pinFixture.style.cssText = 'position:fixed;left:-10000px;top:0;';
    pinFixture.innerHTML = '<div data-sidebar="menu-item"><button class="session-pin-action is-pinned"></button></div><div class="workspace-session-item"><button class="workspace-session-pin is-pinned"></button></div>';
    document.body.append(pinFixture);
    const pinnedAreaPin = pinFixture.querySelector('.session-pin-action');
    const workspacePin = pinFixture.querySelector('.workspace-session-pin');
    const pinVisibility = {
      pinnedAreaOpacity: pinnedAreaPin ? getComputedStyle(pinnedAreaPin).opacity : '',
      workspaceOpacity: workspacePin ? getComputedStyle(workspacePin).opacity : '',
    };
    pinFixture.remove();
    const footerItems = Array.from(document.querySelectorAll('.sidebar-footer-actions > [data-sidebar="menu-item"]'));
    const footerRects = footerItems.map((item) => item.getBoundingClientRect());
    const footer = {
      count: footerItems.length,
      sameRow: footerRects.length === 2 && Math.abs(footerRects[0].top - footerRects[1].top) < 1,
      daemonText: footerItems[0]?.textContent ?? '',
    };
    return {
      group,
      project,
      rail: sidebarToggle,
      viewport: { width: innerWidth, mobile: mobileViewport },
      context,
      directoryFocus,
      pinVisibility,
      footer,
    };
  })()`) as { group: { skipped: boolean; found: boolean; popup: boolean; healthyRoot: boolean }; project: { skipped: boolean; found: boolean; popup: boolean; healthyRoot: boolean }; rail: { mode: "desktop" | "mobile"; found: boolean; before: string; after: string; restored?: string; ready: string }; viewport: { width: number; mobile: boolean }; context: { skipped: boolean; popup: boolean; healthyRoot: boolean }; directoryFocus: { skipped: boolean; moreOpacity: string; countOpacity: string }; pinVisibility: { pinnedAreaOpacity: string; workspaceOpacity: string }; footer: { count: number; sameRow: boolean; daemonText: string } };
  const sidebarToggleReady = sidebarMenuCheck.rail.mode === "desktop"
    ? sidebarMenuCheck.rail.found && sidebarMenuCheck.rail.before !== sidebarMenuCheck.rail.after && sidebarMenuCheck.rail.before === sidebarMenuCheck.rail.restored && sidebarMenuCheck.rail.ready === "expanded"
    : sidebarMenuCheck.rail.found && (sidebarMenuCheck.rail.before === "open" || sidebarMenuCheck.rail.after === "open") && sidebarMenuCheck.rail.ready === "open";
  const sidebarMenusReady = sidebarMenuCheck.group.found && sidebarMenuCheck.group.popup && sidebarMenuCheck.group.healthyRoot
    && (sidebarMenuCheck.project.skipped || (sidebarMenuCheck.project.found && sidebarMenuCheck.project.popup && sidebarMenuCheck.project.healthyRoot))
    && sidebarToggleReady
    && (sidebarMenuCheck.context.skipped || (sidebarMenuCheck.context.popup && sidebarMenuCheck.context.healthyRoot))
    && (sidebarMenuCheck.directoryFocus.skipped || (sidebarMenuCheck.directoryFocus.moreOpacity === "0" && sidebarMenuCheck.directoryFocus.countOpacity === "1"))
    && sidebarMenuCheck.pinVisibility.pinnedAreaOpacity === "0"
    && sidebarMenuCheck.pinVisibility.workspaceOpacity === "0"
    && sidebarMenuCheck.footer.count === 2 && sidebarMenuCheck.footer.sameRow
    && !sidebarMenuCheck.footer.daemonText.includes("127.0.0.1");
  if (!sidebarMenusReady) throw new Error(`workspace sidebar menu interaction failed: ${JSON.stringify(sidebarMenuCheck)}`);
  if (smoke) process.stdout.write(`Prospero desktop interactions: ${JSON.stringify(sidebarMenuCheck)}\n`);
  if (smoke) {
    window.showInactive();
    await new Promise((done) => setTimeout(done, 120));
    const pinnedTarget = await window.webContents.executeJavaScript(`(() => {
      const action = document.querySelector('.session-pin-action');
      const item = action?.closest('[data-sidebar="menu-item"]');
      if (!action || !item) return null;
      const actionRect = action.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      return {
        row: { x: itemRect.x + 12, y: itemRect.y + itemRect.height / 2 },
        action: { x: actionRect.x + actionRect.width / 2, y: actionRect.y + actionRect.height / 2 },
      };
    })()` ) as { row: { x: number; y: number }; action: { x: number; y: number } } | null;
    if (pinnedTarget) {
      window.webContents.sendInputEvent({ type: "mouseMove", x: 1_200, y: 72 });
      await new Promise((done) => setTimeout(done, 180));
    }
    const pinnedDefaultOpacity = pinnedTarget
      ? await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.session-pin-action')).opacity`) as string
      : "";
    if (pinnedTarget) {
      window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(pinnedTarget.row.x), y: Math.round(pinnedTarget.row.y) });
      await new Promise((done) => setTimeout(done, 180));
    }
    const pinnedRowStyle = pinnedTarget
      ? await window.webContents.executeJavaScript(`(() => { const style = getComputedStyle(document.querySelector('.session-pin-action')); return { opacity: style.opacity, color: style.color }; })()`) as { opacity: string; color: string }
      : undefined;
    if (pinnedTarget) {
      window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(pinnedTarget.action.x), y: Math.round(pinnedTarget.action.y) });
      await new Promise((done) => setTimeout(done, 180));
    }
    const pinnedActionStyle = pinnedTarget
      ? await window.webContents.executeJavaScript(`(() => { const style = getComputedStyle(document.querySelector('.session-pin-action')); return { opacity: style.opacity, color: style.color }; })()`) as { opacity: string; color: string }
      : undefined;
    const pinnedHover = {
      skipped: !pinnedTarget,
      defaultOpacity: pinnedDefaultOpacity,
      rowOpacity: pinnedRowStyle?.opacity ?? "",
      rowColor: pinnedRowStyle?.color ?? "",
      actionOpacity: pinnedActionStyle?.opacity ?? "",
      actionColor: pinnedActionStyle?.color ?? "",
    };
    if (!pinnedHover.skipped && (pinnedHover.defaultOpacity !== "0" || pinnedHover.rowOpacity !== "1" || pinnedHover.actionOpacity !== "1" || pinnedHover.rowColor === pinnedHover.actionColor)) {
      throw new Error(`pinned session hover interaction failed: ${JSON.stringify(pinnedHover)}`);
    }
    process.stdout.write(`Prospero pinned session hover: ${JSON.stringify(pinnedHover)}\n`);
    const daemonRect = await window.webContents.executeJavaScript(`(() => {
      const daemon = document.querySelector('[data-testid="sidebar-daemon"]');
      if (!daemon) return null;
      const rect = daemon.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()` ) as { x: number; y: number } | null;
    if (daemonRect) {
      window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(daemonRect.x), y: Math.round(daemonRect.y) });
      await new Promise((done) => setTimeout(done, 420));
    }
    const daemonInteraction = await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      const daemon = document.querySelector('[data-testid="sidebar-daemon"]');
      if (!daemon) return { trigger: false, card: false, settings: false, healthyRoot: false };
      const card = Boolean(document.querySelector('[data-slot="hover-card-content"]'));
      const settings = Array.from(document.querySelectorAll('[data-sidebar="menu-button"]'))
        .find((button) => button.textContent?.includes('设置') || button.textContent?.includes('Settings'));
      settings?.click();
      const started = Date.now();
      while (!document.querySelector('.settings-page')) {
        if (Date.now() - started > 5_000) break;
        await wait(100);
      }
      const root = document.querySelector('#root');
      return {
        trigger: true,
        card,
        settings: Boolean(document.querySelector('.settings-page')),
        healthyRoot: Boolean(root && root.childElementCount > 0),
      };
    })()` ) as { trigger: boolean; card: boolean; settings: boolean; healthyRoot: boolean };
    if (!daemonInteraction.trigger || !daemonInteraction.card || !daemonInteraction.settings || !daemonInteraction.healthyRoot) {
      throw new Error(`daemon sidebar interaction failed: ${JSON.stringify(daemonInteraction)}`);
    }
    process.stdout.write(`Prospero daemon interaction: ${JSON.stringify(daemonInteraction)}\n`);
  }
  if (smoke) {
    process.stdout.write("Prospero desktop smoke test passed\n");
    quitting = true;
    tray?.destroy();
    tray = undefined;
    window.destroy();
    app.quit();
  }
}

function installIpc(): void {
  ipcMain.handle("snapshot:get", () => store.snapshot());
  ipcMain.handle("daemon:start", () => runtime.start());
  ipcMain.handle("daemon:stop", () => runtime.stop());
  ipcMain.handle("daemon:restart", () => runtime.restart());
  ipcMain.handle("project:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: "添加项目", properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    store.rememberProject(result.filePaths[0]);
    return result.filePaths[0];
  });
  ipcMain.handle("project:forget", (_event, path: unknown) => {
    if (typeof path !== "string") throw new Error("路径无效");
    return store.forgetProject(path);
  });
  ipcMain.handle("project:rename", (_event, path: unknown, name: unknown) => {
    if (typeof path !== "string" || typeof name !== "string") throw new Error("工作区名称无效");
    return store.renameProject(path, name);
  });
  ipcMain.handle("project:pin", (_event, path: unknown, pinned: unknown) => {
    if (typeof path !== "string" || typeof pinned !== "boolean") throw new Error("工作区置顶状态无效");
    return store.setProjectPinned(path, pinned);
  });
  ipcMain.handle("session:rename", (_event, rawId: unknown, rawTitle: unknown) => {
    const sessionId = requireId(rawId, "会话");
    if (typeof rawTitle !== "string") throw new Error("会话名称无效");
    return store.renameSession(sessionId, rawTitle);
  });
  ipcMain.handle("session:pin", (_event, rawId: unknown, pinned: unknown) => {
    const sessionId = requireId(rawId, "会话");
    if (typeof pinned !== "boolean") throw new Error("置顶状态无效");
    if (!store.snapshot().daemon.sessions.some((session) => session.id === sessionId)) throw new Error("会话不存在");
    return store.setSessionPinned(sessionId, pinned);
  });
  ipcMain.handle("session:unread", (_event, rawId: unknown, unread: unknown) => {
    const sessionId = requireId(rawId, "会话");
    if (typeof unread !== "boolean") throw new Error("会话未读状态无效");
    return store.setSessionUnread(sessionId, unread);
  });
  ipcMain.handle("skills:list", async (_event, rawCwd: unknown) => {
    if (typeof rawCwd !== "string") throw new Error("工作区路径无效");
    const cwd = resolve(rawCwd);
    if (!store.snapshot().projects.some((project) => project.toLocaleLowerCase() === cwd.toLocaleLowerCase())) throw new Error("只能查看已添加工作区的 Skills");
    const result = await runtime.request(`/_prospero/control/skills?cwd=${encodeURIComponent(cwd)}`);
    return Array.isArray(result?.["items"]) ? result["items"] : [];
  });
  ipcMain.handle("skills:reveal", async (_event, rawPath: unknown, rawCwd: unknown) => {
    if (typeof rawPath !== "string" || typeof rawCwd !== "string" || !isAbsolute(rawPath)) throw new Error("Skill 路径无效");
    const cwd = resolve(rawCwd);
    if (!store.snapshot().projects.some((project) => project.toLocaleLowerCase() === cwd.toLocaleLowerCase())) throw new Error("工作区路径无效");
    const result = await runtime.request(`/_prospero/control/skills?cwd=${encodeURIComponent(cwd)}`);
    const items = Array.isArray(result?.["items"]) ? result["items"] : [];
    if (!items.some((item) => item && typeof item === "object" && String((item as JsonObject)["path"]) === rawPath)) throw new Error("Skill 不属于当前工作区的有效目录");
    shell.showItemInFolder(rawPath);
    return { ok: true };
  });
  ipcMain.handle("workflow-template:save", (_event, raw: unknown) => {
    return store.saveWorkflowTemplate(requireObject(raw) as unknown as WorkflowTemplate);
  });
  ipcMain.handle("workflow-template:delete", (_event, rawId: unknown) => {
    return store.deleteWorkflowTemplate(requireId(rawId, "模板"));
  });
  ipcMain.handle("network:interfaces", () => {
    // 监听地址要能选具体网卡:手机走 LAN 直连时,绑到某一张网卡比 0.0.0.0
    // 更容易排查(尤其同时挂着 WireGuard 之类的虚拟网卡时)。
    const interfaces = networkInterfaces();
    const candidates: Array<{ label: string; address: string }> = [];
    for (const [name, entries] of Object.entries(interfaces)) {
      for (const entry of entries ?? []) {
        if (entry.family !== "IPv4" || entry.internal) continue;
        candidates.push({ label: `${name} · ${entry.address}`, address: entry.address });
      }
    }
    return candidates;
  });
  ipcMain.handle("path:reveal", async (_event, path: unknown) => {
    if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path) || !store.isKnownPath(path)) return { ok: false, error: "路径不属于当前项目、会话或 worktree" };
    shell.showItemInFolder(path);
    return { ok: true };
  });
  ipcMain.handle("path:terminal", async (_event, path: unknown) => {
    if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path) || !store.isKnownPath(path)) return { ok: false, error: "路径不属于当前工作区" };
    if (process.platform === "darwin") {
      // `open -a Terminal <dir>` 走 LaunchServices,不需要知道终端装在哪,
      // 用户把默认终端换成 iTerm 之类也不影响这条路径。
      return await new Promise<{ ok: boolean; error?: string }>((complete) => {
        const child = spawn("/usr/bin/open", ["-a", "Terminal", path], { cwd: path, detached: true, stdio: "ignore" });
        child.once("error", (error) => complete({ ok: false, error: error.message }));
        child.once("spawn", () => { child.unref(); complete({ ok: true }); });
      });
    }
    const alias = process.env["LOCALAPPDATA"]
      ? resolve(process.env["LOCALAPPDATA"], "Microsoft", "WindowsApps", "wt.exe")
      : undefined;
    const candidates = [...new Set([alias, "wt.exe"].filter((candidate): candidate is string => Boolean(candidate)))];
    let lastError = "未找到 Windows Terminal";
    for (const executable of candidates) {
      if (isAbsolute(executable) && !existsSync(executable)) continue;
      const result = await new Promise<{ ok: boolean; error?: string }>((complete) => {
        const child = spawn(executable, ["-d", path], { cwd: path, detached: true, windowsHide: false, stdio: "ignore" });
        child.once("error", (error) => complete({ ok: false, error: error.message }));
        child.once("spawn", () => { child.unref(); complete({ ok: true }); });
      });
      if (result.ok) return result;
      lastError = result.error ?? lastError;
    }
    return { ok: false, error: `无法打开 Windows Terminal：${lastError}。请从 Microsoft Store 安装或修复 Windows Terminal。` };
  });
  ipcMain.handle("session:create", async (_event, raw: unknown) => {
    const input = requireObject(raw) as SessionCreateInput;
    const normalized = resolve(String(input.cwd ?? ""));
    if (!isSessionLaunchWorkspace(store.snapshot(), normalized)) throw new Error("只能在已添加的项目或可用 worktree 中创建会话");
    if (!["codex", "claude", "deepseek", "opencode", "grok", "trae", "shell"].includes(input.agent)) throw new Error("Agent 无效");
    if (input.kind !== "structured" && input.kind !== "pty") throw new Error("会话类型无效");
    if (!["strict", "standard", "yolo"].includes(input.approvalPolicy)) throw new Error("审批策略无效");
    if (input.command) {
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: "warning", title: "运行自定义终端命令", message: "这个会话将运行自定义命令",
        detail: String(input.command).slice(0, 2_000), buttons: ["取消", "运行"], defaultId: 0, cancelId: 0,
      });
      if (confirmation.response !== 1) throw new Error("已取消运行自定义命令");
    }
    return runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: {
        cwd: normalized,
        agent: input.agent,
        kind: input.kind,
        approvalPolicy: input.approvalPolicy,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.model ? { model: requireSelection(input.model, "模型", 160) } : {}),
        ...(input.effort ? { effort: requireSelection(input.effort, "推理强度", 80) } : {}),
        ...(input.command ? { command: String(input.command).slice(0, 2_000) } : {}),
        ...(input.accountId ? { accountId: requireId(input.accountId, "账号") } : {}),
        cols: Math.max(20, Math.min(500, Number(input.cols) || 120)),
        rows: Math.max(5, Math.min(300, Number(input.rows) || 40)),
      },
    });
  });
  ipcMain.handle("session:view", (_event, rawId: unknown, rawQuery: unknown) => {
    const sessionId = requireId(rawId, "会话");
    const query = rawQuery === undefined ? {} : requireObject(rawQuery);
    const params = new URLSearchParams();
    for (const key of ["knownSeq", "afterSeq", "outputAfterSeq", "waitMs"]) {
      const value = query[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("游标无效");
        params.set(key, String(value));
      }
    }
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/view${params.size ? `?${params}` : ""}`);
  });
  ipcMain.handle("session:interact", (_event, rawId: unknown, rawMessage: unknown) => {
    const sessionId = requireId(rawId, "会话");
    const message = requireObject(rawMessage);
    if (typeof message["type"] !== "string" || !INTERACTION_TYPES.has(message["type"])) throw new Error("不支持的会话操作");
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/interact`, { method: "POST", body: message });
  });
  ipcMain.handle("session:interrupt", (_event, rawId: unknown) => runtime.request(`/_prospero/control/session/${encodeURIComponent(requireId(rawId, "会话"))}/interrupt`, { method: "POST" }));
  ipcMain.handle("session:kill", async (_event, rawId: unknown) => {
    const sessionId = requireId(rawId, "会话");
    if (!store.snapshot().daemon.sessions.some((session) => session.id === sessionId)) throw new Error("会话不存在");
    const confirmation = await dialog.showMessageBox(mainWindow!, { type: "warning", title: "结束会话", message: "结束并删除这个会话？", detail: "运行中的 Agent 将被终止。", buttons: ["取消", "结束会话"], defaultId: 0, cancelId: 0 });
    if (confirmation.response !== 1) return null;
    const result = await runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/kill`, { method: "POST" });
    store.forgetSessionTitle(sessionId);
    return result;
  });
  ipcMain.handle("session:tool-output", (_event, rawId: unknown, rawCallId: unknown) => {
    const sessionId = requireId(rawId, "会话");
    const callId = requireId(rawCallId, "工具调用");
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/tool-output?callId=${encodeURIComponent(callId)}`);
  });
  ipcMain.handle("session:subagent", (_event, rawId: unknown, rawSubagent: unknown) => {
    const sessionId = requireId(rawId, "会话");
    const subagentId = requireId(rawSubagent, "子 Agent");
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(subagentId)}/events`);
  });
  ipcMain.handle("usage:get", (_event, rawId: unknown) => {
    const params = new URLSearchParams();
    if (rawId !== undefined) {
      const sessionId = requireId(rawId, "会话");
      if (!store.snapshot().daemon.sessions.some((session) => session.id === sessionId && session.kind === "structured")) throw new Error("结构化会话不存在");
      params.set("sid", sessionId);
    }
    return runtime.request(`/_prospero/control/usage${params.size ? `?${params}` : ""}`);
  });
  ipcMain.handle("session:suggestions", (_event, rawId: unknown, rawQuery: unknown) => {
    const sessionId = requireId(rawId, "会话");
    if (typeof rawQuery !== "string" || rawQuery.length > 200) throw new Error("Skill 查询无效");
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/suggestions?kind=skill&query=${encodeURIComponent(rawQuery)}`)
      .then((result) => Array.isArray(result?.["items"]) ? result["items"] : []);
  });
  ipcMain.handle("session:modes", (_event, rawId: unknown) => {
    const sessionId = requireId(rawId, "会话");
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/modes`);
  });
  ipcMain.handle("session:mode:set", (_event, rawId: unknown, rawMode: unknown) => {
    const sessionId = requireId(rawId, "会话");
    if (rawMode !== "default" && rawMode !== "plan") throw new Error("会话模式无效");
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/modes`, { method: "POST", body: { mode: rawMode } });
  });
  ipcMain.handle("launch:models", (_event, rawAgent: unknown, rawAccountId: unknown) => {
    if (rawAgent !== "codex" && rawAgent !== "claude" && rawAgent !== "deepseek") throw new Error("Agent 不支持模型目录");
    const params = new URLSearchParams({ agent: rawAgent });
    if (rawAccountId !== undefined) params.set("accountId", requireId(rawAccountId, "账号"));
    return runtime.request(`/_prospero/control/launch/models?${params}`);
  });
  ipcMain.handle("session:models", (_event, rawId: unknown) => {
    const sessionId = requireId(rawId, "会话");
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/models`);
  });
  ipcMain.handle("session:model:set", (_event, rawId: unknown, rawModel: unknown, rawEffort: unknown) => {
    const sessionId = requireId(rawId, "会话");
    const model = requireSelection(rawModel, "模型", 160);
    const effort = rawEffort === undefined ? undefined : requireSelection(rawEffort, "推理强度", 80);
    return runtime.request(`/_prospero/control/session/${encodeURIComponent(sessionId)}/models`, {
      method: "POST",
      body: { model, ...(effort ? { effort } : {}) },
    });
  });
  ipcMain.handle("orchestration:action", async (_event, rawMethod: unknown, rawParams: unknown) => {
    if (typeof rawMethod !== "string" || !ORCHESTRATION_METHODS.has(rawMethod)) throw new Error("不支持的编排操作");
    const params = requireObject(rawParams);
    const snapshot = store.snapshot();
    if ((rawMethod === "worker.start" || rawMethod === "automation.start") && (typeof params["cwd"] !== "string" || !snapshot.projects.some((path) => path.toLocaleLowerCase() === resolve(params["cwd"] as string).toLocaleLowerCase()))) throw new Error("编排只能从已添加的项目启动");
    if (["task.cancel", "task.retry", "worker.start", "worker.stop"].includes(rawMethod)) {
      if (typeof params["taskId"] !== "string" || !snapshot.orchestration.tasks.some((task) => task["id"] === params["taskId"])) throw new Error("任务不存在");
    }
    if (["run.complete", "run.abandon", "run.delete", "task.create", "automation.start", "automation.pause", "graph.apply"].includes(rawMethod)) {
      if (typeof params["runId"] !== "string" || !snapshot.orchestration.runs.some((run) => run["id"] === params["runId"])) throw new Error("Run 不存在");
    }
    if (rawMethod.startsWith("worktree.")) {
      if (typeof params["assetId"] !== "string" || !snapshot.orchestration.worktreeAssets.some((asset) => asset["id"] === params["assetId"])) throw new Error("worktree 资产不存在");
    }
    if ((rawMethod === "run.create" || rawMethod === "graph.create") && params["coordinatorSessionId"] !== undefined) {
      const coordinatorId = requireId(params["coordinatorSessionId"], "协调者会话");
      if (!snapshot.daemon.sessions.some((session) => session.id === coordinatorId && session.kind === "structured")) throw new Error("协调者会话不存在");
    }
    if (rawMethod === "run.delete" || rawMethod === "worktree.cleanup") {
      const confirmation = await dialog.showMessageBox(mainWindow!, { type: "warning", title: rawMethod === "run.delete" ? "删除 Run" : "清理 worktree", message: "确认执行这个不可逆操作？", detail: rawMethod === "worktree.cleanup" ? "仅已通过安全检查的 worktree 可以被清理；分支默认保留。" : "Run 历史将被删除。", buttons: ["取消", "确认"], defaultId: 0, cancelId: 0 });
      if (confirmation.response !== 1) throw new Error("操作已取消");
    }
    return runtime.request("/_prospero/control/orchestration/action", { method: "POST", body: { method: rawMethod, params } });
  });
  ipcMain.handle("orchestration:gate", (_event, rawId: unknown, rawDecision: unknown) => {
    const id = requireId(rawId, "Gate");
    if (!store.snapshot().orchestration.gates.some((gate) => gate["id"] === id)) throw new Error("Gate 不存在");
    if (typeof rawDecision !== "string" || !rawDecision.trim() || rawDecision.length > 2_000) throw new Error("决策无效");
    return runtime.request(`/_prospero/control/orchestration/gate/${encodeURIComponent(id)}/resolve`, { method: "POST", body: { decision: rawDecision.trim() } });
  });
  ipcMain.handle("account:action", async (_event, raw: unknown) => {
    const message = requireObject(raw);
    if (typeof message["type"] !== "string" || !ACCOUNT_METHODS.has(message["type"])) throw new Error("不支持的账号操作");
    if (message["type"] !== "agent.accounts.list" && message["type"] !== "agent.account.create" && message["type"] !== "agent.account.api.create") {
      const accountId = requireId(message["accountId"], "账号");
      const account = store.snapshot().accounts.find((item) => item["id"] === accountId);
      if (!account) throw new Error("账号不存在");
      if (message["type"] === "agent.account.delete") {
        if (account["managed"] !== true) throw new Error("本机默认账号不能删除");
        const confirmation = await dialog.showMessageBox(mainWindow!, { type: "warning", title: "删除 Agent 账号", message: `确认删除“${String(account["name"] ?? accountId)}”？`, detail: "账号的独立凭据与配置将被删除，项目文件不会受到影响。", buttons: ["取消", "确认删除"], defaultId: 0, cancelId: 0 });
        if (confirmation.response !== 1) throw new Error("操作已取消");
      }
    }
    const result = await runtime.request("/_prospero/control/accounts", { method: "POST", body: message });
    if (Array.isArray(result?.["accounts"])) store.setAccounts(result["accounts"]);
    return result;
  });
  ipcMain.handle("device:pair", async (_event, raw: unknown) => {
    const input = requireObject(raw);
    const name = typeof input["name"] === "string" ? input["name"].trim().slice(0, 80) : "Windows device";
    const args = ["pair", "--name", name || "Windows device"];
    if (input["allowShell"] !== true) args.push("--no-shell");
    if (input["allowOrchestration"] !== true) args.push("--no-orchestration");
    const result = await runtime.runCli(args);
    if (result.code !== 0) throw new Error(result.output || "配对失败");
    const uri = result.output.match(/prospero:\/\/\S+/)?.[0];
    return { output: result.output, uri };
  });
  ipcMain.handle("device:revoke", async (_event, rawName: unknown) => {
    if (typeof rawName !== "string" || !rawName.trim()) throw new Error("设备名无效");
    const result = await runtime.runCli(["revoke", rawName.trim()]);
    return { ok: result.code === 0, output: result.output };
  });
  ipcMain.handle("relay:action", async (_event, raw: unknown) => {
    const input = requireObject(raw);
    const action = input["action"];
    if (action !== "status" && action !== "enable" && action !== "disable" && action !== "rotate-key") throw new Error("Relay 操作无效");
    const args = ["relay", action];
    if (action === "status") args.push("--json");
    if (action === "rotate-key") {
      const confirmation = await dialog.showMessageBox(mainWindow!, { type: "warning", title: "轮换 Relay 密钥", message: "所有设备都需要重新配对", buttons: ["取消", "轮换密钥"], defaultId: 0, cancelId: 0 });
      if (confirmation.response !== 1) throw new Error("已取消轮换密钥");
      args.push("--yes");
    }
    if (action === "enable" && typeof input["url"] === "string" && input["url"].trim()) args.push("--url", input["url"].trim());
    const result = await runtime.runCli(args);
    if (result.code !== 0) throw new Error(result.output || "Relay 操作失败");
    if (action === "status") {
      try { return JSON.parse(result.output) as JsonObject; } catch { return { output: result.output }; }
    }
    return { ok: true, output: result.output };
  });
  ipcMain.handle("settings:update", async (_event, raw: unknown) => {
    const patch = requireObject(raw);
    if (patch["fullAccessPermission"] !== undefined && process.platform !== "win32") {
      throw new Error("完整访问权限仅在 Windows 上可用");
    }
    const previous = store.snapshot();
    const next = store.updateSettings(patch);
    applyTheme(next.settings);
    app.setLoginItemSettings({ openAtLogin: next.settings.launchAtLogin, args: ["--background"] });
    if (next.settings.fullAccessPermission !== previous.settings.fullAccessPermission && previous.daemon.running) {
      if (!previous.daemon.managed) {
        store.updateSettings({ fullAccessPermission: previous.settings.fullAccessPermission });
        throw new Error("当前 daemon 由外部进程管理，请先在原启动位置停止它再修改完整访问权限");
      }
      const restarted = await runtime.restart();
      if (!restarted.ok) {
        store.updateSettings({ fullAccessPermission: previous.settings.fullAccessPermission });
        await runtime.start();
        throw new Error(restarted.error || "应用完整访问权限失败");
      }
      return store.snapshot();
    }
    return next;
  });
  ipcMain.handle("logs:clear", () => store.clearLogs());
}

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* The window close handler applies the background-running preference. */ });
app.on("activate", () => {
  showMainWindow();
});

/**
 * 不开窗口的环境自检。
 *
 * GUI 起不来时(找不到 node、daemon 没构建、PROSPERO_HOME 权限不对)界面上
 * 只有一句语焉不详的失败,而这些恰恰都是在终端里一眼能看清的事实。
 */
function runSelfCheck(): void {
  const daemonEntry = runtime.describeRuntime();
  const snapshot = store.snapshot();
  const lines = [
    "Prospero 桌面端自检",
    `  平台:     ${process.platform} ${process.arch}`,
    `  打包:     ${app.isPackaged ? "已打包" : "开发模式"}`,
    `  node:     ${resolveNodeExecutable() ?? "❌ 找不到"}`,
    `  daemon:   ${daemonEntry ?? "❌ 找不到 dist/cli.js"}`,
    `  PATH:     ${loginPath(resolveNodeExecutable()) ?? process.env["PATH"] ?? ""}`,
    `  home:     ${store.home}`,
    `  端口:     ${String(snapshot.daemon.port)}`,
    `  监听:     ${snapshot.settings.daemonBind === "0.0.0.0" ? "全部网卡" : snapshot.settings.daemonBind}`,
    `  运行中:   ${snapshot.daemon.running ? `是(pid ${String(snapshot.daemon.pid ?? 0)})` : "否"}`,
    `  会话:     ${String(snapshot.daemon.sessions.length)} 个`,
    `  已配对:   ${String(snapshot.devices.length)} 台`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  if (SELF_CHECK) {
    runSelfCheck();
    quitting = true;
    app.exit(0);
    return;
  }
  app.setAppUserModelId("ai.prospero.desktop");
  installApplicationMenu();
  installIpc();
  applyTheme(store.snapshot().settings);
  mainWindow = createWindow();
  nativeTheme.on("updated", () => applyTheme(store.snapshot().settings));
  createTray();
  store.on("changed", broadcastSnapshot);
  setInterval(() => broadcastSnapshot(store.snapshot()), 1_000).unref();
  if (process.argv.includes("--background")) mainWindow.hide();
  if (store.snapshot().settings.startDaemonOnLaunch) {
    const started = await runtime.start();
    // 冒烟测试那一步的名字就是"Start packaged UI and its bundled daemon" ——
    // 跳过启动的话它只验证了一个空壳 UI。daemon 起不来必须让进程非零退出,
    // 由 CI 的退出码来兜;runtime.start() 是等到 /control/health 应答才返回的,
    // 所以"返回 ok"本身就是打包产物里 daemon 可用的证据。
    if (SMOKE_TEST) {
      if (!started.ok) throw new Error(`bundled daemon failed to start: ${started.error ?? "unknown error"}`);
      process.stdout.write("Prospero bundled daemon ready\n");
    }
  }
  await runDesktopSelfCheck(mainWindow);
}).catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  try { store.appendLog(`[desktop] startup failed: ${detail}\n`); } catch { /* Preserve the original startup failure. */ }
  process.stderr.write(`Prospero desktop startup failed: ${detail}\n`);
  quitting = true;
  app.exit(1);
});

app.on("will-quit", (event) => {
  if (runtime.managed) {
    event.preventDefault();
    void runtime.stop().finally(() => { quitting = true; app.exit(0); });
  }
});
