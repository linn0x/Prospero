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
  const [dimension, setDimension] = useState<"subscriptions" | "sources">("subscriptions");
  const [providerFilter, setProviderFilter] = useState<"all" | "codex" | "claude">("all");
  const [showLegacyApi, setShowLegacyApi] = useState(false);
  const [editing, setEditing] = useState<JsonObject>();
  const [configuring, setConfiguring] = useState<JsonObject>();
  const visibleAccounts = snapshot.accounts.filter(account => !account.modelSource);
  const subscriptionAccounts = visibleAccounts.filter(account => !account["apiProfile"] && !account["apiProfileError"]);
  const legacyApiAccounts = visibleAccounts.filter(account => Boolean(account["apiProfile"] || account["apiProfileError"]));
  const displayedAccounts = (showLegacyApi ? visibleAccounts : subscriptionAccounts).filter(account => providerFilter === "all" || accountEngine(account) === providerFilter);
  const createForm = useRef<HTMLElement>(null);
  const capabilities = snapshot.daemon.capabilities;
  const apiProtocolsSupported = supportsAccountApiProtocols(capabilities);
  const apiValidationSupported = supportsAccountApiValidation(capabilities);
  const engineValidationSupported = supportsAccountApiEngineValidation(capabilities);
  const catalogSupported = capabilities?.includes("agent.account.api.models") === true && typeof window.prospero.getAccountModels === "function";
  const configSupported = capabilities?.includes("agent.account.config") === true && typeof window.prospero.getAccountConfig === "function";
  const disabled = Boolean(actions.busy || actions.loading || editing || configuring || !snapshot.daemon.running);
  const edited = editing ? snapshot.accounts.find(account => account["id"] === editing["id"]) ?? editing : undefined;
  const codexCount = subscriptionAccounts.filter(account => accountEngine(account) === "codex").length;
  const claudeCount = subscriptionAccounts.filter(account => accountEngine(account) === "claude").length;
  return <div className="page accounts-page">
    <header className="page-header">
      <div>
        <h1>{t("账号与模型源", "Accounts & model sources")}</h1>
        <p>{t("分开维护「多份官方订阅登录态」与「第三方 / 自建 API 模型源」。", "Manage official subscription sign-ins and API model sources separately.")}</p>
      </div>
      <div className="accounts-dimension-switcher" role="group" aria-label={t("管理维度", "Management dimension")}>
        <Button data-liquid-glass="tab" variant={dimension === "subscriptions" ? "secondary" : "ghost"} size="sm" aria-pressed={dimension === "subscriptions"} onClick={() => setDimension("subscriptions")}>
          <DesktopIcon name="accounts" />{t("订阅管理", "Subscriptions")} ({subscriptionAccounts.length})
        </Button>
        <Button data-liquid-glass="tab" variant={dimension === "sources" ? "secondary" : "ghost"} size="sm" aria-pressed={dimension === "sources"} onClick={() => setDimension("sources")}>
          <DesktopIcon name="server" />{t("API 模型源", "API model sources")}
        </Button>
      </div>
    </header>
    {actions.refreshError && <div className="account-inline-error" role="alert">{actions.refreshError}<Button variant="ghost" size="sm" disabled={actions.loading} onClick={() => void actions.refresh(true)}>{t("重试", "Retry")}</Button></div>}
    {actions.notice && <p className="security-note" role="status">{actions.notice}</p>}
    {dimension === "sources" ? (
      <ModelSourcesPane snapshot={snapshot} onUse={onUseModelSource} />
    ) : (
      <>
        <div className="subscriptions-toolbar">
          <div className="subscriptions-filter-pills" role="group" aria-label={t("订阅筛选", "Filter subscriptions")}>
            <Button variant={providerFilter === "all" ? "secondary" : "outline"} size="sm" aria-pressed={providerFilter === "all"} onClick={() => setProviderFilter("all")}>
              {t("全部订阅", "All subscriptions")} ({subscriptionAccounts.length})
            </Button>
            <Button variant={providerFilter === "codex" ? "secondary" : "outline"} size="sm" aria-pressed={providerFilter === "codex"} onClick={() => setProviderFilter("codex")}>
              <AgentLogo agent="codex" size={14} />Codex ({codexCount})
            </Button>
            <Button variant={providerFilter === "claude" ? "secondary" : "outline"} size="sm" aria-pressed={providerFilter === "claude"} onClick={() => setProviderFilter("claude")}>
              <AgentLogo agent="claude" size={14} />Claude ({claudeCount})
            </Button>
            {legacyApiAccounts.length > 0 && (
              <Button variant={showLegacyApi ? "secondary" : "ghost"} size="sm" aria-pressed={showLegacyApi} onClick={() => setShowLegacyApi(current => !current)}>
                {t("旧版独立 API", "Legacy API profiles")} ({legacyApiAccounts.length})
              </Button>
            )}
          </div>
          <div className="button-row">
            <Button variant="outline" size="sm" disabled={actions.loading || Boolean(actions.busy)} aria-busy={actions.loading} onClick={() => void actions.refresh(true)}>
              <DesktopIcon name="refresh" className={actions.loading ? "daemon-spinner" : undefined} />{actions.loading ? t("更新中", "Updating") : t("刷新", "Refresh")}
            </Button>
            <Button size="sm" disabled={disabled} onClick={() => { createForm.current?.scrollIntoView({ block: "nearest" }); createForm.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus(); }}>
              <DesktopIcon name="add" />{t("新增订阅登录态", "Add subscription")}
            </Button>
          </div>
        </div>
        {legacyApiAccounts.length > 0 && (
          <div className="legacy-api-migration-banner">
            <span>{t(`检测到 ${legacyApiAccounts.length} 个旧版独立 API Profile。所有第三方 API 现已统一在「API 模型源」中管理，可一键归并。`, `Detected ${legacyApiAccounts.length} legacy API profile(s). Third-party APIs are now managed under API model sources.`)}</span>
            <Button variant="outline" size="sm" onClick={() => setDimension("sources")}>{t("前往 API 模型源整理", "Go to API model sources")}</Button>
          </div>
        )}
        <div className="split-management account-layout">
          <section>
            <div className="section-title"><DesktopIcon name="accounts" />{t("官方 CLI 订阅登录态", "Official CLI subscription sign-ins")} <span>{displayedAccounts.length}</span></div>
            <div className="card-grid account-grid">{displayedAccounts.map(account => {
              const id = text(account["id"]);
              const usage = actions.usage.find(item => item.accountId === id) ?? actions.usage.find(item => !item.accountId && item.agent === account["agent"]);
              return <AccountCard key={id} account={account} usage={usage} disabled={disabled} busy={actions.busy}
                error={actions.error?.key.startsWith(id + ":") ? actions.error.message : undefined}
                apiValidationSupported={apiValidationSupported} engineValidationSupported={engineValidationSupported} configSupported={configSupported}
                onAction={actions.runAction} onEdit={() => setEditing(account)} onConfig={() => setConfiguring(account)} />;
            })}</div>
            {!displayedAccounts.length && <div className="small-empty">{t("当前筛选下没有订阅账号，可在右侧创建隔离的 CLI 订阅登录态，或切换到「API 模型源」。", "No subscription accounts match. Create an isolated CLI subscription on the right or switch to API model sources.")}</div>}
          </section>
          <section ref={createForm} className="form-card account-form">
            <div className="section-title"><DesktopIcon name="add" />{t("新增订阅登录态", "Add subscription sign-in")}</div>
            <AccountCreateForm disabled={disabled} busy={actions.busy === "managed-create" ? actions.busy : undefined}
              error={actions.error?.key === "managed-create" ? actions.error.message : undefined}
              onCreateManaged={actions.createManaged} />
          </section>
        </div>
      </>
    )}
    {edited && <AccountEditDialog key={text(edited["id"])} account={edited} apiProtocolsSupported={apiProtocolsSupported} apiValidationSupported={apiValidationSupported} modelCatalogSupported={catalogSupported} onClose={() => setEditing(undefined)} onSaved={() => void actions.refresh()} />}
    {configuring && <AdvancedConfigEditor key={text(configuring["id"])} accountId={text(configuring["id"])} name={text(configuring["name"], text(configuring["agent"]))} onClose={() => setConfiguring(undefined)} onSaved={() => void actions.refresh()} />}
  </div>;
}
