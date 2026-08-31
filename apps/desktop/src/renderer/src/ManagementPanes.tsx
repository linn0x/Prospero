import { useEffect, useState } from "react";
import { Check, CircleAlert, Copy, KeyRound, Link2, MonitorSmartphone, Plus, RefreshCw, Server, Settings2, ShieldCheck, Trash2, UserRound, Wifi } from "lucide-react";
import QRCode from "qrcode";
import type { DesktopSnapshot, UsageAccount, UsageWindow } from "../../shared/types";
import { displayError, number, record, statusLabel, text } from "./state";
import { AgentLogo } from "./AgentLogo";
import { getCachedAccountUsage, loadAccountUsage } from "./account-usage-cache";
import { useLocale } from "./locale";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";

function LegacyAccountsPane({ snapshot, onOpenSession }: { snapshot: DesktopSnapshot; onOpenSession: (id: string) => void }) {
  const [agent, setAgent] = useState("codex");
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-5");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const refresh = (): void => { void window.prospero.accountAction({ type: "agent.accounts.list", requestId: crypto.randomUUID() }).catch((reason) => setError(displayError(reason))); };
  useEffect(refresh, []);
  const create = async (): Promise<void> => {
    try {
      await window.prospero.accountAction({ type: "agent.account.api.create", requestId: crypto.randomUUID(), agent, name: name.trim(), baseUrl, model, apiKey: credential });
      setName(""); setCredential(""); refresh();
    } catch (reason) { setError(displayError(reason)); }
  };
  const action = async (accountId: string, type: "agent.account.default" | "agent.account.login" | "agent.account.logout" | "agent.account.delete"): Promise<void> => {
    setBusy(`${accountId}:${type}`);
    try {
      const result = await window.prospero.accountAction({ type, requestId: crypto.randomUUID(), accountId, ...(type === "agent.account.login" ? { cols: 120, rows: 40 } : {}) });
      const sessionId = text(result["sessionId"]);
      if (sessionId) onOpenSession(sessionId);
      setError(undefined);
      refresh();
    } catch (reason) { setError(displayError(reason)); }
    finally { setBusy(undefined); }
  };
  const createManaged = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy("managed-create");
    try {
      const result = await window.prospero.accountAction({ type: "agent.account.create", requestId: crypto.randomUUID(), agent, name: name.trim() });
      const accounts = Array.isArray(result["accounts"]) ? result["accounts"].map(record) : [];
      const created = accounts.find((account) => text(account["name"]) === name.trim() && text(account["agent"]) === agent);
      setName("");
      if (created) {
        const login = await window.prospero.accountAction({ type: "agent.account.login", requestId: crypto.randomUUID(), accountId: text(created["id"]), cols: 120, rows: 40 });
        const sessionId = text(login["sessionId"]);
        if (sessionId) onOpenSession(sessionId);
      }
      refresh();
    } catch (reason) { setError(displayError(reason)); }
    finally { setBusy(undefined); }
  };
  return <div className="page"><header className="page-header"><div><span className="eyebrow">IDENTITIES</span><h1>Agent 账号</h1><p>为不同项目和 worker 隔离 Codex、Claude 等账号。</p></div><button onClick={refresh}><RefreshCw size={15} />刷新</button></header>{error && <div className="inline-error">{error}</div>}<div className="split-management"><section><div className="section-title"><UserRound size={16} />已配置账号</div><div className="card-grid">{snapshot.accounts.map((account) => { const id = text(account["id"]); const managed = account["managed"] === true; const signedIn = text(account["status"]) === "signed_in"; return <article className="account-card" key={id}><div className="avatar">{text(account["agent"]).slice(0, 2).toUpperCase()}</div><div><strong>{text(account["name"], text(account["agent"]))}</strong><p>{text(account["agent"])} · {statusLabel(text(account["status"]))}{number(account["activeSessions"]) > 0 ? ` · ${number(account["activeSessions"])} 个会话` : ""}</p><div className="button-row compact">{account["isDefault"] !== true && <button disabled={busy !== undefined} onClick={() => void action(id, "agent.account.default")}>设为默认</button>}{managed && !account["apiProfile"] && <button disabled={busy !== undefined} onClick={() => void action(id, signedIn ? "agent.account.logout" : "agent.account.login")}>{signedIn ? "退出登录" : "打开登录终端"}</button>}{managed && <button className="danger" disabled={busy !== undefined || number(account["activeSessions"]) > 0} onClick={() => void action(id, "agent.account.delete")}><Trash2 size={12} />删除</button>}</div></div>{account["isDefault"] === true && <span className="pill"><Check size={12} />默认</span>}</article>; })}{snapshot.accounts.length === 0 && <div className="small-empty">尚未配置账号</div>}</div></section><section className="form-card"><div className="section-title"><Plus size={16} />添加账号</div><label>Agent<select value={agent} onChange={(event) => { const next = event.target.value; setAgent(next); setBaseUrl(next === "claude" ? "https://api.anthropic.com" : "https://api.openai.com/v1"); setModel(next === "claude" ? "claude-sonnet-4-5" : "gpt-5"); }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>显示名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="工作账号" /></label><button onClick={() => void createManaged()} disabled={!name.trim() || busy !== undefined}>创建独立 CLI 账号并登录</button><div className="section-label">或添加 API PROFILE</div><label>API 地址<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} /></label><label>API Key<input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" /></label><p className="security-note"><KeyRound size={14} />凭据只发给本机 daemon，不进入页面快照或日志。</p><button className="primary" onClick={() => void create()} disabled={!name.trim() || !credential || !baseUrl || !model || busy !== undefined}>保存 API Profile</button></section></div></div>;
}

