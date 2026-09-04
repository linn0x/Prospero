import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Copy, KeyRound, Link2, MonitorSmartphone, Pencil, Plus, RefreshCw, Server, Settings2, ShieldCheck, Trash2, UserRound, Wifi } from "lucide-react";
import type { DesktopSnapshot, DeviceInfo, JsonObject, SessionInfo, UsageAccount, UsageWindow } from "../../shared/types";
import { displayError, number, record, text } from "./state";
import { AgentLogo } from "./AgentLogo";
import { getCachedAccountUsage, loadAccountUsage } from "./account-usage-cache";
import { useLocale } from "./locale";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  accountApiProtocolDefaults,
  accountApiConnectionLocked,
  accountApiEngineLabel,
  accountApiProfileNameAction,
  accountApiProtocolFromProfile,
  accountApiProtocolLabel,
  accountApiProvider,
  accountApiProtocols,
  accountApiProtocolsForAgent,
  provisionalAccountLoginSession,
  selectCreatedAccount,
  supportsAccountApiProtocols,
  type AccountApiProtocol,
} from "./account-profile-form";

function terminalFontSize(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 8 && parsed <= 48 ? parsed : undefined;
}

type TerminalSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function deviceRenderKey(device: DeviceInfo, index: number): string {
  return device.id || `${device.name}:${String(index)}`;
}

function relayPresentation(state: string, enabled: boolean): { dot: string; zh: string; en: string } {
  if (!enabled || state === "disabled") return { dot: "", zh: "未启用", en: "Disabled" };
  if (state === "online") return { dot: "running", zh: "已连接", en: "Connected" };
  if (state === "connecting" || state === "syncing") return { dot: "starting", zh: "正在连接", en: "Connecting" };
  if (state === "error") return { dot: "error", zh: "连接异常", en: "Connection error" };
  return { dot: "paused", zh: "等待连接", en: "Waiting to connect" };
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

function AccountEditDialog({ account, apiProtocolsSupported, onClose, onSaved }: { account: JsonObject; apiProtocolsSupported: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const profile = record(account["apiProfile"]);
  const apiProfile = Object.keys(profile).length > 0;
  const accountId = text(account["id"]);
  const agent = text(account["agent"]);
  const connectionLocked = accountApiConnectionLocked(account);
  const initialName = text(account["name"], agent);
  const initialProtocol = accountApiProtocolFromProfile(profile, agent);
  const [name, setName] = useState(initialName);
  const [protocol, setProtocol] = useState<AccountApiProtocol>(initialProtocol);
  const [baseUrl, setBaseUrl] = useState(text(profile["baseUrl"], accountApiProtocolDefaults(initialProtocol).baseUrl));
  const [model, setModel] = useState(text(profile["model"], accountApiProtocolDefaults(initialProtocol).model));
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const protocols = accountApiProtocolsForAgent(agent);
  const apiSettingsChanged = (apiProtocolsSupported && protocol !== initialProtocol)
    || baseUrl.trim() !== text(profile["baseUrl"])
    || model.trim() !== text(profile["model"])
    || Boolean(apiKey.trim());
  const legacyCredentialMissing = apiProfile && !connectionLocked && !apiProtocolsSupported && apiSettingsChanged && !apiKey.trim();
  const save = async (): Promise<void> => {
    const nextName = name.trim();
    const nextBaseUrl = baseUrl.trim();
    const nextModel = model.trim();
    if (busyRef.current || !accountId || !nextName || (apiProfile && !connectionLocked && (!nextBaseUrl || !nextModel))) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (apiProfile && connectionLocked && nextName !== initialName) {
        const result = await window.prospero.accountAction({
          ...accountApiProfileNameAction(accountId, nextName, apiProtocolsSupported),
          requestId: crypto.randomUUID(),
        });
        if (result["ok"] === false) throw new Error(text(result["error"], t("账号名称更新失败", "Unable to rename account")));
      } else if (apiProfile && !connectionLocked && apiProtocolsSupported && (nextName !== initialName || apiSettingsChanged)) {
        const result = await window.prospero.accountAction({ type: "agent.account.api.configure", requestId: crypto.randomUUID(), accountId, name: nextName, provider: accountApiProvider(protocol), protocol, baseUrl: nextBaseUrl, model: nextModel, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
        if (result["ok"] === false) throw new Error(text(result["error"], t("API Profile 更新失败", "Unable to update API profile")));
      } else if (apiProfile && !connectionLocked && !apiProtocolsSupported) {
        if (apiSettingsChanged) {
          if (!apiKey.trim()) throw new Error(t("旧版 daemon 要求重新输入 API Key 才能修改连接设置", "The older daemon requires the API Key again to change connection settings"));
          const result = await window.prospero.accountAction({ type: "agent.account.api.configure", requestId: crypto.randomUUID(), accountId, baseUrl: nextBaseUrl, model: nextModel, apiKey: apiKey.trim() });
          if (result["ok"] === false) throw new Error(text(result["error"], t("API Profile 更新失败", "Unable to update API profile")));
        }
        if (nextName !== initialName) {
          const result = await window.prospero.accountAction({ type: "agent.account.rename", requestId: crypto.randomUUID(), accountId, name: nextName });
          if (result["ok"] === false) throw new Error(text(result["error"], t("账号名称更新失败", "Unable to rename account")));
        }
      } else if (!apiProfile && nextName !== initialName) {
        const result = await window.prospero.accountAction({ type: "agent.account.rename", requestId: crypto.randomUUID(), accountId, name: nextName });
        if (result["ok"] === false) throw new Error(text(result["error"], t("账号名称更新失败", "Unable to rename account")));
      }
      onSaved();
      onClose();
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const changeProtocol = (next: AccountApiProtocol): void => {
    const defaults = accountApiProtocolDefaults(next);
    setProtocol(next);
    setBaseUrl(defaults.baseUrl);
    setModel(defaults.model);
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busyRef.current) onClose(); }}><DialogContent className="sm:max-w-lg" showCloseButton={!busy} closeLabel={t("关闭", "Close")} aria-busy={busy}><DialogHeader><DialogTitle>{t("编辑账号", "Edit account")}</DialogTitle><DialogDescription>{apiProfile ? connectionLocked ? t("当前存在活动会话，仅可修改显示名称。", "Only the display name can be changed while sessions are active.") : apiProtocolsSupported ? t("修改名称和 API 连接设置。API Key 留空会保留现有凭据。", "Update the name and API connection. Leave API Key empty to keep the current credential.") : t("当前 daemon 使用旧版 API Profile；修改连接设置时需要重新输入 API Key。", "This daemon uses legacy API profiles. Re-enter the API Key when changing connection settings.") : t("修改这个独立 CLI 账号在 Prospero 中的显示名称。", "Change the display name for this isolated CLI account.")}</DialogDescription></DialogHeader>{error && <div id="account-edit-error" className="inline-error" role="alert">{error}</div>}{apiProfile && connectionLocked && <p className="security-note" role="status">{t("结束活动会话后，才能更新协议、API 地址、模型或 API Key。", "End active sessions before updating the protocol, API URL, model, or API Key.")}</p>}<form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}><FieldGroup><Field><FieldLabel htmlFor="account-edit-name">{t("显示名称", "Display name")}</FieldLabel><Input id="account-edit-name" maxLength={80} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "account-edit-error" : undefined} autoFocus /></Field>{apiProfile && <>{apiProtocolsSupported && <Field><FieldLabel htmlFor="account-edit-protocol">{t("API 协议", "API protocol")}</FieldLabel><NativeSelect id="account-edit-protocol" disabled={busy || connectionLocked || protocols.length < 2} value={protocol} onChange={(event) => changeProtocol(event.target.value as AccountApiProtocol)}>{protocols.map((item) => <NativeSelectOption key={item} value={item}>{accountApiProtocolLabel(item)}</NativeSelectOption>)}</NativeSelect><FieldDescription>{accountApiEngineLabel(protocol)} engine · {protocol === "openai_responses" ? t("OpenAI Responses API 及兼容服务", "OpenAI Responses API and compatible services") : protocol === "openai_chat_completions" ? t("OpenAI Chat Completions 兼容服务", "OpenAI Chat Completions-compatible services") : t("Anthropic Messages API 及兼容服务", "Anthropic Messages API and compatible services")}</FieldDescription></Field>}<Field><FieldLabel htmlFor="account-edit-base-url">{t("API 地址", "Base URL")}</FieldLabel><Input id="account-edit-base-url" type="url" inputMode="url" maxLength={2_000} spellCheck={false} disabled={busy || connectionLocked} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></Field><Field><FieldLabel htmlFor="account-edit-model">{t("模型", "Model")}</FieldLabel><Input id="account-edit-model" maxLength={300} spellCheck={false} disabled={busy || connectionLocked} value={model} onChange={(event) => setModel(event.target.value)} /></Field><Field><FieldLabel htmlFor="account-edit-api-key">API Key</FieldLabel><Input id="account-edit-api-key" type="password" maxLength={8_192} autoComplete="new-password" disabled={busy || connectionLocked} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={apiProtocolsSupported ? t("留空以保留现有凭据", "Leave empty to keep the current credential") : t("修改连接设置时必须重新输入", "Required when changing connection settings")} /></Field></>}</FieldGroup><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("取消", "Cancel")}</Button><Button type="submit" disabled={busy || legacyCredentialMissing || !name.trim() || (apiProfile && !connectionLocked && (!baseUrl.trim() || !model.trim()))}>{busy && <Spinner data-icon="inline-start" />}{busy ? t("保存中…", "Saving…") : t("保存", "Save")}</Button></DialogFooter></form></DialogContent></Dialog>;
}

