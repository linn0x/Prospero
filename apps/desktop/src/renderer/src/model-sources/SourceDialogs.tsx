import { useRef, useState, type ReactNode } from "react";
import type { AgentModelCapabilities, AgentReasoningEffort } from "@prospero/protocol";
import type { ModelSource, ModelSourceAction, ModelSourceRoute } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { Spinner } from "../components/ui/spinner";
import { DesktopIcon } from "../design-system/icons";
import { ModelCapabilitiesFields } from "../ModelCapabilitiesFields";
import { accountApiProtocolDefaults, accountApiProtocolLabel, accountReasoningEfforts, modelCapabilityDraft, parseModelCapabilities, type AccountApiProtocol } from "../account-profile-form";
import { useLocale } from "../locale";
import { displayError } from "../state";
import { runModelSourceAction } from "./use-model-sources";
import { SourceOnboardingModels } from "./SourceOnboardingModels";
import { retainSourceRouteDrafts, sourceDraftRoutes, type SourceRouteDraft } from "./source-state";

const protocols: AccountApiProtocol[] = ["openai_responses", "openai_chat_completions", "anthropic"];
function validEffort(value: string): value is AgentReasoningEffort { return (accountReasoningEfforts as readonly string[]).includes(value); }

function EditorFrame({ title, children, onClose, action, dirty, valid = true }: { title: string; children: ReactNode; onClose: () => void; action: () => ModelSourceAction; dirty: boolean; valid?: boolean }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const close = () => { if (pending.current) return; if (dirty) setDiscard(true); else onClose(); };
  const save = async () => {
    if (pending.current || !valid) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await runModelSourceAction(action()); onClose(); }
    catch (reason) { setError(displayError(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="model-source-dialog" showCloseButton={!busy} closeLabel={t("关闭", "Close")}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{t("连接和模型的更改用于通过模型源新建的会话；已有会话绑定不变。", "Connection and model changes apply to new source sessions. Existing session bindings stay unchanged.")}</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy} className="model-source-form">{children}</fieldset>
        {error && <div className="model-source-error" role="alert">{error}<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={close}>{t("关闭并重新载入", "Close and reload")}</Button></div>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>{t("取消", "Cancel")}</Button><Button type="submit" disabled={busy || !valid}>{busy && <Spinner />}{t("保存", "Save")}</Button></DialogFooter>
      </form>
      <Dialog open={discard} onOpenChange={setDiscard}><DialogContent><DialogHeader><DialogTitle>{t("放弃未保存的更改？", "Discard unsaved changes?")}</DialogTitle><DialogDescription>{t("未保存的输入会被清除，已保存的模型源不受影响。", "Unsaved inputs will be cleared. Saved sources are unchanged.")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscard(false)}>{t("继续编辑", "Keep editing")}</Button><Button onClick={onClose}>{t("放弃更改", "Discard changes")}</Button></DialogFooter></DialogContent></Dialog>
    </DialogContent>
  </Dialog>;
}

export function SourceConnectionDialog({ source, onClose }: { source?: ModelSource | undefined; onClose: () => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(source?.name ?? "");
  const [endpoints, updateEndpoints] = useState<ModelSource["endpoints"]>(source?.endpoints ?? [{ protocol: "openai_responses", baseUrl: accountApiProtocolDefaults("openai_responses").baseUrl }]);
  const [credentialName, setCredentialName] = useState(t("默认凭据", "Default key"));
  const [apiKey, setApiKey] = useState("");
  const [routes, setRoutes] = useState<SourceRouteDraft[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const setEndpoints = (update: (value: ModelSource["endpoints"]) => ModelSource["endpoints"]) => {
    const next = update(endpoints);
    updateEndpoints(next); setRoutes(current => retainSourceRouteDrafts(endpoints, next, current));
  };
  const operationId = useRef(crypto.randomUUID());
  const dirty = name !== (source?.name ?? "") || !!apiKey || routes.length > 0 || JSON.stringify(endpoints) !== JSON.stringify(source?.endpoints ?? [{ protocol: "openai_responses", baseUrl: accountApiProtocolDefaults("openai_responses").baseUrl }]);
  return <EditorFrame title={source ? t("编辑模型源", "Edit model source") : t("添加模型源", "Add model source")} onClose={onClose} dirty={dirty} valid={!discovering && !!name.trim() && routes.every(route => !!route.name.trim()) && endpoints.every(item => !!item.baseUrl.trim()) && (!!source || !!apiKey.trim() && !!credentialName.trim())} action={() => source ? { kind: "update", sourceId: source.id, revision: source.revision, name: name.trim(), endpoints } : { kind: "create", operationId: operationId.current, name: name.trim(), endpoints, credential: { name: credentialName.trim(), apiKey }, routes: sourceDraftRoutes(routes) }}>
    <Field><FieldLabel htmlFor="source-name">{t("名称", "Name")}</FieldLabel><Input id="source-name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} autoFocus /></Field>
    {endpoints.map((endpoint, index) => <div className="model-source-endpoint-form" key={index}>
      <Field><FieldLabel htmlFor={`source-protocol-${index}`}>{t("协议", "Protocol")}</FieldLabel><NativeSelect id={`source-protocol-${index}`} value={endpoint.protocol} disabled={!!source?.routes.some(route => route.protocol === endpoint.protocol)} onChange={event => setEndpoints(current => current.map((item, row) => row === index ? { ...item, protocol: event.target.value as AccountApiProtocol } : item))}>
        {protocols.map(protocol => <NativeSelectOption key={protocol} value={protocol} disabled={endpoints.some((item, row) => row !== index && item.protocol === protocol)}>{accountApiProtocolLabel(protocol)}</NativeSelectOption>)}
      </NativeSelect></Field>
      <Field><FieldLabel htmlFor={`source-url-${index}`}>Base URL</FieldLabel><Input id={`source-url-${index}`} type="url" value={endpoint.baseUrl} maxLength={2000} required spellCheck={false} onChange={event => setEndpoints(current => current.map((item, row) => row === index ? { ...item, baseUrl: event.target.value } : item))} /></Field>
      {endpoints.length > 1 && <Button type="button" variant="ghost" size="icon-sm" disabled={!!source?.routes.some(route => route.protocol === endpoint.protocol)} aria-label={t("移除此协议端点", "Remove protocol endpoint")} onClick={() => setEndpoints(current => current.filter((_, row) => row !== index))}><DesktopIcon name="close" /></Button>}
    </div>)}
    {endpoints.length < 3 && <Button type="button" variant="ghost" className="w-fit" onClick={() => { const protocol = protocols.find(item => !endpoints.some(endpoint => endpoint.protocol === item)); if (protocol) setEndpoints(current => [...current, { protocol, baseUrl: current[0]!.baseUrl }]); }}><DesktopIcon name="add" />{t("添加协议端点", "Add protocol endpoint")}</Button>}
    {!source && <><Field><FieldLabel htmlFor="source-credential-name">{t("凭据名称", "Credential name")}</FieldLabel><Input id="source-credential-name" value={credentialName} onChange={event => setCredentialName(event.target.value)} maxLength={80} required /></Field><Field><FieldLabel htmlFor="source-api-key">API Key</FieldLabel><Input id="source-api-key" type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setRoutes([]); }} maxLength={8192} required autoComplete="new-password" /></Field><SourceOnboardingModels endpoints={endpoints} apiKey={apiKey} value={routes} onChange={setRoutes} onBusy={setDiscovering} /></>}
  </EditorFrame>;
}

export function SourceCredentialDialog({ source, credentialId, onClose }: { source: ModelSource; credentialId?: string | undefined; onClose: () => void }) {
  const { t } = useLocale();
  const credential = source.credentials.find(item => item.id === credentialId);
  const [name, setName] = useState(credential?.name ?? "");
  const [apiKey, setApiKey] = useState("");
  return <EditorFrame title={credential ? t("编辑或轮换凭据", "Edit or rotate credential") : t("添加凭据", "Add credential")} dirty={name !== (credential?.name ?? "") || !!apiKey} valid={!!name.trim() && (!!credential || !!apiKey.trim())} onClose={onClose} action={() => ({ kind: "credential.set", sourceId: source.id, revision: source.revision, name: name.trim(), ...(credential ? { credentialId: credential.id } : {}), ...(apiKey.trim() ? { apiKey } : {}) })}>
    <Field><FieldLabel htmlFor="credential-name">{t("凭据名称", "Credential name")}</FieldLabel><Input id="credential-name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} autoFocus /></Field>
    <Field><FieldLabel htmlFor="credential-key">{credential ? t("新 API Key（留空保留）", "New API key (leave empty to retain)") : "API Key"}</FieldLabel><Input id="credential-key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} maxLength={8192} required={!credential} autoComplete="new-password" /></Field>
    <p className="model-source-hint">{t("不会显示已保存的 Key。轮换后新会话使用新版本，旧会话继续保留原凭据。", "Saved keys are never displayed. New sessions use the rotated key; existing sessions keep their original credential.")}</p>
  </EditorFrame>;
}

export function SourceRouteDialog({ source, route, onClose }: { source: ModelSource; route?: ModelSourceRoute | undefined; onClose: () => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(route?.name ?? "");
  const [model, setModel] = useState(route?.model ?? "");
  const [protocol, setProtocol] = useState<AccountApiProtocol>(route?.protocol ?? source.endpoints[0]!.protocol);
  const [credentialId, setCredentialId] = useState(route?.credentialId ?? source.credentials[0]?.id ?? "");
  const [capabilities, setCapabilities] = useState(() => modelCapabilityDraft(route?.modelCapabilities));
  const [effort, setEffort] = useState(route?.defaultEffort ?? "");
  const initial = useRef(JSON.stringify({ name, model, protocol, credentialId, capabilities, effort }));
  const efforts = capabilities.supportedEfforts.split(/[,，\s]+/).map(value => value.trim()).filter(validEffort);
  return <EditorFrame title={route ? t("编辑模型路由", "Edit model route") : t("添加模型路由", "Add model route")} onClose={onClose} valid={!!name.trim() && !!model.trim() && !!credentialId} dirty={initial.current !== JSON.stringify({ name, model, protocol, credentialId, capabilities, effort })} action={() => {
    const parsed = parseModelCapabilities(capabilities, route?.modelCapabilities ?? {}, protocol);
    const modelCapabilities = parsed as AgentModelCapabilities | null;
    if (effort && protocol !== "openai_chat_completions" && (!validEffort(effort) || !modelCapabilities?.supportedEfforts?.includes(effort))) throw new Error(t("请先在模型能力中声明此推理档位。", "Declare this reasoning effort in model capabilities first."));
    return { kind: "routes.set", sourceId: source.id, revision: source.revision, routes: [{ ...(route ? { id: route.id } : {}), name: name.trim(), model: model.trim(), protocol, credentialId, enabled: route?.enabled ?? true,
      ...(modelCapabilities ? { modelCapabilities } : {}), ...(effort && validEffort(effort) && protocol !== "openai_chat_completions" ? { defaultEffort: effort } : {}) }] };
  }}>
    <Field><FieldLabel htmlFor="source-route-name">{t("显示名称", "Display name")}</FieldLabel><Input id="source-route-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoFocus /></Field>
    <Field><FieldLabel htmlFor="source-route-model">{t("上游模型 ID", "Upstream model ID")}</FieldLabel><Input id="source-route-model" value={model} onChange={event => setModel(event.target.value)} maxLength={300} required spellCheck={false} /></Field>
    <div className="model-source-selector-fields"><Field><FieldLabel htmlFor="source-route-protocol">{t("协议 / Agent 引擎", "Protocol / agent engine")}</FieldLabel><NativeSelect id="source-route-protocol" value={protocol} onChange={event => { setProtocol(event.target.value as AccountApiProtocol); setEffort(""); }}>
      {source.endpoints.map(endpoint => <NativeSelectOption key={endpoint.protocol} value={endpoint.protocol}>{accountApiProtocolLabel(endpoint.protocol)}</NativeSelectOption>)}
    </NativeSelect></Field><Field><FieldLabel htmlFor="source-route-credential">{t("使用凭据", "Credential")}</FieldLabel><NativeSelect id="source-route-credential" value={credentialId} onChange={event => setCredentialId(event.target.value)}>{source.credentials.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Field></div>
    <ModelCapabilitiesFields value={capabilities} onChange={setCapabilities} disabled={false} protocol={protocol} effortSupported={protocol !== "openai_chat_completions"} />
    {protocol !== "openai_chat_completions" && <Field><FieldLabel htmlFor="source-route-effort">{t("默认推理强度", "Default reasoning effort")}</FieldLabel><NativeSelect id="source-route-effort" value={effort} onChange={event => setEffort(event.target.value)}><NativeSelectOption value="">{t("默认 / 不覆盖", "Default / no override")}</NativeSelectOption>{effort && !efforts.some(value => value === effort) && <NativeSelectOption value={effort} disabled>{effort} · {t("需声明支持", "declare support first")}</NativeSelectOption>}{efforts.map(value => <NativeSelectOption value={value} key={value}>{value}</NativeSelectOption>)}</NativeSelect></Field>}
  </EditorFrame>;
}