function UsageMeters({ usage }: { usage?: UsageAccount | undefined }) {
  const { t } = useLocale();
  if (!usage) return <p className="usage-note">{t("额度将在账号登录后显示", "Usage appears after the account signs in")}</p>;
  if (!usage.available) return <p className="usage-note">{usage.reason ?? t("这个账号暂无可读取的额度", "Usage is unavailable for this account")}</p>;
  const latestDaily = usage.dailyUsage?.at(-1);
  return <div className="usage-meters">{(usage.lifetimeTokens !== undefined || usage.creditsUnlimited !== undefined || usage.creditsBalance !== undefined) && <div className="usage-summary-grid"><div><span>{t("累计 Tokens", "Lifetime tokens")}</span><strong>{usage.lifetimeTokens?.toLocaleString() ?? "—"}</strong></div><div><span>Credits</span><strong>{usage.creditsUnlimited ? t("无限", "Unlimited") : usage.creditsBalance ?? "—"}</strong></div>{latestDaily && <div><span>{latestDaily.date}</span><strong>{latestDaily.tokens.toLocaleString()}</strong></div>}</div>}{usage.windows.map((window: UsageWindow, index) => {
    const label = window.label;
    const remaining = Math.max(0, Math.round(100 - window.utilization));
    return <div className="usage-meter" key={`${window.label}-${String(index)}`}><div><span>{label}</span><strong>{remaining}% {t("可用", "available")}</strong></div><div className="usage-track"><i style={{ width: `${String(remaining)}%` }} /></div>{window.resetsAt && <small>{new Date(window.resetsAt).toLocaleString()} {t("重置", "reset")}</small>}</div>;
  })}{usage.spendRemainingPercent !== undefined && <div className="usage-meter"><div><span>{t("消费上限", "Spend limit")} {usage.spendUsed ?? "—"} / {usage.spendLimit ?? "—"}</span><strong>{Math.round(usage.spendRemainingPercent)}% {t("可用", "available")}</strong></div><div className="usage-track"><i style={{ width: `${String(usage.spendRemainingPercent)}%` }} /></div></div>}{usage.windows.length === 0 && <p className="usage-note">{usage.reason ?? t("账号已连接，但未返回套餐限流窗口。", "The account is connected, but no plan rate-limit windows were returned.")}</p>}</div>;
}