export function AccountsPane({ snapshot, onOpenSession }: { snapshot: DesktopSnapshot; onOpenSession: (id: string, session?: SessionInfo) => void }) {
  const { t, status } = useLocale();
  const apiProtocolsSupported = supportsAccountApiProtocols(snapshot.daemon.capabilities);
  const [agent, setAgent] = useState<"codex" | "claude">("codex");
  const [protocol, setProtocol] = useState<AccountApiProtocol>("openai_responses");
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-5");
  const effectiveProtocol = apiProtocolsSupported ? protocol : agent === "claude" ? "anthropic" : "openai_responses";
  const [usage, setUsage] = useState<UsageAccount[]>(getCachedAccountUsage);
  const [usageLoading, setUsageLoading] = useState(() => getCachedAccountUsage().length === 0);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [editingAccount, setEditingAccount] = useState<JsonObject>();
  const busyRef = useRef<string | undefined>(undefined);
  const accountsLoadingRef = useRef(false);
  const refreshGeneration = useRef(0);
  const providers = [
    { id: "codex", name: "Codex", detail: t("OpenAI 编程 Agent · 支持订阅额度", "OpenAI coding agent · subscription usage") },
    { id: "claude", name: "Claude", detail: t("Anthropic Claude Code · 支持订阅额度", "Anthropic Claude Code · subscription usage") },
    { id: "opencode", name: "OpenCode", detail: t("OpenAI Chat Completions 兼容 Agent", "OpenAI Chat Completions-compatible agent") },
    { id: "deepseek", name: "DeepSeek", detail: t("本机 Agent 环境", "Local agent runtime") },
    { id: "trae", name: "Trae", detail: t("本机 Agent 环境", "Local agent runtime") },
  ] as const;

  const refresh = (force = true): void => {
    const generation = ++refreshGeneration.current;
    setRefreshError(undefined);
    setUsageLoading(true);
    setAccountsLoading(true);
    accountsLoadingRef.current = true;
    const accountsRequest = window.prospero.accountAction({ type: "agent.accounts.list", requestId: crypto.randomUUID() }).finally(() => {
      if (generation !== refreshGeneration.current) return;
      accountsLoadingRef.current = false;
      setAccountsLoading(false);
    });
    void Promise.allSettled([
      accountsRequest,
      loadAccountUsage(force),
    ]).then(([accountsResult, usageResult]) => {
      if (generation !== refreshGeneration.current) return;
      if (usageResult.status === "fulfilled") setUsage(usageResult.value);
      const failures = [accountsResult, usageResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => displayError(result.reason));
      setRefreshError(failures.length ? failures.join(" ") : undefined);
    }).finally(() => {
      if (generation === refreshGeneration.current) setUsageLoading(false);
    });
  };
  useEffect(() => {
    refresh(false);
    return () => { refreshGeneration.current += 1; };
  }, []);

  const begin = (key: string): boolean => {
    if (busyRef.current || accountsLoadingRef.current) return false;
    busyRef.current = key;
    setBusy(key);
    setActionError(undefined);
    setNotice(undefined);
    return true;
  };

  const finish = (key: string): void => {
    if (busyRef.current !== key) return;
    busyRef.current = undefined;
    setBusy(undefined);
  };

  const openAccountSession = (sessionId: string, account: JsonObject): void => {
    onOpenSession(sessionId, provisionalAccountLoginSession(account, sessionId));
    void window.prospero.listSessions({ ids: [sessionId], limit: 1 }).then((page) => {
      const session = page.items.find((item) => item.id === sessionId);
      if (session) onOpenSession(sessionId, session);
    }).catch(() => undefined);
  };

  const runAction = async (account: JsonObject, type: "agent.account.default" | "agent.account.login" | "agent.account.logout" | "agent.account.delete"): Promise<void> => {
    const accountId = text(account["id"]);
    const key = `${accountId}:${type}`;
    if (!begin(key)) return;
    try {
      const result = await window.prospero.accountAction({ type, requestId: crypto.randomUUID(), accountId, ...(type === "agent.account.login" ? { cols: 120, rows: 40 } : {}) });
      if (result["cancelled"] === true) return;
      if (result["ok"] === false) throw new Error(text(result["error"], t("账号操作失败", "Account action failed")));
      const sessionId = text(result["sessionId"]);
      if (sessionId) openAccountSession(sessionId, account);
      if (type === "agent.account.default") setNotice(t("已设为默认账号", "Default account updated"));
      if (type === "agent.account.logout") setNotice(t("账号已退出", "Account signed out"));
      if (type === "agent.account.delete") setNotice(t("账号已删除", "Account deleted"));
      refresh();
    } catch (reason) { setActionError(displayError(reason)); }
    finally { finish(key); }
  };

  const createManaged = async (): Promise<void> => {
    const key = "managed-create";
    const requestedName = name.trim();
    if (!requestedName || !begin(key)) return;
    const existingIds = new Set(snapshot.accounts.map((account) => text(account["id"])).filter(Boolean));
    try {
      const result = await window.prospero.accountAction({ type: "agent.account.create", requestId: crypto.randomUUID(), agent, name: requestedName });
      if (result["ok"] === false) throw new Error(text(result["error"], t("创建账号失败", "Unable to create account")));
      const accounts = Array.isArray(result["accounts"]) ? result["accounts"].map(record) : [];
      const createdId = text(result["accountId"]);
      const created = selectCreatedAccount(accounts, createdId, requestedName, agent, existingIds);
      if (createdId && !created) throw new Error(t("账号已创建，但返回结果缺少对应账号", "The account was created, but its exact result was missing"));
      setName("");
      if (created) {
        const login = await window.prospero.accountAction({ type: "agent.account.login", requestId: crypto.randomUUID(), accountId: text(created["id"]), cols: 120, rows: 40 });
        if (login["ok"] === false) throw new Error(text(login["error"], t("账号已创建，但无法打开登录终端", "The account was created, but the sign-in terminal could not be opened")));
        const sessionId = text(login["sessionId"]);
        if (sessionId) openAccountSession(sessionId, created);
      }
      setNotice(t("独立 CLI 账号已创建", "Isolated CLI account created"));
      refresh();
    } catch (reason) { setActionError(displayError(reason)); }
    finally { finish(key); }
  };

  const createApi = async (): Promise<void> => {
    const key = "api-create";
    const requestedName = name.trim();
    const requestedBaseUrl = baseUrl.trim();
    const requestedModel = model.trim();
    if (!requestedName || !credential || !requestedBaseUrl || !requestedModel || !begin(key)) return;
    try {
      const result = await window.prospero.accountAction({ type: "agent.account.api.create", requestId: crypto.randomUUID(), agent: accountApiProtocolDefaults(effectiveProtocol).agent, ...(apiProtocolsSupported ? { provider: accountApiProvider(effectiveProtocol), protocol: effectiveProtocol } : {}), name: requestedName, baseUrl: requestedBaseUrl, model: requestedModel, apiKey: credential });
      if (result["ok"] === false) throw new Error(text(result["error"], t("保存 API Profile 失败", "Unable to save API profile")));
      setName("");
      setCredential("");
      setNotice(t("API Profile 已保存", "API profile saved"));
      refresh();
    } catch (reason) { setActionError(displayError(reason)); }
    finally { finish(key); }
  };

  const error = actionError ?? refreshError;
  const actionsDisabled = busy !== undefined || accountsLoading;
  const currentEditingAccount = editingAccount
    ? snapshot.accounts.find((account) => text(account["id"]) === text(editingAccount["id"])) ?? editingAccount
    : undefined;
  return <div className="page accounts-page">
    <header className="page-header"><div><span className="eyebrow">{t("AGENT 与账号", "AGENTS & ACCOUNTS")}</span><h1>{t("Agent 与账号", "Agents & accounts")}</h1><p>{t("统一管理 Agent、模型来源、CLI / API Profile、登录状态与套餐额度。", "Manage agents, model sources, CLI and API profiles, sign-in state, and plan usage in one place.")}</p></div><button aria-busy={usageLoading || accountsLoading} disabled={usageLoading || actionsDisabled} onClick={() => refresh(true)}><RefreshCw className={usageLoading || accountsLoading ? "daemon-spinner" : ""} size={15} />{usageLoading || accountsLoading ? usage.length > 0 ? t("后台更新", "Updating") : t("读取额度", "Loading usage") : t("刷新额度", "Refresh usage")}</button></header>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {notice && <p className="security-note" role="status" aria-live="polite">{notice}</p>}
    <div className="provider-strip">{providers.map((provider) => {
      const configured = snapshot.accounts.filter((account) => {
        const profile = record(account["apiProfile"]);
        const accountAgent = Object.keys(profile).length > 0
          ? accountApiEngineLabel(accountApiProtocolFromProfile(profile, text(account["agent"]))).toLocaleLowerCase()
          : text(account["agent"]);
        return accountAgent === provider.id;
      }).length;
      const running = snapshot.daemon.sessions.filter((session) => session.agent === provider.id).length;
      return <article className={`provider-card provider-${provider.id}`} key={provider.id}><div className="provider-logo"><AgentLogo agent={provider.id} size={26} /></div><div><strong>{provider.name}</strong><p>{provider.detail}</p></div><span>{configured ? `${String(configured)} ${t("个账号", "accounts")}` : running ? `${String(running)} ${t("个会话", "sessions")}` : t("待配置", "Not configured")}</span></article>;
    })}</div>
    <div className="split-management account-layout"><section><div className="section-title"><UserRound size={16} />{t("已配置账号", "Configured accounts")} <span>{snapshot.accounts.length}</span></div><div className="card-grid account-grid">{snapshot.accounts.map((account) => {
      const id = text(account["id"]); const accountAgent = text(account["agent"]); const managed = account["managed"] === true; const signedIn = text(account["status"]) === "signed_in";
      const accountUsage = usage.find((item) => item.accountId === id) ?? usage.find((item) => !item.accountId && item.agent === accountAgent);
      const accountProfile = record(account["apiProfile"]); const accountProtocol = account["apiProfile"] ? accountApiProtocolFromProfile(accountProfile, accountAgent) : undefined; const displayAgent = accountProtocol ? accountApiEngineLabel(accountProtocol).toLocaleLowerCase() : accountAgent;
      return <article className={`account-card account-card-rich provider-${displayAgent}`} key={id}><div className="account-card-head"><div className="provider-logo"><AgentLogo agent={displayAgent} size={24} /></div><div><strong>{text(account["name"], accountAgent)}</strong><p>{accountProtocol ? `${accountApiProtocolLabel(accountProtocol)} · ${accountApiEngineLabel(accountProtocol)} engine` : accountAgent} · {status(text(account["status"]))}{number(account["activeSessions"]) > 0 ? ` · ${String(number(account["activeSessions"]))} ${t("个会话", "sessions")}` : ""}</p></div>{account["isDefault"] === true && <span className="pill"><Check size={12} />{t("默认", "Default")}</span>}</div><UsageMeters usage={accountUsage} /><div className="button-row compact">{account["isDefault"] !== true && <button aria-busy={busy === `${id}:agent.account.default`} disabled={actionsDisabled} onClick={() => void runAction(account, "agent.account.default")}>{t("设为默认", "Set default")}</button>}{managed && <button disabled={actionsDisabled} onClick={() => { setActionError(undefined); setNotice(undefined); setEditingAccount(account); }}><Pencil size={12} />{t("编辑", "Edit")}</button>}{managed && !account["apiProfile"] && <button aria-busy={busy === `${id}:${signedIn ? "agent.account.logout" : "agent.account.login"}`} disabled={actionsDisabled} onClick={() => void runAction(account, signedIn ? "agent.account.logout" : "agent.account.login")}>{signedIn ? t("退出登录", "Sign out") : t("登录", "Sign in")}</button>}{managed && <button className="danger" aria-busy={busy === `${id}:agent.account.delete`} disabled={actionsDisabled || number(account["activeSessions"]) > 0} onClick={() => void runAction(account, "agent.account.delete")}><Trash2 size={12} />{t("删除", "Delete")}</button>}</div></article>;
    })}{snapshot.accounts.length === 0 && <div className="small-empty">{t("还没有账号。可在右侧创建独立 CLI 登录或 API Profile。", "No accounts yet. Create an isolated CLI login or API profile on the right.")}</div>}</div></section>
      <section className="form-card account-form"><div className="section-title"><Plus size={16} />{t("添加账号", "Add account")}</div><label>{t("CLI Agent", "CLI agent")}<select disabled={actionsDisabled} value={agent} onChange={(event) => { const next = event.target.value as "codex" | "claude"; setAgent(next); if (!apiProtocolsSupported) { const nextProtocol: AccountApiProtocol = next === "claude" ? "anthropic" : "openai_responses"; const defaults = accountApiProtocolDefaults(nextProtocol); setProtocol(nextProtocol); setBaseUrl(defaults.baseUrl); setModel(defaults.model); } }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>{t("显示名称", "Display name")}<input maxLength={80} disabled={actionsDisabled} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("工作账号", "Work account")} /></label><button aria-busy={busy === "managed-create"} onClick={() => void createManaged()} disabled={!name.trim() || actionsDisabled}>{t("创建独立 CLI 账号并登录", "Create isolated CLI account and sign in")}</button><div className="section-label">{t("或添加 API PROFILE", "OR ADD AN API PROFILE")}</div>{apiProtocolsSupported && <label>{t("API 协议", "API protocol")}<select disabled={actionsDisabled} value={protocol} onChange={(event) => { const next = event.target.value as AccountApiProtocol; const defaults = accountApiProtocolDefaults(next); setProtocol(next); setBaseUrl(defaults.baseUrl); setModel(defaults.model); }}>{accountApiProtocols.map((item) => <option key={item} value={item}>{accountApiProtocolLabel(item)}</option>)}</select></label>}<p className="security-note">Agent · {accountApiEngineLabel(effectiveProtocol)} · {effectiveProtocol === "openai_responses" ? t("Responses API，适合 OpenAI 新版模型与兼容服务。", "Responses API for newer OpenAI models and compatible services.") : effectiveProtocol === "openai_chat_completions" ? t("Chat Completions API，使用 OpenCode 引擎。", "Chat Completions API powered by the OpenCode engine.") : t("Anthropic Messages API，适合 Claude 与兼容服务。", "Anthropic Messages API for Claude and compatible services.")}</p><label>{t("API 地址", "API URL")}<input type="url" inputMode="url" maxLength={2_000} spellCheck={false} disabled={actionsDisabled} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label>{t("模型", "Model")}<input maxLength={300} spellCheck={false} disabled={actionsDisabled} value={model} onChange={(event) => setModel(event.target.value)} /></label><label>{effectiveProtocol === "anthropic" ? "Anthropic API Key" : "OpenAI API Key"}<input type="password" maxLength={8_192} disabled={actionsDisabled} value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" /></label><p className="security-note"><KeyRound size={14} />{t("凭据只发送给本机 daemon。", "Credentials are only sent to the local daemon.")}</p><button className="primary" aria-busy={busy === "api-create"} onClick={() => void createApi()} disabled={!name.trim() || !credential || !baseUrl || !model || actionsDisabled}>{t("保存 API Profile", "Save API profile")}</button></section>
    </div>
    {currentEditingAccount && <AccountEditDialog account={currentEditingAccount} apiProtocolsSupported={apiProtocolsSupported} onClose={() => setEditingAccount(undefined)} onSaved={() => { setActionError(undefined); setNotice(t("账号设置已保存", "Account settings saved")); refresh(); }} />}
  </div>;
}

