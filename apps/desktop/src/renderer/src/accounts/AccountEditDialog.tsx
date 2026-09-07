import { useEffect, useRef, useState } from "react";
import type { JsonObject } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { ModelCapabilitiesFields } from "../ModelCapabilitiesFields";
import { accountApiConnectionLocked, accountApiEngineLabel, accountApiProtocolDefaults, accountApiProtocolFromProfile, accountApiProtocolLabel, accountApiProtocolsForAgent, modelCapabilityDraft, type AccountApiProtocol } from "../account-profile-form";
import { useLocale } from "../locale";
import { displayError, record, text } from "../state";
import { accountEditActions, accountModelCatalogRequest, type AccountEditDraft } from "./account-form-actions";
import { ModelCatalogPicker } from "./ModelCatalogPicker";

interface AccountEditDialogProps {
  account: JsonObject;
  apiProtocolsSupported: boolean;
  apiValidationSupported: boolean;
  modelCatalogSupported: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function AccountEditDialog(props: AccountEditDialogProps) {
  return <AccountEditForm key={text(props.account["id"])} {...props} />;
}

function AccountEditForm({ account, apiProtocolsSupported, apiValidationSupported, modelCatalogSupported, onClose, onSaved }: AccountEditDialogProps) {
  const { t } = useLocale();
  const profile = record(account["apiProfile"]);
  const apiProfile = Object.keys(profile).length > 0 || Boolean(account["apiProfileError"]);
  const agent = text(account["agent"]);
  const initialProtocol = accountApiProtocolFromProfile(profile, agent);
  const [draft, setDraft] = useState<AccountEditDraft>(() => ({
    name: text(account["name"], agent), protocol: initialProtocol,
    baseUrl: text(profile["baseUrl"], account["apiProfileError"] ? "" : accountApiProtocolDefaults(initialProtocol).baseUrl),
    model: text(profile["model"], account["apiProfileError"] ? "" : accountApiProtocolDefaults(initialProtocol).model),
    apiKey: "", modelCapabilities: modelCapabilityDraft(record(profile["modelCapabilities"])),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const mounted = useRef(true);
  const errorRef = useRef<HTMLDivElement>(null);
  const connectionLocked = accountApiConnectionLocked(account);
  const protocols = accountApiProtocolsForAgent(agent);
  const request = accountModelCatalogRequest(draft, account);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const change = <K extends keyof AccountEditDraft>(key: K, value: AccountEditDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const save = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      for (const action of accountEditActions(account, draft, apiProtocolsSupported, apiValidationSupported)) {
        const result = await window.prospero.accountAction({ ...action, requestId: crypto.randomUUID() });
        if (result["ok"] === false) throw new Error(text(result["error"], t("账号更新失败", "Unable to update account")));
        if (result["cancelled"] === true) return;
      }
      if (mounted.current) {
        change("apiKey", "");
        onSaved();
        onClose();
      }
    } catch (reason) { if (mounted.current) setError(displayError(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const close = () => { if (!pending.current) { change("apiKey", ""); onClose(); } };
  const changeProtocol = (protocol: AccountApiProtocol) => {
    const defaults = accountApiProtocolDefaults(protocol);
    setDraft(current => ({ ...current, protocol, baseUrl: defaults.baseUrl, model: defaults.model, apiKey: "", modelCapabilities: modelCapabilityDraft() }));
  };
  const changedLegacyConnection = !apiProtocolsSupported && !connectionLocked && apiProfile &&
    (draft.baseUrl.trim() !== text(profile["baseUrl"]) || draft.model.trim() !== text(profile["model"]) || Boolean(account["apiProfileError"]));
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="sm:max-w-xl" showCloseButton={!busy} closeLabel={t("关闭", "Close")} aria-busy={busy}>
      <DialogHeader><DialogTitle>{t("编辑账号", "Edit account")}</DialogTitle><DialogDescription>
        {!apiProfile ? t("修改这个独立 CLI 账号的显示名称。", "Change the display name of this isolated CLI account.")
          : connectionLocked ? t("当前存在活动会话，仅可修改显示名称。", "Only the display name can be changed while sessions are active.")
            : apiProtocolsSupported ? t("API Key 留空会保留已保存的凭据。", "Leave API Key empty to retain the saved credential.")
              : t("旧版 daemon 修改连接设置时需要重新输入 API Key。", "The older daemon requires the API Key again when changing connection settings.")}
      </DialogDescription></DialogHeader>
      {Boolean(account["apiProfileError"]) && <p className="account-inline-error" role="status">{t("原配置无法读取，请重新填写服务地址和模型。", "The saved profile could not be read. Re-enter the service URL and model.")}</p>}
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        <FieldGroup className="account-edit-fields gap-3">
          <Field><FieldLabel htmlFor="account-edit-name">{t("显示名称", "Display name")}</FieldLabel><Input id="account-edit-name" maxLength={80} value={draft.name} disabled={busy} autoFocus required onChange={event => change("name", event.target.value)} /></Field>
          {apiProfile && <>
            {apiProtocolsSupported && <Field><FieldLabel htmlFor="account-edit-protocol">{t("API 协议", "API protocol")}</FieldLabel>
              <NativeSelect id="account-edit-protocol" value={draft.protocol} disabled={busy || connectionLocked || protocols.length < 2} onChange={event => changeProtocol(event.target.value as AccountApiProtocol)}>
                {protocols.map(protocol => <NativeSelectOption key={protocol} value={protocol}>{accountApiProtocolLabel(protocol)}</NativeSelectOption>)}
              </NativeSelect><FieldDescription>{accountApiEngineLabel(draft.protocol)} · {t("引擎", "engine")}</FieldDescription>
            </Field>}
            <Field><FieldLabel htmlFor="account-edit-base-url">{t("API 地址", "Base URL")}</FieldLabel><Input id="account-edit-base-url" type="url" inputMode="url" maxLength={2000} spellCheck={false} value={draft.baseUrl} disabled={busy || connectionLocked} onChange={event => change("baseUrl", event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="account-edit-api-key">API Key</FieldLabel><Input id="account-edit-api-key" type="password" maxLength={8192} autoComplete="new-password" value={draft.apiKey} disabled={busy || connectionLocked} onChange={event => change("apiKey", event.target.value)} placeholder={apiProtocolsSupported ? t("留空以保留现有凭据", "Leave empty to keep the current credential") : t("修改连接时重新输入", "Re-enter when changing the connection")} /></Field>
            <ModelCatalogPicker value={draft.model} onChange={value => change("model", value)} request={request} supported={modelCatalogSupported} disabled={busy || connectionLocked}
              unavailableReason={t("连接已更改。请先保存后拉取目录，或输入新 API Key 来测试当前草稿。", "The connection has changed. Save before fetching models, or enter a new API key to test this draft.")} />
            {apiValidationSupported && <ModelCapabilitiesFields value={draft.modelCapabilities} onChange={value => change("modelCapabilities", value)} protocol={draft.protocol} disabled={busy || connectionLocked} effortSupported={modelCatalogSupported} />}
            {connectionLocked && <FieldDescription>{t("结束活动会话后才能更改连接或模型。", "End active sessions before changing the connection or model.")}</FieldDescription>}
          </>}
        </FieldGroup>
        {error && <div ref={errorRef} className="account-inline-error" role="alert" tabIndex={-1}>{error}</div>}
        {changedLegacyConnection && !draft.apiKey.trim() && <FieldDescription>{t("请重新输入 API Key 后保存连接更改。", "Re-enter the API Key to save connection changes.")}</FieldDescription>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>{t("取消", "Cancel")}</Button>
          <Button type="submit" disabled={busy || !draft.name.trim() || (apiProfile && !connectionLocked && (!draft.baseUrl.trim() || !draft.model.trim())) || changedLegacyConnection && !draft.apiKey.trim()}>
            {busy && <Spinner />}{busy ? t("保存中…", "Saving…") : t("保存", "Save")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
