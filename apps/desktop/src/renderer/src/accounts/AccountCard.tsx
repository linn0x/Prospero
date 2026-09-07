import type { JsonObject, UsageAccount } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { accountEngine } from "../../../shared/account-capabilities";
import { accountApiProtocolFromProfile, accountApiProtocolLabel } from "../account-profile-form";
import { AgentLogo } from "../AgentLogo";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import { number, record, text } from "../state";
import { ApiValidationDetails } from "./ApiValidationDetails";
import { UsageMeters } from "./UsageMeters";
import type { AccountAction } from "./use-account-actions";

export function AccountCard({ account, usage, disabled, busy, error, apiValidationSupported, engineValidationSupported, configSupported, onAction, onEdit, onConfig }: {
  account: JsonObject; usage?: UsageAccount | undefined; disabled: boolean; busy?: string | undefined; error?: string | undefined;
  apiValidationSupported: boolean; engineValidationSupported: boolean; configSupported: boolean;
  onAction: (account: JsonObject, action: AccountAction, scope?: "protocol" | "engine") => Promise<boolean>;
  onEdit: () => void; onConfig: () => void;
}) {
  const { t, status } = useLocale();
  const id = text(account["id"]);
  const agent = text(account["agent"]);
  const engine = accountEngine(account);
  const managed = account["managed"] === true;
  const hasApi = Boolean(account["apiProfile"] || account["apiProfileError"]);
  const signedIn = text(account["status"]) === "signed_in";
  const profile = record(account["apiProfile"]);
  const action = (type: AccountAction, scope?: "protocol" | "engine") => void onAction(account, type, scope);
  const pending = (type: string) => busy === id + ":" + type;
  return <article className={"account-card account-card-rich provider-" + engine} aria-label={text(account["name"], agent)}>
    <div className="account-card-head">
      <div className="provider-logo"><AgentLogo agent={engine} size={24} /></div>
      <div><strong>{text(account["name"], agent)}</strong><p>{hasApi ? accountApiProtocolLabel(accountApiProtocolFromProfile(profile, agent)) : agent + " · " + status(text(account["status"]))}{number(account["activeSessions"]) > 0 && " · " + number(account["activeSessions"]) + " " + t("个会话", "sessions")}</p></div>
      {account["isDefault"] === true && <span className="pill"><DesktopIcon name="check" size={12} />{t("默认", "Default")}</span>}
    </div>
    <div className="account-card-status">
      {hasApi && <ApiValidationDetails account={account} engineValidationSupported={engineValidationSupported} />}
      {usage || !hasApi ? <UsageMeters usage={usage} /> : <p className="usage-note">{t("API 额度由服务商管理", "API usage is managed by the provider")}</p>}
    </div>
    <div className="button-row compact">
      {hasApi && apiValidationSupported && <Button variant="outline" size="sm" aria-busy={pending("agent.account.api.test:protocol")} disabled={disabled || Boolean(account["apiProfileError"]) || account["status"] === "signed_out"} onClick={() => action("agent.account.api.test")}>{pending("agent.account.api.test:protocol") && <DesktopIcon name="refresh" className="daemon-spinner" />}{t("测试连接", "Test connection")}</Button>}
      {hasApi && engineValidationSupported && <Button variant="outline" size="sm" aria-busy={pending("agent.account.api.test:engine")} disabled={disabled || Boolean(account["apiProfileError"]) || account["status"] === "signed_out"} onClick={() => action("agent.account.api.test", "engine")}>{pending("agent.account.api.test:engine") && <DesktopIcon name="refresh" className="daemon-spinner" />}{t("验证 Agent", "Validate Agent")}</Button>}
      {account["isDefault"] !== true && <Button variant="outline" size="sm" disabled={disabled} onClick={() => action("agent.account.default")}>{t("设为默认", "Set default")}</Button>}
      {managed && <Button variant="outline" size="sm" disabled={disabled} onClick={onEdit}>{t("编辑", "Edit")}</Button>}
      {managed && configSupported && <Button variant="outline" size="sm" disabled={disabled} onClick={onConfig}><DesktopIcon name="settings" />{t("高级配置", "Advanced")}</Button>}
      {managed && !hasApi && <Button variant="outline" size="sm" disabled={disabled} onClick={() => action(signedIn ? "agent.account.logout" : "agent.account.login")}>{signedIn ? t("退出登录", "Sign out") : t("登录", "Sign in")}</Button>}
      {managed && <Button variant="ghost" size="sm" className="text-destructive" disabled={disabled || number(account["activeSessions"]) > 0} onClick={() => action("agent.account.delete")}><DesktopIcon name="delete" />{t("删除", "Delete")}</Button>}
    </div>
    {error && <div className="account-inline-error" role="alert">{error}</div>}
  </article>;
}