export function DevicesPane({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { language, t } = useLocale();
  const [name, setName] = useState(() => t("我的手机", "My phone"));
  const [allowShell, setAllowShell] = useState(true);
  const [allowOrchestration, setAllowOrchestration] = useState(true);
  const [pair, setPair] = useState<{ output: string; uri?: string; qr?: string }>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pairBusy, setPairBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState<string>();
  const pairBusyRef = useRef(false);
  const copyBusyRef = useRef(false);
  const revokeBusyRef = useRef(false);
  const pairResultRef = useRef<HTMLDivElement>(null);
  const deviceNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pair?.uri) pairResultRef.current?.focus();
  }, [pair?.uri]);
  const createPair = async (): Promise<void> => {
    if (pairBusyRef.current || !name.trim()) return;
    pairBusyRef.current = true;
    setPairBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const { default: QRCode } = await import("qrcode");
      const result = await window.prospero.pairDevice({ name: name.trim(), allowShell, allowOrchestration });
      if (!result.uri) throw new Error(result.output || t("未生成有效的配对串", "No valid pairing code was generated"));
      try {
        const qr = await QRCode.toDataURL(result.uri, { width: 280, margin: 1, color: { dark: "#111318", light: "#ffffff" } });
        setPair({ ...result, qr });
        setNotice(t("配对二维码已生成", "Pairing QR code generated"));
      } catch (reason) {
        setPair(result);
        setError(t(`二维码生成失败，仍可复制配对串：${displayError(reason)}`, `QR code generation failed. You can still copy the pairing code: ${displayError(reason)}`));
      }
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      pairBusyRef.current = false;
      setPairBusy(false);
    }
  };
  const copyPair = async (): Promise<void> => {
    if (!pair?.uri || copyBusyRef.current) return;
    copyBusyRef.current = true;
    setCopyBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero.writeClipboard(pair.uri);
      if (!result.ok) throw new Error(t("复制失败", "Copy failed"));
      setNotice(t("配对串已复制", "Pairing code copied"));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      copyBusyRef.current = false;
      setCopyBusy(false);
    }
  };
  const revoke = async (device: DeviceInfo, key: string): Promise<void> => {
    if (revokeBusyRef.current) return;
    revokeBusyRef.current = true;
    setRevokeBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero.revokeDevice(device.id, device.name);
      if (result.cancelled) return;
      if (!result.ok) throw new Error(result.output || t("撤销设备失败", "Unable to revoke device"));
      setNotice(t(`已撤销设备“${device.name}”`, `Revoked “${device.name}”`));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      revokeBusyRef.current = false;
      setRevokeBusy(undefined);
    }
  };
  return (
    <div className="page devices-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">{t("远程控制", "REMOTE CONTROL")}</span>
          <h1>{t("移动端", "Mobile")}</h1>
          <p>{t("配对手机，在移动端安全地查看会话、回复问题并管理 Agent 运行。", "Pair a phone to securely inspect sessions, answer questions, and manage agent runs on mobile.")}</p>
        </div>
      </header>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="security-note" role="status" aria-live="polite">{notice}</p>}
      <div className="split-management">
        <section aria-labelledby="paired-devices-title">
          <h2 id="paired-devices-title" className="section-title">
            <MonitorSmartphone size={16} aria-hidden="true" />
            {t("已配对设备", "Paired devices")}
            <span>{snapshot.devices.length}</span>
          </h2>
          <div className="device-list" role={snapshot.devices.length > 0 ? "list" : undefined}>
            {snapshot.devices.map((device, index) => {
              const key = deviceRenderKey(device, index);
              return (
                <article className="device-card" key={key} role="listitem">
                  <div className="device-icon" aria-hidden="true"><MonitorSmartphone size={20} /></div>
                  <div>
                    <strong title={device.name}>{device.name}</strong>
                    <p>
                      {device.bound ? t("已绑定", "Paired") : t("等待首次连接", "Awaiting first connection")} · {device.lastSeenAt
                        ? new Date(device.lastSeenAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")
                        : t("从未连接", "Never connected")}
                    </p>
                    <div className="tag-row">
                      <span className="pill">{device.allowShell ? "Shell" : t("只读", "Read only")}</span>
                      {device.allowOrchestration && <span className="pill">{t("编排", "Orchestration")}</span>}
                    </div>
                  </div>
                  <button
                    className="icon-button danger"
                    title={t(`撤销 ${device.name}`, `Revoke ${device.name}`)}
                    aria-label={t(`撤销设备 ${device.name}`, `Revoke device ${device.name}`)}
                    aria-busy={revokeBusy === key}
                    disabled={revokeBusy !== undefined}
                    onClick={() => void revoke(device, key)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </article>
              );
            })}
            {snapshot.devices.length === 0 && (
              <div className="small-empty" role="status">
                {t("还没有已配对设备。", "No devices are paired yet.")}
              </div>
            )}
          </div>
        </section>
        <section className="form-card self-start" aria-labelledby="pair-phone-title" aria-busy={pairBusy}>
          <h2 id="pair-phone-title" className="section-title">
            <Link2 size={16} aria-hidden="true" />
            {t("配对手机", "Pair phone")}
          </h2>
          {pair?.uri ? (
            <div
              ref={pairResultRef}
              className="pair-result"
              role="region"
              aria-label={t("新设备配对信息", "New device pairing information")}
              tabIndex={-1}
            >
              {pair.qr ? (
                <img src={pair.qr} alt={t("配对二维码", "Pairing QR code")} />
              ) : (
                <div className="small-empty" role="status">
                  {t("二维码暂不可用，请复制配对串手动输入。", "The QR code is unavailable. Copy the pairing code and enter it manually.")}
                </div>
              )}
              <p>{t("配对内容含访问凭据，请勿截图或转发。", "The pairing data contains access credentials. Do not share it.")}</p>
              <button aria-busy={copyBusy} disabled={copyBusy} onClick={() => void copyPair()}>
                <Copy size={14} aria-hidden="true" />
                {copyBusy ? t("复制中", "Copying") : t("复制配对串", "Copy pairing code")}
              </button>
              <button
                disabled={copyBusy}
                onClick={() => {
                  setPair(undefined);
                  setError(undefined);
                  setNotice(undefined);
                  window.requestAnimationFrame(() => deviceNameRef.current?.focus());
                }}
              >
                {t("返回", "Back")}
              </button>
            </div>
          ) : (
            <>
              <label htmlFor="pair-device-name">{t("设备名称", "Device name")}</label>
              <input
                ref={deviceNameRef}
                id="pair-device-name"
                maxLength={80}
                value={name}
                disabled={pairBusy}
                onChange={(event) => setName(event.target.value)}
              />
              <label className="check-row" htmlFor="pair-allow-shell">
                <input
                  id="pair-allow-shell"
                  type="checkbox"
                  checked={allowShell}
                  disabled={pairBusy}
                  onChange={(event) => {
                    setAllowShell(event.target.checked);
                    if (!event.target.checked) setAllowOrchestration(false);
                  }}
                />
                {t("允许 Shell / Agent 会话", "Allow Shell / Agent sessions")}
              </label>
              <label className="check-row" htmlFor="pair-allow-orchestration">
                <input
                  id="pair-allow-orchestration"
                  type="checkbox"
                  checked={allowOrchestration}
                  disabled={!allowShell || pairBusy}
                  onChange={(event) => setAllowOrchestration(event.target.checked)}
                />
                {t("允许创建任务与派发 worker", "Allow task creation and worker dispatch")}
              </label>
              <button className="primary" aria-busy={pairBusy} disabled={pairBusy || !name.trim()} onClick={() => void createPair()}>
                <Plus size={14} aria-hidden="true" />
                {pairBusy ? t("正在生成", "Generating") : t("生成二维码", "Generate QR code")}
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function LogsPane({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const busyRef = useRef(false);
  const clear = async (): Promise<void> => {
    if (busyRef.current || !snapshot.logs) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero.clearLogs();
      if (result.cancelled) return;
      if (!result.ok) throw new Error(t("日志未能清空", "Logs could not be cleared"));
      setNotice(t("诊断日志已清空", "Diagnostic logs cleared"));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return <div className="page logs-page"><header className="page-header"><div><span className="eyebrow">{t("结构化日志", "STRUCTURED LOGS")}</span><h1>{t("诊断", "Diagnostics")}</h1><p>{t("按需检查 daemon、relay 与 terminal 日志；敏感令牌会在写入前遮盖。", "Inspect daemon, relay, and terminal logs when needed. Sensitive tokens are redacted before writing.")}</p>{error && <div className="inline-error" role="alert">{error}</div>}{notice && <p className="security-note" role="status" aria-live="polite">{notice}</p>}</div><button aria-busy={busy} disabled={busy || !snapshot.logs} onClick={() => void clear()}><Trash2 size={14} aria-hidden="true" />{busy ? t("清空中", "Clearing") : t("清空", "Clear")}</button></header><pre className="log-view">{snapshot.logs || t("暂无日志。启动 daemon 后，运行信息会出现在这里。", "No logs yet. Runtime details will appear here after the daemon starts.")}</pre></div>;
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
  const [terminalFontFamilyDraft, setTerminalFontFamilyDraft] = useState(settings.terminalFontFamily);
  const [terminalFontSizeDraft, setTerminalFontSizeDraft] = useState(String(settings.terminalFontSize));
  const [terminalFontFamilySaveState, setTerminalFontFamilySaveState] = useState<TerminalSaveState>("idle");
  const [terminalFontSizeSaveState, setTerminalFontSizeSaveState] = useState<TerminalSaveState>("idle");
  const [terminalFontFamilyError, setTerminalFontFamilyError] = useState<string>();
  const [terminalFontSizeError, setTerminalFontSizeError] = useState<string>();
  const terminalFontFamilyGeneration = useRef(0);
  const terminalFontSizeGeneration = useRef(0);
  const terminalFontFamilySaveStateRef = useRef<TerminalSaveState>("idle");
  const terminalFontSizeSaveStateRef = useRef<TerminalSaveState>("idle");
  const [relay, setRelay] = useState<Record<string, unknown>>(snapshot.daemon.relay);
  const [relayUrl, setRelayUrl] = useState("");
  const [relayBusy, setRelayBusy] = useState<"status" | "enable" | "disable" | "rotate-key">();
  const relayBusyRef = useRef(false);
  const relayUrlDirtyRef = useRef(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [settingsBusy, setSettingsBusy] = useState(false);
  const settingsBusyRef = useRef(false);
  const [fullAccessBusy, setFullAccessBusy] = useState(false);
  const fullAccessBusyRef = useRef(false);
  const [daemonBusy, setDaemonBusy] = useState<"start" | "restart" | "stop">();
  const daemonBusyRef = useRef(false);
  terminalFontFamilySaveStateRef.current = terminalFontFamilySaveState;
  terminalFontSizeSaveStateRef.current = terminalFontSizeSaveState;
  useEffect(() => {
    if (["dirty", "saving", "error"].includes(terminalFontFamilySaveStateRef.current)) return;
    setTerminalFontFamilyDraft(settings.terminalFontFamily);
  }, [settings.terminalFontFamily]);
  useEffect(() => {
    if (["dirty", "saving", "error"].includes(terminalFontSizeSaveStateRef.current)) return;
    setTerminalFontSizeDraft(String(settings.terminalFontSize));
  }, [settings.terminalFontSize]);
  useEffect(() => {
    setRelay(snapshot.daemon.relay);
    if (!relayUrlDirtyRef.current && typeof snapshot.daemon.relay["url"] === "string") {
      setRelayUrl(snapshot.daemon.relay["url"]);
    }
  }, [snapshot.daemon.relay]);
  const update = async (patch: Partial<typeof settings>): Promise<void> => {
    if (settingsBusyRef.current) return;
    settingsBusyRef.current = true;
    setSettingsBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await window.prospero.updateSettings(patch);
      setNotice(t("设置已保存", "Settings saved"));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      settingsBusyRef.current = false;
      setSettingsBusy(false);
    }
  };
  const saveTerminalFontFamily = async (): Promise<void> => {
    if (!terminalFontFamilyDraft.trim()) {
      setTerminalFontFamilyError(t("字体名称不能为空", "Font family cannot be empty"));
      setTerminalFontFamilySaveState("error");
      return;
    }
    if (terminalFontFamilyDraft.trim() === settings.terminalFontFamily) {
      setTerminalFontFamilyDraft(settings.terminalFontFamily);
      setTerminalFontFamilyError(undefined);
      setTerminalFontFamilySaveState("saved");
      return;
    }
    const generation = ++terminalFontFamilyGeneration.current;
    setTerminalFontFamilySaveState("saving");
    setTerminalFontFamilyError(undefined);
    try {
      const next = await window.prospero.updateSettings({ terminalFontFamily: terminalFontFamilyDraft.trim() });
      if (generation !== terminalFontFamilyGeneration.current) return;
      setTerminalFontFamilyDraft(next.settings.terminalFontFamily);
      setTerminalFontFamilySaveState("saved");
    } catch (reason) {
      if (generation !== terminalFontFamilyGeneration.current) return;
      setTerminalFontFamilyError(displayError(reason));
      setTerminalFontFamilySaveState("error");
    }
  };
  const saveTerminalFontSize = async (): Promise<void> => {
    const value = terminalFontSize(terminalFontSizeDraft);
    if (value === undefined) {
      setTerminalFontSizeError(t("字号必须是 8–48 的整数", "Font size must be an integer from 8 to 48"));
      setTerminalFontSizeSaveState("error");
      return;
    }
    if (value === settings.terminalFontSize) {
      setTerminalFontSizeDraft(String(settings.terminalFontSize));
      setTerminalFontSizeError(undefined);
      setTerminalFontSizeSaveState("saved");
      return;
    }
    const generation = ++terminalFontSizeGeneration.current;
    setTerminalFontSizeSaveState("saving");
    setTerminalFontSizeError(undefined);
    try {
      const next = await window.prospero.updateSettings({ terminalFontSize: value });
      if (generation !== terminalFontSizeGeneration.current) return;
      setTerminalFontSizeDraft(String(next.settings.terminalFontSize));
      setTerminalFontSizeSaveState("saved");
    } catch (reason) {
      if (generation !== terminalFontSizeGeneration.current) return;
      setTerminalFontSizeError(displayError(reason));
      setTerminalFontSizeSaveState("error");
    }
  };
  const updateFullAccess = async (checked: boolean): Promise<void> => {
    if (fullAccessBusyRef.current || daemonBusyRef.current) return;
    fullAccessBusyRef.current = true;
    setError(undefined);
    setNotice(undefined);
    setFullAccessBusy(true);
    try {
      await window.prospero.updateSettings({ fullAccessPermission: checked });
      setNotice(checked ? t("已开启完整访问权限", "Full access enabled") : t("已关闭完整访问权限", "Full access disabled"));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      fullAccessBusyRef.current = false;
      setFullAccessBusy(false);
    }
  };
  const relayAction = async (action: "status" | "enable" | "disable" | "rotate-key"): Promise<void> => {
    if (relayBusyRef.current) return;
    if (action === "enable" && relayUrl.trim()) {
      try {
        if (new URL(relayUrl.trim()).protocol !== "wss:") throw new Error();
      } catch {
        setError(t("请输入有效的 wss:// Relay 地址", "Enter a valid wss:// relay URL"));
        return;
      }
    }
    relayBusyRef.current = true;
    setRelayBusy(action);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero.relayAction({ action, ...(action === "enable" && relayUrl.trim() ? { url: relayUrl.trim() } : {}) });
      if (result["cancelled"] === true) return;
      if (result["ok"] === false) throw new Error(text(result["output"], t("Relay 操作失败", "Relay action failed")));
      if (action === "status") {
        setRelay(result);
        if (!relayUrlDirtyRef.current && typeof result["url"] === "string") setRelayUrl(result["url"]);
        return;
      }
      relayUrlDirtyRef.current = false;
      setNotice(action === "enable"
        ? t("Relay 已启用", "Relay enabled")
        : action === "disable"
          ? t("Relay 已关闭", "Relay disabled")
          : t("Relay 密钥已轮换", "Relay key rotated"));
      try {
        const statusResult = await window.prospero.relayAction({ action: "status" });
        setRelay(statusResult);
        if (typeof statusResult["url"] === "string") setRelayUrl(statusResult["url"]);
      } catch (reason) {
        setError(t(
          `操作已完成，但状态刷新失败：${displayError(reason)}`,
          `The action completed, but status refresh failed: ${displayError(reason)}`,
        ));
      }
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      relayBusyRef.current = false;
      setRelayBusy(undefined);
    }
  };
  useEffect(() => { void relayAction("status"); }, []);
  const daemonAction = async (action: "start" | "restart" | "stop"): Promise<void> => {
    if (daemonBusyRef.current || fullAccessBusyRef.current) return;
    daemonBusyRef.current = true;
    setDaemonBusy(action);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero[action === "start" ? "startDaemon" : action === "restart" ? "restartDaemon" : "stopDaemon"]();
      if (!result.ok) throw new Error(result.error || t("Daemon 操作失败", "Daemon action failed"));
      setNotice(action === "start"
        ? t("Daemon 已启动", "Daemon started")
        : action === "restart"
          ? t("Daemon 已重启", "Daemon restarted")
          : t("Daemon 已停止", "Daemon stopped"));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      daemonBusyRef.current = false;
      setDaemonBusy(undefined);
    }
  };
  const desktopToggle = (id: string, title: string, description: string, checked: boolean, change: (checked: boolean) => void): React.ReactNode => (
    <Field orientation="horizontal" className="desktop-setting-row">
      <FieldContent><FieldLabel htmlFor={id}>{title}</FieldLabel><FieldDescription>{description}</FieldDescription></FieldContent>
      <Checkbox id={id} aria-busy={settingsBusy} disabled={settingsBusy} checked={checked} onCheckedChange={change} />
    </Field>
  );
  const terminalSaveState: TerminalSaveState = terminalFontFamilySaveState === "error" || terminalFontSizeSaveState === "error"
    ? "error"
    : terminalFontFamilySaveState === "saving" || terminalFontSizeSaveState === "saving"
      ? "saving"
      : terminalFontFamilySaveState === "dirty" || terminalFontSizeSaveState === "dirty"
        ? "dirty"
        : terminalFontFamilySaveState === "saved" || terminalFontSizeSaveState === "saved"
          ? "saved"
          : "idle";
  const terminalSaveError = terminalFontFamilyError ?? terminalFontSizeError;
  const terminalSaveMessage = terminalSaveState === "dirty"
    ? t("有未保存的更改", "Unsaved changes")
    : terminalSaveState === "saving"
      ? t("正在保存终端设置…", "Saving terminal settings…")
      : terminalSaveState === "saved"
        ? t("终端设置已保存", "Terminal settings saved")
        : terminalSaveState === "error"
          ? terminalSaveError
          : t("按 Enter 或移开焦点保存。", "Press Enter or move focus away to save.");
  const relayState = text(relay["state"], "disabled");
  const relayEnabled = relay["enabled"] === true || relay["enabled"] === "true";
  const relayView = relayPresentation(relayState, relayEnabled);
  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">{t("偏好设置", "PREFERENCES")}</span>
          <h1>{t("设置", "Settings")}</h1>
          <p>{t("桌面行为、终端外观、daemon 与 Relay。", "Desktop behavior, terminal appearance, daemon, and relay.")}</p>
        </div>
      </header>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="security-note" role="status" aria-live="polite">{notice}</p>}
      <div className="settings-grid">
        <div className="settings-column">
          <section className="settings-card desktop-settings-card self-start" aria-labelledby="desktop-settings-title">
            <h2 id="desktop-settings-title" className="section-title">
              <Settings2 size={16} aria-hidden="true" />
              {t("桌面端", "Desktop")}
            </h2>
            <FieldGroup className="desktop-settings-list">
              {desktopToggle("start-daemon-on-launch", t("启动本地服务", "Start local service"), t("打开客户端时自动启动 daemon。", "Start the daemon when the client opens."), settings.startDaemonOnLaunch, (checked) => update({ startDaemonOnLaunch: checked }))}
              {desktopToggle("minimize-to-tray", t("在后台运行", "Keep running in background"), t("关闭主窗口后保留托盘进程。", "Keep the tray process running after the main window closes."), settings.minimizeToTray, (checked) => update({ minimizeToTray: checked }))}
              {desktopToggle("launch-at-login", t("开机启动", "Launch at sign-in"), t("登录系统后自动打开 Prospero。", "Open Prospero automatically after signing in."), settings.launchAtLogin, (checked) => update({ launchAtLogin: checked }))}
              <FieldGroup className="desktop-select-grid">
                <Field>
                  <FieldLabel htmlFor="desktop-theme">{t("主题", "Theme")}</FieldLabel>
                  <NativeSelect id="desktop-theme" disabled={settingsBusy} value={settings.theme} onChange={(event) => void update({ theme: event.target.value as typeof settings.theme })}>
                    <NativeSelectOption value="system">{t("跟随系统", "System")}</NativeSelectOption>
                    <NativeSelectOption value="dark">{t("深色", "Dark")}</NativeSelectOption>
                    <NativeSelectOption value="light">{t("浅色", "Light")}</NativeSelectOption>
                  </NativeSelect>
                  <FieldDescription>{t("侧边栏和内容区域始终使用同一主题。", "The sidebar and content area always use the same theme.")}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="interface-language">{t("界面语言", "Interface language")}</FieldLabel>
                  <NativeSelect id="interface-language" value={language} onChange={(event) => setLanguage(event.target.value === "en" ? "en" : "zh")}>
                    <NativeSelectOption value="zh">中文</NativeSelectOption>
                    <NativeSelectOption value="en">English</NativeSelectOption>
                  </NativeSelect>
                  <FieldDescription>{t("语言选择会保存在这台设备上。", "Your language choice is saved on this device.")}</FieldDescription>
                </Field>
              </FieldGroup>
              <Field>
                <FieldLabel htmlFor="daemon-bind">{t("监听网卡", "Listening interface")}</FieldLabel>
                <NativeSelect id="daemon-bind" disabled={settingsBusy} value={settings.daemonBind} onChange={(event) => void update({ daemonBind: event.target.value })}>
                  <NativeSelectOption value="0.0.0.0">{t("全部网卡", "All interfaces")}</NativeSelectOption>
                  {interfaces.map((item) => <NativeSelectOption key={item.address} value={item.address}>{item.label}</NativeSelectOption>)}
                </NativeSelect>
                <FieldDescription>{t("下次启动 daemon 时生效。同时挂着 WireGuard 之类虚拟网卡时，绑定到具体网卡更容易排查直连问题。", "Applies the next time the daemon starts. Binding a specific interface makes direct connections easier to diagnose when virtual adapters like WireGuard are present.")}</FieldDescription>
              </Field>
            </FieldGroup>
          </section>
          <section className="settings-card self-start" aria-labelledby="daemon-settings-title">
            <h2 id="daemon-settings-title" className="section-title"><Server size={16} aria-hidden="true" />Daemon</h2>
            <div className="runtime-state" role="status" aria-live="polite">
              <span className={`status-dot ${snapshot.daemon.state}`} aria-hidden="true" />
              <div>
                <strong>{status(snapshot.daemon.state)}</strong>
                <p>{snapshot.daemon.pid ? `PID ${snapshot.daemon.pid} · 127.0.0.1:${snapshot.daemon.port}` : t("尚未运行", "Not running")}</p>
              </div>
            </div>
            <div className="button-row">
              <button className="primary" aria-busy={daemonBusy === "start" || snapshot.daemon.starting} onClick={() => void daemonAction("start")} disabled={Boolean(daemonBusy) || fullAccessBusy || snapshot.daemon.running || snapshot.daemon.starting}>{daemonBusy === "start" || snapshot.daemon.starting ? t("启动中…", "Starting…") : t("启动", "Start")}</button>
              <button aria-busy={daemonBusy === "restart"} onClick={() => void daemonAction("restart")} disabled={Boolean(daemonBusy) || fullAccessBusy || !snapshot.daemon.managed}>{daemonBusy === "restart" ? t("重启中…", "Restarting…") : t("重启", "Restart")}</button>
              <button className="danger" aria-busy={daemonBusy === "stop"} onClick={() => void daemonAction("stop")} disabled={Boolean(daemonBusy) || fullAccessBusy || !snapshot.daemon.managed}>{daemonBusy === "stop" ? t("停止中…", "Stopping…") : t("停止", "Stop")}</button>
            </div>
            <p className="security-note"><CircleAlert size={14} aria-hidden="true" />{t("外部启动的 daemon 只连接、不强杀；控制令牌不会暴露给 UI。", "Externally started daemons are attached, never force-killed. Control tokens are not exposed to the UI.")}</p>
          </section>
        </div>
        <div className="settings-column">
          {isWindows && (
            <section className="settings-card permission-settings-card self-start" aria-labelledby="permission-settings-title">
              <h2 id="permission-settings-title" className="section-title"><ShieldCheck size={16} aria-hidden="true" />{t("权限设置", "Permissions")}</h2>
              <FieldGroup>
                <Field orientation="horizontal" className="desktop-setting-row">
                  <FieldContent>
                    <FieldLabel htmlFor="full-access-permission">{t("完整访问权限", "Full access")}</FieldLabel>
                    <FieldDescription>{t("通过 Windows UAC 以管理员身份运行 daemon；之后启动的 Agent 会继承管理员权限。", "Run the daemon through Windows UAC. Agents launched afterward inherit administrator access.")}</FieldDescription>
                  </FieldContent>
                  <Switch id="full-access-permission" aria-busy={fullAccessBusy} checked={settings.fullAccessPermission} disabled={fullAccessBusy || Boolean(daemonBusy)} onCheckedChange={(checked) => void updateFullAccess(checked)} />
                </Field>
              </FieldGroup>
              <p className="security-note"><CircleAlert size={14} aria-hidden="true" />{
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
            </section>
          )}
          <section className="settings-card self-start" aria-labelledby="relay-settings-title">
            <h2 id="relay-settings-title" className="section-title"><Wifi size={16} aria-hidden="true" />Relay</h2>
            <div className="runtime-state" role="status" aria-live="polite">
              <span className={`status-dot ${relayView.dot}`} aria-hidden="true" />
              <div>
                <strong>{t(relayView.zh, relayView.en)}</strong>
                <p title={text(relay["url"])}>{text(relay["url"], t("用于公网访问的可选自托管中继", "Optional self-hosted relay for public access"))}</p>
              </div>
            </div>
            <label htmlFor="relay-url">{t("WSS 地址", "WSS URL")}</label>
            <input id="relay-url" type="url" inputMode="url" maxLength={2_000} spellCheck={false} disabled={Boolean(relayBusy)} value={relayUrl} onChange={(event) => { relayUrlDirtyRef.current = true; setRelayUrl(event.target.value); }} placeholder="wss://relay.example.com" />
            <div className="button-row">
              <button className="primary" aria-busy={relayBusy === "enable"} disabled={Boolean(relayBusy)} onClick={() => void relayAction("enable")}>{relayBusy === "enable" ? t("启用中…", "Enabling…") : t("启用", "Enable")}</button>
              <button aria-busy={relayBusy === "disable"} disabled={Boolean(relayBusy)} onClick={() => void relayAction("disable")}>{relayBusy === "disable" ? t("关闭中…", "Disabling…") : t("关闭", "Disable")}</button>
              <button className="danger" aria-busy={relayBusy === "rotate-key"} disabled={Boolean(relayBusy)} onClick={() => void relayAction("rotate-key")}>{relayBusy === "rotate-key" ? t("轮换中…", "Rotating…") : t("轮换密钥", "Rotate key")}</button>
            </div>
            <p className="security-note"><CircleAlert size={14} aria-hidden="true" />{t("轮换后所有设备都需要重新配对，执行前会再次确认。", "All devices must pair again after rotation. You will be asked to confirm first.")}</p>
          </section>
          <section className="settings-card self-start" aria-labelledby="terminal-settings-title">
            <h2 id="terminal-settings-title" className="section-title"><Settings2 size={16} aria-hidden="true" />{t("终端", "Terminal")}</h2>
            <label htmlFor="terminal-font-family">{t("等宽字体", "Monospaced font")}</label>
            <input
              id="terminal-font-family"
              maxLength={200}
              spellCheck={false}
              value={terminalFontFamilyDraft}
              aria-busy={terminalFontFamilySaveState === "saving"}
              aria-describedby={!terminalSaveError || terminalFontFamilyError ? "terminal-save-status" : undefined}
              aria-invalid={Boolean(terminalFontFamilyError)}
              onChange={(event) => { terminalFontFamilyGeneration.current += 1; setTerminalFontFamilyDraft(event.target.value); setTerminalFontFamilyError(undefined); setTerminalFontFamilySaveState("dirty"); }}
              onBlur={() => void saveTerminalFontFamily()}
              onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "Enter") event.currentTarget.blur(); }}
            />
            <label htmlFor="terminal-font-size">{t("字号", "Font size")}</label>
            <input
              id="terminal-font-size"
              type="number"
              min={8}
              max={48}
              value={terminalFontSizeDraft}
              aria-busy={terminalFontSizeSaveState === "saving"}
              aria-describedby={!terminalSaveError || terminalFontSizeError ? "terminal-save-status" : undefined}
              aria-invalid={Boolean(terminalFontSizeError)}
              onChange={(event) => { terminalFontSizeGeneration.current += 1; setTerminalFontSizeDraft(event.target.value); setTerminalFontSizeError(undefined); setTerminalFontSizeSaveState("dirty"); }}
              onBlur={() => void saveTerminalFontSize()}
              onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "Enter") event.currentTarget.blur(); }}
            />
            <p id="terminal-save-status" className={`security-note${terminalSaveState === "error" ? " text-destructive" : ""}`} role={terminalSaveState === "error" ? "alert" : "status"} aria-live="polite">{terminalSaveMessage}</p>
            <div className="terminal-preview" aria-label={t("终端预览", "Terminal preview")} style={{ fontFamily: terminalFontFamilyDraft || settings.terminalFontFamily, fontSize: terminalFontSize(terminalFontSizeDraft) ?? settings.terminalFontSize }}>{isMac ? "zsh % codex" : "PS C:\\Prospero> codex"}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
