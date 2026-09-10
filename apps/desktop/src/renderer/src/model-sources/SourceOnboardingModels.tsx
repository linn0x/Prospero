import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentApiCatalogModel, ModelSource } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { Spinner } from "../components/ui/spinner";
import { ModelCapabilitiesFields } from "../ModelCapabilitiesFields";
import { accountApiProtocolLabel, accountReasoningEfforts } from "../account-profile-form";
import { AccountRequestGate } from "../accounts/account-request-state";
import { featureErrorText } from "../accounts/feature-errors";
import { useLocale } from "../locale";
import { catalogRouteDraft, type SourceRouteDraft } from "./source-state";

const routeKey = (route: Pick<SourceRouteDraft, "model" | "protocol">) => JSON.stringify([route.protocol, route.model]);

export function SourceOnboardingModels({ endpoints, disabled = false, apiKey, value, onChange, onBusy }: {
  endpoints: ModelSource["endpoints"]; disabled?: boolean; apiKey: string; value: SourceRouteDraft[]; onChange: (value: SourceRouteDraft[]) => void; onBusy: (busy: boolean) => void;
}) {
  const { t } = useLocale();
  const [protocol, setProtocol] = useState(endpoints[0]!.protocol);
  const selectedProtocol = endpoints.some(item => item.protocol === protocol) ? protocol : endpoints[0]!.protocol;
  const endpoint = endpoints.find(item => item.protocol === selectedProtocol)!;
  const [models, setModels] = useState<AgentApiCatalogModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [editing, setEditing] = useState("");
  const [requests] = useState(() => new AccountRequestGate());
  const connectionKey = JSON.stringify(endpoints);
  const identity = useMemo(() => ({}), [connectionKey, apiKey, selectedProtocol, disabled]);
  const current = useRef(identity);
  current.current = identity;
  useLayoutEffect(() => {
    requests.invalidate(); setModels([]); setLoaded(false); setBusy(false); setError(""); setQuery(""); onBusy(false);
    return () => { requests.invalidate(); };
  }, [identity, requests, onBusy]);
  const load = async () => {
    if (disabled || !endpoint.baseUrl.trim() || !apiKey.trim()) return;
    const token = requests.begin();
    if (token === undefined) return;
    setBusy(true); onBusy(true); setError("");
    try {
      const result = await window.prospero.getAccountModels({ protocol: selectedProtocol, baseUrl: endpoint.baseUrl.trim(), apiKey, ...(endpoint.headers ? { headers: endpoint.headers } : {}) });
      if (!requests.current(token) || current.current !== identity) return;
      if (!result.ok) { setError(featureErrorText(result.error, t)); return; }
      setModels(result.models); setLoaded(true);
    } catch {
      if (requests.current(token) && current.current === identity) setError(t("无法读取目录，请重试或手动添加模型。", "Unable to load models. Retry or add a model manually."));
    } finally { if (requests.finish(token)) { setBusy(false); onBusy(false); } }
  };
  const add = (model: AgentApiCatalogModel) => {
    const draft = catalogRouteDraft(model, selectedProtocol);
    if (value.length >= 100 || value.some(item => routeKey(item) === routeKey(draft))) return;
    onChange([...value, draft]); setEditing(routeKey(draft));
  };
  const addManual = () => { if (manual.trim()) { add({ id: manual.trim() }); setManual(""); } };
  const selected = value.find(item => routeKey(item) === editing) ?? value[0];
  const update = (draft: SourceRouteDraft) => onChange(value.map(item => item === selected ? draft : item));
  const results = models.filter(model => `${model.id} ${model.label ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const efforts = selected?.capabilities.supportedEfforts.split(/[,，\s]+/).filter(value => (accountReasoningEfforts as readonly string[]).includes(value)) ?? [];
  return <section className="model-source-onboarding" aria-label={t("接入模型", "Connect models")}>
    <div className="model-source-subheading"><h4>{t("连接并选择模型", "Connect and choose models")}</h4><span className="model-source-hint">{t(`已选 ${value.length} / 100`, `Selected ${value.length} / 100`)}</span></div>
    <div className="model-source-catalog-controls">
      {endpoints.length > 1 && <NativeSelect aria-label={t("读取模型的协议", "Model discovery protocol")} value={selectedProtocol} disabled={busy} onChange={event => setProtocol(event.target.value as typeof protocol)}>{endpoints.map(item => <NativeSelectOption key={item.protocol} value={item.protocol}>{accountApiProtocolLabel(item.protocol)}</NativeSelectOption>)}</NativeSelect>}
      <Button type="button" variant="outline" disabled={disabled || busy || !apiKey.trim() || !endpoint.baseUrl.trim()} onClick={() => void load()}>{busy && <Spinner />}{busy ? t("正在读取模型…", "Loading models…") : loaded ? t("刷新模型目录", "Refresh models") : t("连接并加载模型", "Connect and load models")}</Button>
    </div>
    <p className="model-source-hint">{t("只读取目录，不发送推理请求。自动填入上游明确返回的参数；未知项可手动补充，目录不可用也可手动接入。", "Only reads the catalog, without inference requests. Reported parameters are filled in; unknown values and models can be entered manually.")}</p>
    {error && <p className="model-source-error" role="alert">{error}</p>}
    {loaded && <><Input type="search" value={query} maxLength={200} aria-label={t("搜索接入模型", "Search discovered models")} placeholder={t("搜索模型 ID 或名称", "Search model ID or name")} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />
      <div className="model-source-catalog-list">{results.slice(0, 100).map(model => {
        const key = routeKey({ model: model.id, protocol: selectedProtocol });
        const checked = value.some(item => routeKey(item) === key);
        const caps = model.modelCapabilities;
        return <label key={model.id}><input type="checkbox" checked={checked} disabled={!checked && value.length >= 100} onChange={() => checked ? onChange(value.filter(item => routeKey(item) !== key)) : add(model)} /><span><strong>{model.label || model.id}</strong><small>{model.id}</small><small>{t("上下文", "Context")} {caps?.contextWindow ?? t("未知", "Unknown")} · {t("输出上限", "Output limit")} {caps?.maxOutputTokens ?? t("未知", "Unknown")}</small></span></label>;
      })}{!results.length && <p className="model-source-hint">{t("没有匹配模型，可以手动添加。", "No matches. You can add a model manually.")}</p>}</div>
      <p className="model-source-hint" role="status">{t(`读取到 ${models.length} 个模型`, `Loaded ${models.length} models`)}{results.length > 100 && t("；显示前 100 个，请搜索缩小范围。", "; showing the first 100. Search to narrow the results.")}</p>
    </>}
    <div className="model-source-catalog-controls"><Input value={manual} maxLength={300} aria-label={t("手动模型 ID", "Manual model ID")} placeholder={t("手动填写模型 ID", "Enter a model ID manually")} onChange={event => setManual(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addManual(); } }} /><Button type="button" variant="ghost" disabled={!manual.trim() || value.length >= 100 || value.some(item => item.model === manual.trim() && item.protocol === selectedProtocol)} onClick={addManual}>{t("添加模型", "Add model")}</Button></div>
    {selected && <div className="model-source-onboarding-editor">
      <Field><FieldLabel htmlFor="onboarding-model">{t("所选模型与参数", "Selected models and parameters")}</FieldLabel><NativeSelect id="onboarding-model" value={routeKey(selected)} onChange={event => setEditing(event.target.value)}>{value.map((item, index) => <NativeSelectOption key={routeKey(item)} value={routeKey(item)}>{item.name} · {accountApiProtocolLabel(item.protocol)}{index === 0 ? t(" · 默认", " · Default") : ""}</NativeSelectOption>)}</NativeSelect></Field>
      <div className="model-source-catalog-controls"><Button type="button" size="sm" variant="ghost" disabled={selected === value[0]} onClick={() => onChange([selected, ...value.filter(item => item !== selected)])}>{t("设为默认模型", "Make default model")}</Button><Button type="button" size="sm" variant="ghost" onClick={() => onChange(value.filter(item => item !== selected))}>{t("取消选择", "Deselect")}</Button></div>
      <Field><FieldLabel htmlFor="onboarding-model-name">{t("显示名称", "Display name")}</FieldLabel><Input id="onboarding-model-name" value={selected.name} required maxLength={80} onChange={event => update({ ...selected, name: event.target.value })} /></Field>
      <p className="model-source-hint">{selected.model} · {t("上下文", "Context")} {selected.capabilities.contextWindow || t("未知", "Unknown")} · {t("输出上限", "Output limit")} {selected.capabilities.maxOutputTokens || t("未知", "Unknown")}</p>
      {selected.partialTokenLimits && (!selected.capabilities.contextWindow || !selected.capabilities.maxOutputTokens) && <p className="model-source-hint" role="status">{t("目录仅报告单项 Token 上限：", "The catalog reported only one token limit: ")}{selected.partialTokenLimits.contextWindow ? `${t("上下文", "Context")} ${selected.partialTokenLimits.contextWindow}` : `${t("输出", "Output")} ${selected.partialTokenLimits.maxOutputTokens}`}。{t("当前 Chat Completions 引擎要求两个上限同时配置，因此暂不应用这对限制；可按服务商文档补齐后保存。", "The Chat Completions engine requires both limits, so neither is applied yet. Fill in both using provider documentation to apply them.")}</p>}
      <ModelCapabilitiesFields value={selected.capabilities} onChange={capabilities => update({ ...selected, capabilities })} disabled={false} protocol={selected.protocol} effortSupported={selected.protocol !== "openai_chat_completions"} />
      {selected.protocol !== "openai_chat_completions" && <Field><FieldLabel htmlFor="onboarding-model-effort">{t("默认推理强度", "Default reasoning effort")}</FieldLabel><NativeSelect id="onboarding-model-effort" value={selected.effort} onChange={event => update({ ...selected, effort: event.target.value })}><NativeSelectOption value="">{t("默认 / 不覆盖", "Default / no override")}</NativeSelectOption>{selected.effort && !efforts.includes(selected.effort) && <NativeSelectOption value={selected.effort} disabled>{selected.effort} · {t("需声明支持", "declare support first")}</NativeSelectOption>}{[...new Set(efforts)].map(effort => <NativeSelectOption key={effort} value={effort}>{effort}</NativeSelectOption>)}</NativeSelect></Field>}
    </div>}
    <p className="model-source-hint">{value.length ? t("保存时一起启用所选模型。之后可直接选择模型新建会话。", "Selected models are enabled when saved and become available for new sessions.") : t("尚未选择模型；也可以先保存连接，稍后添加。", "No models selected. You can also save the connection and add models later.")}</p>
  </section>;
}