export function AccountsPane({ snapshot, onOpenSession }: { snapshot: DesktopSnapshot; onOpenSession: (id: string) => void }) {
  const { t, status } = useLocale();
  const [agent, setAgent] = useState<"codex" | "claude">("codex");
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-5");
  const [usage, setUsage] = useState<UsageAccount[]>(getCachedAccountUsage);
  const [usageLoading, setUsageLoading] = useState(() => getCachedAccountUsage().length === 0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const providers = [
    { id: "codex", name: "Codex", detail: t("OpenAI 编程 Agent · 支持订阅额度", "OpenAI coding agent · subscription usage") },
    { id: "claude", name: "Claude", detail: t("Anthropic Claude Code · 支持订阅额度", "Anthropic Claude Code · subscription usage") },
    { id: "deepseek", name: "DeepSeek", detail: t("本机 Agent 环境", "Local agent runtime") },
    { id: "trae", name: "Trae", detail: t("本机 Agent 环境", "Local agent runtime") },
  ] as const;

  const refresh = (force = true): void => {
    setError(undefined);
    setUsageLoading(true);
    void window.prospero.accountAction({ type: "agent.accounts.list", requestId: crypto.randomUUID() })
      .catch((reason) => setError(displayError(reason)));
    void loadAccountUsage(force)
      .then(setUsage)
      .catch((reason) => setError(displayError(reason)))
      .finally(() => setUsageLoading(false));
  };
  useEffect(() => { refresh(false); }, []);

  const runAction = async (accountId: string, type: "agent.account.default" | "agent.account.login" | "agent.account.logout" | "agent.account.delete"): Promise<void> => {
    setBusy(`${accountId}:${type}`);
    try {
      const result = await window.prospero.accountAction({ type, requestId: crypto.randomUUID(), accountId, ...(type === "agent.account.login" ? { cols: 120, rows: 40 } : {}) });
      const sessionId = text(result["sessionId"]);
      if (sessionId) onOpenSession(sessionId);
      refresh();
    } catch (reason) { setError(displayError(reason)); }
    finally { setBusy(undefined); }
  };

  const createManaged = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy("managed-create");
    try {
      const result = await window.prospero.accountAction({ type: "agent.account.create", requestId: crypto.randomUUID(), agent, name: name.trim() });
      const created = (Array.isArray(result["accounts"]) ? result["accounts"].map(record) : []).find((account) => text(account["name"]) === name.trim() && text(account["agent"]) === agent);
      setName("");
      if (created) {
        const login = await window.prospero.accountAction({ type: "agent.account.login", requestId: crypto.randomUUID(), accountId: text(created["id"]), cols: 120, rows: 40 });
        const sessionId = text(login["sessionId"]);
        if (sessionId) onOpenSession(sessionId);
      }
      refresh();
    } catch (reason) { setError(displayError(reason)); }
    finally { setBusy(undefined); }
  };

  const createApi = async (): Promise<void> => {
    setBusy("api-create");
    try {
      await window.prospero.accountAction({ type: "agent.account.api.create", requestId: crypto.randomUUID(), agent, name: name.trim(), baseUrl, model, apiKey: credential });
      setName(""); setCredential(""); refresh();
    } catch (reason) { setError(displayError(reason)); }
    finally { setBusy(undefined); }
  };

  return <div className="page accounts-page">
    <header className="page-header"><div><span className="eyebrow">{t("AGENT 与账号", "AGENTS & ACCOUNTS")}</span><h1>Agents</h1><p>{t("统一管理 Agent、模型来源、CLI / API Profile、登录状态与套餐额度。", "Manage agents, model sources, CLI and API profiles, sign-in state, and plan usage in one place.")}</p></div><button aria-busy={usageLoading} disabled={usageLoading && usage.length === 0} onClick={() => refresh(true)}><RefreshCw className={usageLoading ? "daemon-spinner" : ""} size={15} />{usageLoading ? usage.length > 0 ? t("后台更新", "Updating") : t("读取额度", "Loading usage") : t("刷新额度", "Refresh usage")}</button></header>
    {error && <div className="inline-error">{error}</div>}
    <div className="provider-strip">{providers.map((provider) => {
      const configured = snapshot.accounts.filter((account) => text(account["agent"]) === provider.id).length;
      const running = snapshot.daemon.sessions.filter((session) => session.agent === provider.id).length;
      return <article className={`provider-card provider-${provider.id}`} key={provider.id}><div className="provider-logo"><AgentLogo agent={provider.id} size={26} /></div><div><strong>{provider.name}</strong><p>{provider.detail}</p></div><span>{configured ? `${String(configured)} ${t("个账号", "accounts")}` : running ? `${String(running)} ${t("个会话", "sessions")}` : t("待配置", "Not configured")}</span></article>;
    })}</div>
    <div className="split-management account-layout"><section><div className="section-title"><UserRound size={16} />{t("已配置账号", "Configured accounts")} <span>{snapshot.accounts.length}</span></div><div className="card-grid account-grid">{snapshot.accounts.map((account) => {
      const id = text(account["id"]); const accountAgent = text(account["agent"]); const managed = account["managed"] === true; const signedIn = text(account["status"]) === "signed_in";
      const accountUsage = usage.find((item) => item.accountId === id) ?? usage.find((item) => !item.accountId && item.agent === accountAgent);
      return <article className={`account-card account-card-rich provider-${accountAgent}`} key={id}><div className="account-card-head"><div className="provider-logo"><AgentLogo agent={accountAgent} size={24} /></div><div><strong>{text(account["name"], accountAgent)}</strong><p>{accountAgent} · {status(text(account["status"]))}{number(account["activeSessions"]) > 0 ? ` · ${String(number(account["activeSessions"]))} ${t("个会话", "sessions")}` : ""}</p></div>{account["isDefault"] === true && <span className="pill"><Check size={12} />{t("默认", "Default")}</span>}</div><UsageMeters usage={accountUsage} /><div className="button-row compact">{account["isDefault"] !== true && <button disabled={busy !== undefined} onClick={() => void runAction(id, "agent.account.default")}>{t("设为默认", "Set default")}</button>}{managed && !account["apiProfile"] && <button disabled={busy !== undefined} onClick={() => void runAction(id, signedIn ? "agent.account.logout" : "agent.account.login")}>{signedIn ? t("退出登录", "Sign out") : t("登录", "Sign in")}</button>}{managed && <button className="danger" disabled={busy !== undefined || number(account["activeSessions"]) > 0} onClick={() => void runAction(id, "agent.account.delete")}><Trash2 size={12} />{t("删除", "Delete")}</button>}</div></article>;
    })}{snapshot.accounts.length === 0 && <div className="small-empty">{t("还没有账号。可在右侧创建独立 CLI 登录或 API Profile。", "No accounts yet. Create an isolated CLI login or API profile on the right.")}</div>}</div></section>
      <section className="form-card account-form"><div className="section-title"><Plus size={16} />{t("添加账号", "Add account")}</div><label>Agent<select value={agent} onChange={(event) => { const next = event.target.value as "codex" | "claude"; setAgent(next); setBaseUrl(next === "claude" ? "https://api.anthropic.com" : "https://api.openai.com/v1"); setModel(next === "claude" ? "claude-sonnet-4-5" : "gpt-5"); }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>{t("显示名称", "Display name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("工作账号", "Work account")} /></label><button onClick={() => void createManaged()} disabled={!name.trim() || busy !== undefined}>{t("创建独立 CLI 账号并登录", "Create isolated CLI account and sign in")}</button><div className="section-label">{t("或添加 API PROFILE", "OR ADD AN API PROFILE")}</div><label>{t("API 地址", "API URL")}<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label>{t("模型", "Model")}<input value={model} onChange={(event) => setModel(event.target.value)} /></label><label>API Key<input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" /></label><p className="security-note"><KeyRound size={14} />{t("凭据只发送给本机 daemon。", "Credentials are only sent to the local daemon.")}</p><button className="primary" onClick={() => void createApi()} disabled={!name.trim() || !credential || !baseUrl || !model || busy !== undefined}>{t("保存 API Profile", "Save API profile")}</button></section>
    </div>
  </div>;
}

export function DevicesPane({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { t } = useLocale();
  const [name, setName] = useState(() => t("我的手机", "My phone"));
  const [allowShell, setAllowShell] = useState(true);
  const [allowOrchestration, setAllowOrchestration] = useState(true);
  const [pair, setPair] = useState<{ output: string; uri?: string; qr?: string }>();
  const [error, setError] = useState<string>();
  const createPair = async (): Promise<void> => {
    try { const result = await window.prospero.pairDevice({ name, allowShell, allowOrchestration }); const qr = result.uri ? await QRCode.toDataURL(result.uri, { width: 280, margin: 1, color: { dark: "#111318", light: "#ffffff" } }) : undefined; setPair({ ...result, ...(qr ? { qr } : {}) }); }
    catch (reason) { setError(displayError(reason)); }
  };
  return <div className="page"><header className="page-header"><div><span className="eyebrow">{t("远程控制", "REMOTE CONTROL")}</span><h1>{t("移动端", "Mobile")}</h1><p>{t("配对手机，在移动端安全地查看会话、回复问题并管理 Agent 运行。", "Pair a phone to securely inspect sessions, answer questions, and manage agent runs on mobile.")}</p></div></header>{error && <div className="inline-error">{error}</div>}<div className="split-management"><section><div className="section-title"><MonitorSmartphone size={16} />{t("已配对设备", "Paired devices")} <span>{snapshot.devices.length}</span></div><div className="device-list">{snapshot.devices.map((device) => <article className="device-card" key={device.name}><div className="device-icon"><MonitorSmartphone size={20} /></div><div><strong>{device.name}</strong><p>{device.bound ? t("已绑定", "Paired") : t("等待首次连接", "Awaiting first connection")} · {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : t("从未连接", "Never connected")}</p><div className="tag-row"><span className="pill">{device.allowShell ? "Shell" : t("只读", "Read only")}</span>{device.allowOrchestration && <span className="pill">{t("编排", "Orchestration")}</span>}</div></div><button className="icon-button danger" title={t("撤销", "Revoke")} onClick={() => void window.prospero.revokeDevice(device.name)}><Trash2 size={15} /></button></article>)}</div></section><section className="form-card"><div className="section-title"><Link2 size={16} />{t("配对手机", "Pair phone")}</div>{pair?.qr ? <div className="pair-result"><img src={pair.qr} alt={t("配对二维码", "Pairing QR code")} /><p>{t("二维码含访问凭据，请勿截图外传。", "The QR code contains access credentials. Do not share screenshots.")}</p><button onClick={() => pair.uri && navigator.clipboard.writeText(pair.uri)}><Copy size={14} />{t("复制配对串", "Copy pairing code")}</button><button onClick={() => setPair(undefined)}>{t("返回", "Back")}</button></div> : <><label>{t("设备名称", "Device name")}<input value={name} onChange={(event) => setName(event.target.value)} /></label><label className="check-row"><input type="checkbox" checked={allowShell} onChange={(event) => setAllowShell(event.target.checked)} />{t("允许 Shell / Agent 会话", "Allow Shell / Agent sessions")}</label><label className="check-row"><input type="checkbox" checked={allowOrchestration} disabled={!allowShell} onChange={(event) => setAllowOrchestration(event.target.checked)} />{t("允许创建任务与派发 worker", "Allow task creation and worker dispatch")}</label><button className="primary" onClick={() => void createPair()}><Plus size={14} />{t("生成二维码", "Generate QR code")}</button></>}</section></div></div>;
}

export function LogsPane({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { t } = useLocale();
  return <div className="page logs-page"><header className="page-header"><div><span className="eyebrow">{t("结构化日志", "STRUCTURED LOGS")}</span><h1>{t("诊断", "Diagnostics")}</h1><p>{t("按需检查 daemon、relay 与 terminal 日志；敏感令牌会在写入前遮盖。", "Inspect daemon, relay, and terminal logs when needed. Sensitive tokens are redacted before writing.")}</p></div><button onClick={() => void window.prospero.clearLogs()}><Trash2 size={14} />{t("清空", "Clear")}</button></header><pre className="log-view">{snapshot.logs || t("暂无日志。启动 daemon 后，运行信息会出现在这里。", "No logs yet. Runtime details will appear here after the daemon starts.")}</pre></div>;
}

export function SettingsPane({ snapshot }: { snapshot: DesktopSnapshot }) {
  const [interfaces, setInterfaces] = useState<Array<{ label: string; address: string }>>([]);
  useEffect(() => {
    void window.prospero.listNetworkInterfaces().then(setInterfaces).catch(() => setInterfaces([]));
  }, []);
  const { language, setLanguage, t, status } = useLocale();
  const isWindows = window.prospero.platform === "win32";
  const isMac = window.prospero.platform === "darwin";
  const settings = snapshot.settings;
  const [relay, setRelay] = useState<Record<string, unknown>>({});
  const [relayUrl, setRelayUrl] = useState("");
  const [error, setError] = useState<string>();
  const [fullAccessBusy, setFullAccessBusy] = useState(false);
  const update = (patch: Partial<typeof settings>): void => { void window.prospero.updateSettings(patch).catch((reason) => setError(displayError(reason))); };
  const updateFullAccess = async (checked: boolean): Promise<void> => {
    setError(undefined);
    setFullAccessBusy(true);
    try {
      await window.prospero.updateSettings({ fullAccessPermission: checked });
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setFullAccessBusy(false);
    }
  };
  const relayAction = async (action: "status" | "enable" | "disable" | "rotate-key"): Promise<void> => {
    try { const result = await window.prospero.relayAction({ action, ...(action === "enable" && relayUrl ? { url: relayUrl } : {}) }); setRelay(result); if (action !== "status") setRelay(await window.prospero.relayAction({ action: "status" })); }
    catch (reason) { setError(displayError(reason)); }
  };
  useEffect(() => { void relayAction("status"); }, []);
  const desktopToggle = (id: string, title: string, description: string, checked: boolean, change: (checked: boolean) => void): React.ReactNode => (
    <Field orientation="horizontal" className="desktop-setting-row">
      <FieldContent><FieldLabel htmlFor={id}>{title}</FieldLabel><FieldDescription>{description}</FieldDescription></FieldContent>
      <Checkbox id={id} checked={checked} onCheckedChange={change} />
    </Field>
  );
  return <div className="page settings-page">
    <header className="page-header"><div><span className="eyebrow">{t("偏好设置", "PREFERENCES")}</span><h1>{t("设置", "Settings")}</h1><p>{t("桌面行为、终端外观、daemon 与 Relay。", "Desktop behavior, terminal appearance, daemon, and relay.")}</p></div></header>
    {error && <div className="inline-error">{error}</div>}
    <div className="settings-grid">
      <section className="settings-card desktop-settings-card">
        <div className="section-title"><Settings2 size={16} />{t("桌面端", "Desktop")}</div>
        <FieldGroup className="desktop-settings-list">
          {desktopToggle("start-daemon-on-launch", t("启动本地服务", "Start local service"), t("打开客户端时自动启动 daemon。", "Start the daemon when the client opens."), settings.startDaemonOnLaunch, (checked) => update({ startDaemonOnLaunch: checked }))}
          {desktopToggle("minimize-to-tray", t("在后台运行", "Keep running in background"), t("关闭主窗口后保留托盘进程。", "Keep the tray process running after the main window closes."), settings.minimizeToTray, (checked) => update({ minimizeToTray: checked }))}
          {desktopToggle("launch-at-login", t("开机启动", "Launch at sign-in"), t("登录系统后自动打开 Prospero。", "Open Prospero automatically after signing in."), settings.launchAtLogin, (checked) => update({ launchAtLogin: checked }))}
          <FieldGroup className="desktop-select-grid">
            <Field><FieldLabel htmlFor="desktop-theme">{t("主题", "Theme")}</FieldLabel><NativeSelect id="desktop-theme" value={settings.theme} onChange={(event) => update({ theme: event.target.value as typeof settings.theme })}><NativeSelectOption value="system">{t("跟随系统", "System")}</NativeSelectOption><NativeSelectOption value="dark">{t("深色", "Dark")}</NativeSelectOption><NativeSelectOption value="light">{t("浅色", "Light")}</NativeSelectOption></NativeSelect><FieldDescription>{t("侧边栏和内容区域始终使用同一主题。", "The sidebar and content area always use the same theme.")}</FieldDescription></Field>
            <Field><FieldLabel htmlFor="interface-language">{t("界面语言", "Interface language")}</FieldLabel><NativeSelect id="interface-language" value={language} onChange={(event) => setLanguage(event.target.value === "en" ? "en" : "zh")}><NativeSelectOption value="zh">中文</NativeSelectOption><NativeSelectOption value="en">English</NativeSelectOption></NativeSelect><FieldDescription>{t("语言选择会保存在这台设备上。", "Your language choice is saved on this device.")}</FieldDescription></Field>
          </FieldGroup>
          <Field>
            <FieldLabel htmlFor="daemon-bind">{t("监听网卡", "Listening interface")}</FieldLabel>
            <NativeSelect id="daemon-bind" value={settings.daemonBind} onChange={(event) => update({ daemonBind: event.target.value })}>
              <NativeSelectOption value="0.0.0.0">{t("全部网卡", "All interfaces")}</NativeSelectOption>
              {interfaces.map((item) => <NativeSelectOption key={item.address} value={item.address}>{item.label}</NativeSelectOption>)}
            </NativeSelect>
            <FieldDescription>{t("下次启动 daemon 时生效。同时挂着 WireGuard 之类虚拟网卡时，绑定到具体网卡更容易排查直连问题。", "Applies the next time the daemon starts. Binding a specific interface makes direct connections easier to diagnose when virtual adapters like WireGuard are present.")}</FieldDescription>
          </Field>
        </FieldGroup>
      </section>
      {isWindows && <section className="settings-card permission-settings-card">
        <div className="section-title"><ShieldCheck size={16} />{t("权限设置", "Permissions")}</div>
        <FieldGroup>
          <Field orientation="horizontal" className="desktop-setting-row">
            <FieldContent>
              <FieldLabel htmlFor="full-access-permission">{t("完整访问权限", "Full access")}</FieldLabel>
              <FieldDescription>{t("通过 Windows UAC 以管理员身份运行 daemon；之后启动的 Agent 会继承管理员权限。", "Run the daemon through Windows UAC. Agents launched afterward inherit administrator access.")}</FieldDescription>
            </FieldContent>
            <Switch id="full-access-permission" checked={settings.fullAccessPermission} disabled={fullAccessBusy} onCheckedChange={(checked) => void updateFullAccess(checked)} />
          </Field>
        </FieldGroup>
        <p className="security-note"><CircleAlert size={14} />{
          snapshot.daemon.running
            ? snapshot.daemon.fullAccess
              ? t("Daemon 当前正以管理员权限运行。关闭此权限会安全重启并降回标准权限。", "The daemon is currently running as administrator. Turning this off safely restarts it with standard access.")
              : settings.fullAccessPermission
                ? t("正在等待管理员授权或重启。", "Waiting for administrator approval or restart.")
                : t("Daemon 当前使用标准用户权限。", "The daemon is currently using standard user access.")
            : settings.fullAccessPermission
              ? t("下次启动 daemon 时会显示 Windows UAC 授权提示。", "Windows UAC will ask for approval the next time the daemon starts.")
              : t("默认使用标准用户权限；仅在确有需要时开启完整访问。", "Standard user access is the default. Enable full access only when needed.")
        }</p>
      </section>}
      <section className="settings-card"><div className="section-title"><Server size={16} />Daemon</div><div className="runtime-state"><span className={`status-dot ${snapshot.daemon.state}`} /><div><strong>{status(snapshot.daemon.state)}</strong><p>{snapshot.daemon.pid ? `PID ${snapshot.daemon.pid} · 127.0.0.1:${snapshot.daemon.port}` : t("尚未运行", "Not running")}</p></div></div><div className="button-row"><button className="primary" onClick={() => void window.prospero.startDaemon()} disabled={snapshot.daemon.running}>{t("启动", "Start")}</button><button onClick={() => void window.prospero.restartDaemon()} disabled={!snapshot.daemon.managed}>{t("重启", "Restart")}</button><button className="danger" onClick={() => void window.prospero.stopDaemon()} disabled={!snapshot.daemon.managed}>{t("停止", "Stop")}</button></div><p className="security-note"><CircleAlert size={14} />{t("外部启动的 daemon 只连接、不强杀；控制令牌不会暴露给 UI。", "Externally started daemons are attached, never force-killed. Control tokens are not exposed to the UI.")}</p></section>
      <section className="settings-card"><div className="section-title"><Wifi size={16} />Relay</div><div className="runtime-state"><span className={`status-dot ${text(relay["state"], "disabled")}`} /><div><strong>{text(relay["enabled"]) === "true" || relay["enabled"] === true ? t("已启用", "Enabled") : t("未启用", "Disabled")}</strong><p>{text(relay["url"], t("用于公网访问的可选自托管中继", "Optional self-hosted relay for public access"))}</p></div></div><label>{t("WSS 地址", "WSS URL")}<input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} placeholder="wss://relay.example.com" /></label><div className="button-row"><button className="primary" onClick={() => void relayAction("enable")}>{t("启用", "Enable")}</button><button onClick={() => void relayAction("disable")}>{t("关闭", "Disable")}</button><button className="danger" onClick={() => void relayAction("rotate-key")}>{t("轮换密钥", "Rotate key")}</button></div><p className="security-note"><CircleAlert size={14} />{t("轮换后所有设备都需要重新配对，执行前会再次确认。", "All devices must pair again after rotation. You will be asked to confirm first.")}</p></section>
      <section className="settings-card"><div className="section-title"><Settings2 size={16} />{t("终端", "Terminal")}</div><label>{t("等宽字体", "Monospaced font")}<input value={settings.terminalFontFamily} onChange={(event) => update({ terminalFontFamily: event.target.value })} /></label><label>{t("字号", "Font size")}<input type="number" min={8} max={48} value={settings.terminalFontSize} onChange={(event) => update({ terminalFontSize: Number(event.target.value) })} /></label><p className="security-note">{t("所有终端会话会立即应用这套字体设置。", "All terminal sessions apply this font setting immediately.")}</p><div className="terminal-preview" style={{ fontFamily: settings.terminalFontFamily, fontSize: settings.terminalFontSize }}>{isMac ? "zsh % codex" : "PS C:\\Prospero> codex"}</div></section>
    </div>
  </div>;
}
