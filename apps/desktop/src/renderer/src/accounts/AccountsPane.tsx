import { useRef, useState } from "react";
import type { DesktopSnapshot, JsonObject, SessionInfo } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { accountEngine } from "../../../shared/account-capabilities";
import { supportsAccountApiEngineValidation, supportsAccountApiProtocols, supportsAccountApiValidation } from "../account-profile-form";
import { AgentLogo } from "../AgentLogo";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import { text } from "../state";
import { AccountCard } from "./AccountCard";
import { AccountCreateForm } from "./AccountCreateForm";
import { AccountEditDialog } from "./AccountEditDialog";
import { AdvancedConfigEditor } from "./AdvancedConfigEditor";
import { useAccountActions } from "./use-account-actions";
import "./accounts.css";
import { ModelSourcesPane } from "../model-sources/ModelSourcesPane";
import type { SourceSelection } from "../model-sources/source-state";

export function AccountsPane({ snapshot, onOpenSession, onUseModelSource }: { snapshot: DesktopSnapshot; onOpenSession: (id: string, session?: SessionInfo) => void; onUseModelSource: (selection: SourceSelection) => void }) {
  const { t } = useLocale();
  const actions = useAccountActions(snapshot, onOpenSession);
  const [editing, setEditing] = useState<JsonObject>();
  const [configuring, setConfiguring] = useState<JsonObject>();
  const [showBindings, setShowBindings] = useState(false);
  const visibleAccounts = snapshot.accounts.filter(account => showBindings || !account.modelSource);
  const createForm = useRef<HTMLElement>(null);
  const capabilities = snapshot.daemon.capabilities;
  const apiProtocolsSupported = supportsAccountApiProtocols(capabilities);
  const apiValidationSupported = supportsAccountApiValidation(capabilities);
  const engineValidationSupported = supportsAccountApiEngineValidation(capabilities);
  const catalogSupported = capabilities?.includes("agent.account.api.models") === true && typeof window.prospero.getAccountModels === "function";
  const configSupported = capabilities?.includes("agent.account.config") === true && typeof window.prospero.getAccountConfig === "function";
  const disabled = Boolean(actions.busy || actions.loading || editing || configuring || !snapshot.daemon.running);
  const edited = editing ? snapshot.accounts.find(account => account["id"] === editing["id"]) ?? editing : undefined;
  const providers = [
    ["codex", "Codex"], ["claude", "Claude"], ["opencode", "OpenCode"], ["deepseek", "DeepSeek"], ["trae", "Trae"],
  ] as const;
  return <div className="page accounts-page">
    <header className="page-header"><div><h1>{t("Agent 与账号", "Agents & accounts")}</h1><p>{t("管理模型连接、账号与启动配置。", "Manage model connections, accounts, and startup settings.")}</p></div>
      <div className="button-row">
        <Button variant="outline" size="sm" disabled={actions.loading || Boolean(actions.busy)} aria-busy={actions.loading} onClick={() => void actions.refresh(true)}><DesktopIcon name="refresh" className={actions.loading ? "daemon-spinner" : undefined} />{actions.loading ? t("更新中", "Updating") : t("刷新", "Refresh")}</Button>
        <Button size="sm" disabled={disabled} onClick={() => { createForm.current?.scrollIntoView({ block: "nearest" }); createForm.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus(); }}><DesktopIcon name="add" />{t("添加账号", "Add account")}</Button>
      </div>
    </header>
    {actions.refreshError && <div className="account-inline-error" role="alert">{actions.refreshError}<Button variant="ghost" size="sm" disabled={actions.loading} onClick={() => void actions.refresh(true)}>{t("重试", "Retry")}</Button></div>}
    {actions.notice && <p className="security-note" role="status">{actions.notice}</p>}
    <ModelSourcesPane snapshot={snapshot} onUse={onUseModelSource} />
    <div className="provider-strip">{providers.map(([id, name]) => {
      const count = visibleAccounts.filter(account => accountEngine(account) === id).length;
      return <article className={"provider-card provider-" + id} key={id}><div className="provider-logo"><AgentLogo agent={id} size={24} /></div><div><strong>{name}</strong><p>{count + " " + t("个账号", "accounts")}</p></div></article>;
    })}</div>
    <div className="split-management account-layout">
      <section><div className="section-title"><DesktopIcon name="accounts" />{t("CLI 账号与独立 Profile", "CLI accounts & independent profiles")} <span>{visibleAccounts.length}</span></div>
        {snapshot.accounts.some(account => account.modelSource) && <label className="model-source-bound-toggle"><input type="checkbox" checked={showBindings} onChange={event => setShowBindings(event.target.checked)} />{t("显示模型源的会话绑定版本", "Show pinned model-source account versions")}</label>}
        <div className="card-grid account-grid">{visibleAccounts.map(account => {
          const id = text(account["id"]);
          const usage = actions.usage.find(item => item.accountId === id) ?? actions.usage.find(item => !item.accountId && item.agent === account["agent"]);
          return <AccountCard key={id} account={account} usage={usage} disabled={disabled} busy={actions.busy}
            error={actions.error?.key.startsWith(id + ":") ? actions.error.message : undefined}
            apiValidationSupported={apiValidationSupported} engineValidationSupported={engineValidationSupported} configSupported={configSupported}
            onAction={actions.runAction} onEdit={() => setEditing(account)} onConfig={() => setConfiguring(account)} />;
        })}</div>
        {!visibleAccounts.length && <div className="small-empty">{t("没有独立账号，可在此添加 CLI 登录账号，或使用上方的共享模型源。", "No independent accounts. Add a CLI account or use a shared model source above.")}</div>}
      </section>
      <section ref={createForm} className="form-card account-form"><div className="section-title"><DesktopIcon name="add" />{t("添加账号", "Add account")}</div>
        <AccountCreateForm capabilities={capabilities} disabled={disabled} busy={actions.busy === "api-create" || actions.busy === "managed-create" ? actions.busy : undefined}
          error={actions.error?.key === "api-create" || actions.error?.key === "managed-create" ? actions.error.message : undefined}
          onCreateManaged={actions.createManaged} onCreateApi={actions.createApi} />
      </section>
    </div>
    {edited && <AccountEditDialog key={text(edited["id"])} account={edited} apiProtocolsSupported={apiProtocolsSupported} apiValidationSupported={apiValidationSupported} modelCatalogSupported={catalogSupported} onClose={() => setEditing(undefined)} onSaved={() => void actions.refresh()} />}
    {configuring && <AdvancedConfigEditor key={text(configuring["id"])} accountId={text(configuring["id"])} name={text(configuring["name"], text(configuring["agent"]))} onClose={() => setConfiguring(undefined)} onSaved={() => void actions.refresh()} />}
  </div>;
}
