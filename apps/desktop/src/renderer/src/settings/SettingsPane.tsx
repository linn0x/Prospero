import { useCallback, useEffect, useRef, useState } from "react";
import { DesktopIcon } from "../design-system/icons";
import type { DesktopSettings, DesktopSnapshot } from "../../../shared/types";
import { displayError, text } from "../state";
import { useLocale } from "../locale";
import { SettingRow, SettingsSection } from "./SettingRow";
import { SettingsNav } from "./SettingsNav";
import { SettingsActions, settingsCategories, terminalFontSize, validRelayUrl, type SettingFeedback, type SettingsCategory } from "./settings-state";
import "./settings.css";

function relayPresentation(state: string, enabled: boolean): { dot: string; zh: string; en: string } {
  if (!enabled || state === "disabled") return { dot: "", zh: "未启用", en: "Disabled" };
  if (state === "online") return { dot: "running", zh: "已连接", en: "Connected" };
  if (state === "connecting" || state === "syncing") return { dot: "starting", zh: "正在连接", en: "Connecting" };
  if (state === "error") return { dot: "error", zh: "连接异常", en: "Connection error" };
  return { dot: "paused", zh: "等待连接", en: "Waiting to connect" };
}

export function SettingsPane({ snapshot, onOpenAccounts }: { snapshot: DesktopSnapshot; onOpenAccounts: () => void }) {
  const { language, setLanguage, t, status } = useLocale();
  const [active, setActive] = useState<SettingsCategory>("general");
  const [feedback, setFeedback] = useState<Record<string, SettingFeedback | undefined>>({});
  const mounted = useRef(true);
  const [actions] = useState(() => new SettingsActions((id, value) => {
    if (mounted.current) setFeedback((previous) => ({ ...previous, [id]: value }));
  }, displayError));
  const settings = snapshot.settings;
  const isWindows = window.prospero.platform === "win32";
  const [interfaces, setInterfaces] = useState<Array<{ label: string; address: string }>>([]);
  const interfacesLoaded = useRef(false);
  const [fontFamily, setFontFamily] = useState(settings.terminalFontFamily);
  const [fontSize, setFontSize] = useState(String(settings.terminalFontSize));
  const fontFamilyDirty = useRef(false);
  const fontSizeDirty = useRef(false);
  const [relay, setRelay] = useState<Record<string, unknown>>(snapshot.daemon.relay);
  const [relayUrl, setRelayUrl] = useState(text(snapshot.daemon.relay["url"]));
  const relayUrlDirty = useRef(false);
  const busy = (id: string) => feedback[id]?.state === "saving";
  const runtimeBusy = busy("daemon-control") || busy("full-access-permission");
  const relayBusy = busy("relay-control") || busy("relay-key") || busy("relay-status");
  const rowFeedback = (id: string) => ({ feedback: feedback[id], onRetry: () => { void actions.retry(id); } });
  const description = (id: string) => `${id}-description${feedback[id] ? ` ${id}-feedback` : ""}`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; actions.dispose(); };
  }, [actions]);
  useEffect(() => {
    if (!fontFamilyDirty.current) setFontFamily(settings.terminalFontFamily);
  }, [settings.terminalFontFamily]);
  useEffect(() => {
    if (!fontSizeDirty.current) setFontSize(String(settings.terminalFontSize));
  }, [settings.terminalFontSize]);
  useEffect(() => {
    setRelay(snapshot.daemon.relay);
    if (!relayUrlDirty.current) setRelayUrl(text(snapshot.daemon.relay["url"]));
  }, [snapshot.daemon.relay]);

  const update = (id: string, patch: Partial<DesktopSettings>, group = "settings") => actions.run(id, async () => {
    await window.prospero.updateSettings(patch);
    return t("已保存", "Saved");
  }, group);
  const loadInterfaces = useCallback(() => actions.run("daemon-bind", async () => {
    const result = await window.prospero.listNetworkInterfaces();
    if (mounted.current) setInterfaces(result);
    interfacesLoaded.current = true;
    return false;
  }), [actions]);
  useEffect(() => {
    if (active === "runtime" && !interfacesLoaded.current && !feedback["daemon-bind"]) void loadInterfaces();
  }, [active, feedback, loadInterfaces]);

  const saveFontFamily = () => {
    if (!fontFamilyDirty.current) return;
    void actions.run("terminal-font-family", async () => {
      const value = fontFamily.trim();
      if (!value) throw new Error(t("字体名称不能为空", "Font family cannot be empty"));
      const next = await window.prospero.updateSettings({ terminalFontFamily: value });
      if (mounted.current) setFontFamily(next.settings.terminalFontFamily);
      fontFamilyDirty.current = false;
      return t("已保存", "Saved");
    }, "settings");
  };
  const saveFontSize = () => {
    if (!fontSizeDirty.current) return;
    void actions.run("terminal-font-size", async () => {
      const value = terminalFontSize(fontSize);
      if (value === undefined) throw new Error(t("字号必须是 8–48 的整数", "Font size must be an integer from 8 to 48"));
      const next = await window.prospero.updateSettings({ terminalFontSize: value });
      if (mounted.current) setFontSize(String(next.settings.terminalFontSize));
      fontSizeDirty.current = false;
      return t("已保存", "Saved");
    }, "settings");
  };
  const daemonAction = (action: "start" | "restart" | "stop") => actions.run("daemon-control", async () => {
    const result = await window.prospero[action === "start" ? "startDaemon" : action === "restart" ? "restartDaemon" : "stopDaemon"]();
    if (!result.ok) throw new Error(result.error || t("Daemon 操作失败", "Daemon action failed"));
    return action === "start" ? t("Daemon 已启动", "Daemon started") : action === "restart" ? t("Daemon 已重启", "Daemon restarted") : t("Daemon 已停止", "Daemon stopped");
  }, "runtime");
  const readRelay = async () => {
    const result = await window.prospero.relayAction({ action: "status" });
    if (result["ok"] === false) throw new Error(text(result["output"], t("无法读取 Relay 状态", "Unable to read relay status")));
    if (mounted.current) {
      setRelay(result);
      if (!relayUrlDirty.current && typeof result["url"] === "string") setRelayUrl(result["url"]);
    }
  };
  const relayAction = (action: "status" | "enable" | "disable" | "rotate-key") => actions.run(action === "rotate-key" ? "relay-key" : "relay-control", async () => {
    if (action === "status") { await readRelay(); return t("状态已更新", "Status updated"); }
    if (action === "enable" && !validRelayUrl(relayUrl)) throw new Error(t("请输入有效的 wss:// Relay 地址，不包含账号、密码或片段", "Enter a valid wss:// relay URL without credentials or a fragment"));
    const result = await window.prospero.relayAction({ action, ...(action === "enable" && relayUrl.trim() ? { url: relayUrl.trim() } : {}) });
    if (result["cancelled"] === true) return false;
    if (result["ok"] === false) throw new Error(text(result["output"], t("Relay 操作失败", "Relay action failed")));
    relayUrlDirty.current = false;
    await actions.run("relay-status", async () => { await readRelay(); return false; });
    return action === "enable" ? t("Relay 已启用", "Relay enabled") : action === "disable" ? t("Relay 已关闭", "Relay disabled") : t("Relay 密钥已轮换", "Relay key rotated");
  }, "relay");
  const relayView = relayPresentation(text(relay["state"], "disabled"), relay["enabled"] === true || relay["enabled"] === "true");
  const toggle = (id: string, title: string, detail: string, key: "startDaemonOnLaunch" | "minimizeToTray" | "launchAtLogin") => <SettingRow key={id} id={id} title={title} description={detail} {...rowFeedback(id)}>
    <input id={id} type="checkbox" role="switch" checked={settings[key]} disabled={busy(id)} aria-describedby={description(id)} onChange={(event) => { void update(id, { [key]: event.target.checked }); }} />
  </SettingRow>;

  return <div className="settings-shell">
    <SettingsNav active={active} onChange={setActive} />
    {settingsCategories.map((category) => <div key={category.id} className="settings-content" id={`settings-panel-${category.id}`} role="tabpanel" aria-labelledby={`settings-tab-${category.id}`} tabIndex={0} hidden={active !== category.id}>
      {category.id === "general" && <SettingsSection id="general" title={t("通用", "General")} description={t("启动行为与这台设备的界面语言。", "Startup behavior and language for this device.")}>
        {toggle("start-daemon-on-launch", t("启动本地服务", "Start local service"), t("打开客户端时自动启动 daemon。", "Start the daemon when the client opens."), "startDaemonOnLaunch")}
        {toggle("minimize-to-tray", t("在后台运行", "Keep running in background"), t("关闭主窗口后保留托盘进程。", "Keep the tray process running after the main window closes."), "minimizeToTray")}
        {toggle("launch-at-login", t("开机启动", "Launch at sign-in"), t("登录系统后自动打开 Prospero。", "Open Prospero automatically after signing in."), "launchAtLogin")}
        <SettingRow id="interface-language" title={t("界面语言", "Interface language")} description={t("语言选择保存在这台设备上。", "Your language choice is saved on this device.")} {...rowFeedback("interface-language")}>
          <select id="interface-language" value={language} aria-describedby={description("interface-language")} onChange={(event) => {
            const value = event.target.value === "en" ? "en" : "zh";
            void actions.run("interface-language", async () => { setLanguage(value); return value === "zh" ? "已保存" : "Saved"; });
          }}><option value="zh">中文</option><option value="en">English</option></select>
        </SettingRow>
      </SettingsSection>}
      {category.id === "appearance" && <SettingsSection id="appearance" title={t("外观", "Appearance")} description={t("保留桌面端的玻璃层次，并统一窗口和内容主题。", "Keep the desktop glass appearance with a consistent window and content theme.")}>
        <SettingRow id="desktop-theme" title={t("主题", "Theme")} description={t("立即应用于侧栏、面板和窗口。", "Applies immediately to the sidebar, panels, and window.")} {...rowFeedback("desktop-theme")}>
          <select id="desktop-theme" value={settings.theme} disabled={busy("desktop-theme")} aria-describedby={description("desktop-theme")} onChange={(event) => { void update("desktop-theme", { theme: event.target.value as DesktopSettings["theme"] }); }}><option value="system">{t("跟随系统", "System")}</option><option value="light">{t("浅色", "Light")}</option><option value="dark">{t("深色", "Dark")}</option></select>
        </SettingRow>
        <p className="settings-detail-note">{t("界面会遵循系统的降低动态效果、高对比度和降低透明度偏好。", "The interface follows system preferences for reduced motion, high contrast, and reduced transparency.")}</p>
      </SettingsSection>}
      {category.id === "accounts" && <SettingsSection id="accounts" title={t("Agent 与账号", "Agents and accounts")} description={t("管理登录账号、API 连接与模型配置。", "Manage signed-in accounts, API connections, and model configuration.")}>
        <SettingRow id="open-accounts" title={t("账号管理", "Account management")} description={t(`已配置 ${snapshot.accounts.length} 个账号。`, `${snapshot.accounts.length} accounts configured.`)}>
          <button id="open-accounts" type="button" aria-describedby="open-accounts-description" onClick={onOpenAccounts}>{t("管理账号", "Manage accounts")}<DesktopIcon name="arrowRight" size={14} /></button>
        </SettingRow>
      </SettingsSection>}
      {category.id === "terminal" && <SettingsSection id="terminal" title={t("终端", "Terminal")} description={t("按 Enter 或移开焦点保存，立即应用到终端。", "Press Enter or move focus away to save and apply terminal appearance.")}>
        <SettingRow id="terminal-font-family" title={t("等宽字体", "Monospaced font")} description={t("可用逗号分隔多个备用字体。", "Separate fallback font families with commas.")} {...rowFeedback("terminal-font-family")}>
          <input id="terminal-font-family" maxLength={200} spellCheck={false} value={fontFamily} disabled={busy("terminal-font-family")} aria-describedby={description("terminal-font-family")} aria-invalid={feedback["terminal-font-family"]?.state === "error"} onChange={(event) => { fontFamilyDirty.current = true; setFontFamily(event.target.value); actions.clear("terminal-font-family"); }} onBlur={saveFontFamily} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "Enter") event.currentTarget.blur(); }} />
        </SettingRow>
        <SettingRow id="terminal-font-size" title={t("字号", "Font size")} description={t("8–48 之间的整数。", "An integer from 8 to 48.")} {...rowFeedback("terminal-font-size")}>
          <input id="terminal-font-size" type="number" min={8} max={48} value={fontSize} disabled={busy("terminal-font-size")} aria-describedby={description("terminal-font-size")} aria-invalid={feedback["terminal-font-size"]?.state === "error"} onChange={(event) => { fontSizeDirty.current = true; setFontSize(event.target.value); actions.clear("terminal-font-size"); }} onBlur={saveFontSize} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "Enter") event.currentTarget.blur(); }} />
        </SettingRow>
        <div className="settings-terminal-preview" aria-label={t("终端预览", "Terminal preview")} style={{ fontFamily: fontFamily || settings.terminalFontFamily, fontSize: terminalFontSize(fontSize) ?? settings.terminalFontSize }}>{window.prospero.platform === "darwin" ? "zsh % codex" : isWindows ? "PS C:\\Prospero> codex" : "$ codex"}</div>
      </SettingsSection>}
      {category.id === "runtime" && <SettingsSection id="runtime" title={t("运行时与网络", "Runtime and network")} description={t("本地服务、直连网卡与运行权限。", "Local service, direct connection interface, and runtime permissions.")}>
        <SettingRow id="daemon-control" title="Daemon" description={snapshot.daemon.pid ? `PID ${snapshot.daemon.pid} · 127.0.0.1:${snapshot.daemon.port}` : t("尚未运行", "Not running")} {...rowFeedback("daemon-control")} stacked group>
          <div className="settings-status" role="status"><span className={`status-dot ${snapshot.daemon.state}`} aria-hidden="true" />{snapshot.daemon.state === "stopped" ? t("已停止", "Stopped") : status(snapshot.daemon.state)}</div>
          <div className="settings-action-row">
            <button type="button" className="primary" disabled={runtimeBusy || snapshot.daemon.running || snapshot.daemon.starting} onClick={() => { void daemonAction("start"); }}>{snapshot.daemon.starting ? t("启动中…", "Starting…") : t("启动", "Start")}</button>
            <button type="button" disabled={runtimeBusy || !snapshot.daemon.managed} onClick={() => { void daemonAction("restart"); }}>{t("重启", "Restart")}</button>
            <button type="button" className="danger" disabled={runtimeBusy || !snapshot.daemon.managed} onClick={() => { void daemonAction("stop"); }}>{t("停止", "Stop")}</button>
          </div>
        </SettingRow>
        <SettingRow id="daemon-bind" title={t("监听网卡", "Listening interface")} description={t("下次启动 daemon 时生效。使用虚拟网卡时可绑定具体网卡。", "Applies when the daemon next starts. Choose an interface when using virtual adapters.")} {...rowFeedback("daemon-bind")}>
          <select id="daemon-bind" value={settings.daemonBind} disabled={busy("daemon-bind")} aria-describedby={description("daemon-bind")} onChange={(event) => { void update("daemon-bind", { daemonBind: event.target.value }); }}><option value="0.0.0.0">{t("全部网卡", "All interfaces")}</option>{settings.daemonBind !== "0.0.0.0" && !interfaces.some((item) => item.address === settings.daemonBind) && <option value={settings.daemonBind}>{settings.daemonBind}</option>}{interfaces.filter((item) => item.address !== "0.0.0.0").map((item) => <option key={item.address} value={item.address}>{item.label}</option>)}</select>
          <button type="button" aria-label={t("刷新网卡", "Refresh interfaces")} disabled={busy("daemon-bind")} onClick={() => { void loadInterfaces(); }}><DesktopIcon name="refresh" size={14} /></button>
        </SettingRow>
        {isWindows && <SettingRow id="full-access-permission" title={t("完整访问权限", "Full access")} description={snapshot.daemon.running && snapshot.daemon.fullAccess ? t("当前以管理员运行。关闭后安全重启并恢复标准权限。", "Currently running as administrator. Turning off safely restarts with standard access.") : t("通过 Windows UAC 运行 daemon，新启动的 Agent 将继承管理员权限。", "Run the daemon through Windows UAC. Newly launched agents inherit administrator access.")} {...rowFeedback("full-access-permission")}>
          <input id="full-access-permission" type="checkbox" role="switch" checked={settings.fullAccessPermission} disabled={runtimeBusy} aria-describedby={description("full-access-permission")} onChange={(event) => { void update("full-access-permission", { fullAccessPermission: event.target.checked }, "runtime"); }} />
        </SettingRow>}
        <p className="settings-detail-note">{t("外部启动的 daemon 由原启动位置管理。", "Externally started daemons remain managed by their original launcher.")}</p>
      </SettingsSection>}
      {category.id === "relay" && <SettingsSection id="relay" title="Relay" description={t("可选的自托管中继，用于公网访问。", "An optional self-hosted relay for public access.")}>
        <SettingRow id="relay-status" title={t("连接状态", "Connection status")} description={text(relay["url"], t("尚未配置地址", "No address configured"))} {...rowFeedback("relay-status")} group>
          <div className="settings-status" role="status"><span className={`status-dot ${relayView.dot}`} aria-hidden="true" />{t(relayView.zh, relayView.en)}</div>
          <button type="button" aria-label={t("刷新 Relay 状态", "Refresh relay status")} disabled={relayBusy || busy("relay-status")} onClick={() => { void actions.run("relay-status", async () => { await readRelay(); return t("状态已更新", "Status updated"); }); }}><DesktopIcon name="refresh" size={14} /></button>
        </SettingRow>
        <SettingRow id="relay-url" title={t("WSS 地址", "WSS URL")} description={t("修改地址后点击启用。留空使用默认地址。", "Choose Enable to apply changes. Leave blank for the default URL.")} stacked>
          <input id="relay-url" type="url" inputMode="url" maxLength={2000} spellCheck={false} value={relayUrl} disabled={relayBusy} aria-describedby={`relay-url-description${feedback["relay-control"] ? " relay-control-feedback" : ""}`} aria-invalid={feedback["relay-control"]?.state === "error"} placeholder="wss://relay.example.com" onChange={(event) => { relayUrlDirty.current = true; setRelayUrl(event.target.value); actions.clear("relay-control"); }} />
        </SettingRow>
        <SettingRow id="relay-control" title={t("Relay 服务", "Relay service")} {...rowFeedback("relay-control")} group>
          <button type="button" className="primary" disabled={relayBusy} onClick={() => { void relayAction("enable"); }}>{t("启用", "Enable")}</button>
          <button type="button" disabled={relayBusy} onClick={() => { void relayAction("disable"); }}>{t("关闭", "Disable")}</button>
        </SettingRow>
        <SettingRow id="relay-key" title={t("轮换密钥", "Rotate key")} description={t("所有设备都需要重新配对。执行前会再次确认。", "All devices must pair again. You will be asked to confirm first.")} {...rowFeedback("relay-key")}>
          <button id="relay-key" type="button" className="danger" disabled={relayBusy} aria-describedby={description("relay-key")} onClick={() => { void relayAction("rotate-key"); }}>{t("轮换密钥", "Rotate key")}</button>
        </SettingRow>
      </SettingsSection>}
    </div>)}
  </div>;
}
