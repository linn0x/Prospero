import { useEffect, useId, useRef, useState } from "react";
import type { JsonObject } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { ModelCapabilitiesFields } from "../ModelCapabilitiesFields";
import { accountApiEngineLabel, accountApiProtocolDefaults, accountApiProtocolLabel, accountApiProtocols, modelCapabilityDraft, supportsAccountApiProtocols, supportsAccountApiValidation, type AccountApiProtocol } from "../account-profile-form";
import { useLocale } from "../locale";
import { reportError } from "../state";
import { accountCreateApiInput, accountModelCatalogRequest } from "./account-form-actions";
import { ModelCatalogPicker } from "./ModelCatalogPicker";

interface AccountCreateFormProps {
  capabilities?: string[] | undefined;
  disabled: boolean;
  busy?: "managed-create" | "api-create" | undefined;
  error?: string | undefined;
  onCreateManaged: (input: { agent: "codex" | "claude"; name: string }) => Promise<boolean>;
  onCreateApi: (input: JsonObject) => Promise<boolean>;
}

export function AccountCreateForm({ capabilities, disabled, busy, error, onCreateManaged, onCreateApi }: AccountCreateFormProps) {
  const { t } = useLocale();
  const id = useId();
  const [tab, setTab] = useState<"cli" | "api">("cli");
  const [agent, setAgent] = useState<"codex" | "claude">("codex");
  const [name, setName] = useState("");
  const [apiName, setApiName] = useState("");
  const [protocol, setProtocol] = useState<AccountApiProtocol>("openai_responses");
  const [baseUrl, setBaseUrl] = useState(accountApiProtocolDefaults("openai_responses").baseUrl);
  const [model, setModel] = useState(accountApiProtocolDefaults("openai_responses").model);
  const [apiKey, setApiKey] = useState("");
  const [modelCapabilities, setModelCapabilities] = useState(() => modelCapabilityDraft());
  const [localError, setLocalError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const errorRef = useRef<HTMLDivElement>(null);
  const protocolsSupported = supportsAccountApiProtocols(capabilities);
  const validationSupported = supportsAccountApiValidation(capabilities);
  const modelsSupported = capabilities?.includes("agent.account.api.models") === true;
  const effortSupported = capabilities?.includes("agent.account.config") === true;
  const inactive = disabled || Boolean(busy) || submitting;
  const message = localError ?? error;
  const effectiveProtocol = !protocolsSupported && protocol === "openai_chat_completions" ? "openai_responses" : protocol;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (message) errorRef.current?.focus(); }, [message]);
  const changeProtocol = (next: AccountApiProtocol) => {
    const defaults = accountApiProtocolDefaults(next);
    setProtocol(next); setBaseUrl(defaults.baseUrl); setModel(defaults.model); setApiKey(""); setModelCapabilities(modelCapabilityDraft());
  };
  const selectTab = (next: "cli" | "api") => {
    if (inactive) return;
    setTab(next); setLocalError(undefined);
    if (next === "cli") setApiKey("");
  };
  const submit = async () => {
    if (pending.current || inactive) return;
    pending.current = true;
    setSubmitting(true); setLocalError(undefined);
    try {
      if (tab === "cli") {
        if (name.trim() && await onCreateManaged({ agent, name: name.trim() }) && mounted.current) setName("");
      } else {
        if (!apiName.trim() || !baseUrl.trim() || !model.trim() || !apiKey.trim()) return;
        const saved = await onCreateApi(accountCreateApiInput({ name: apiName, protocol: effectiveProtocol, baseUrl, model, apiKey, modelCapabilities }, protocolsSupported, validationSupported));
        if (saved && mounted.current) { setApiName(""); setApiKey(""); }
      }
    } catch (reason) { if (mounted.current) setLocalError(reportError(reason)); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  };
  return <section className="account-create-form" aria-label={t("添加账号", "Add account")} aria-busy={inactive}>
    <div className="account-create-tabs" role="tablist" aria-label={t("账号类型", "Account type")} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "cli" : event.key === "End" ? "api" : tab === "cli" ? "api" : "cli";
      selectTab(next);
      document.getElementById(`${id}-${next}-tab`)?.focus();
    }}>
      {(["cli", "api"] as const).map(value => <Button key={value} type="button" variant="ghost" role="tab" id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} disabled={inactive} onClick={() => selectTab(value)}>{value === "cli" ? t("CLI 账号", "CLI account") : "API Profile"}</Button>)}
    </div>
    <form id={`${id}-${tab}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={inactive}>
        {tab === "cli" ? <>
          <Field><FieldLabel htmlFor={`${id}-agent`}>{t("CLI Agent", "CLI agent")}</FieldLabel><NativeSelect id={`${id}-agent`} value={agent} onChange={event => setAgent(event.target.value as "codex" | "claude")}><NativeSelectOption value="codex">Codex</NativeSelectOption><NativeSelectOption value="claude">Claude</NativeSelectOption></NativeSelect></Field>
          <Field><FieldLabel htmlFor={`${id}-name`}>{t("显示名称", "Display name")}</FieldLabel><Input id={`${id}-name`} value={name} maxLength={80} required placeholder={t("工作账号", "Work account")} onChange={event => setName(event.target.value)} /></Field>
          <FieldDescription>{t("创建隔离账号后，打开官方 CLI 登录终端。", "Create an isolated account and open the official CLI sign-in terminal.")}</FieldDescription>
        </> : <>
          <Field><FieldLabel htmlFor={`${id}-api-name`}>{t("显示名称", "Display name")}</FieldLabel><Input id={`${id}-api-name`} value={apiName} maxLength={80} required placeholder={t("工作 API", "Work API")} onChange={event => setApiName(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor={`${id}-protocol`}>{protocolsSupported ? t("API 协议", "API protocol") : t("CLI Agent", "CLI agent")}</FieldLabel>
            <NativeSelect id={`${id}-protocol`} value={effectiveProtocol} onChange={event => changeProtocol(event.target.value as AccountApiProtocol)}>
              {(protocolsSupported ? accountApiProtocols : ["openai_responses", "anthropic"] as const).map(value => <NativeSelectOption key={value} value={value}>{protocolsSupported ? accountApiProtocolLabel(value) : accountApiEngineLabel(value)}</NativeSelectOption>)}
            </NativeSelect><FieldDescription>{accountApiEngineLabel(effectiveProtocol)} · {t("引擎", "engine")}</FieldDescription>
          </Field>
          <Field><FieldLabel htmlFor={`${id}-base-url`}>{t("API 地址", "Base URL")}</FieldLabel><Input id={`${id}-base-url`} type="url" inputMode="url" value={baseUrl} maxLength={2000} required spellCheck={false} onChange={event => setBaseUrl(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor={`${id}-api-key`}>API Key</FieldLabel><Input id={`${id}-api-key`} type="password" value={apiKey} maxLength={8192} required autoComplete="new-password" onChange={event => setApiKey(event.target.value)} /></Field>
          <ModelCatalogPicker value={model} onChange={setModel} request={accountModelCatalogRequest({ protocol: effectiveProtocol, baseUrl, apiKey })} supported={modelsSupported} disabled={inactive} />
          {validationSupported && <ModelCapabilitiesFields value={modelCapabilities} onChange={setModelCapabilities} protocol={effectiveProtocol} disabled={inactive} effortSupported={effortSupported} />}
          <FieldDescription>{t("API Key 仅用于当前请求，保存后由本机 daemon 私有存储。", "The API key is used for this request and stored privately by the local daemon after saving.")}</FieldDescription>
        </>}
      </fieldset>
      {message && <div ref={errorRef} className="account-inline-error" role="alert" tabIndex={-1}>{message}</div>}
      <Button type="submit" disabled={inactive || (tab === "cli" ? !name.trim() : !apiName.trim() || !baseUrl.trim() || !model.trim() || !apiKey.trim())}>
        {(busy || submitting) && <Spinner />}{busy || submitting ? t("处理中…", "Working…") : tab === "cli" ? t("创建并登录", "Create and sign in") : t("保存 API Profile", "Save API profile")}
      </Button>
    </form>
  </section>;
}
