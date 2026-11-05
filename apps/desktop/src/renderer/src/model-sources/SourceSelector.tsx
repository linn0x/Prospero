import { useEffect, useRef } from "react";
import type { ModelSource } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { accountApiProtocolLabel } from "../account-profile-form";
import { useLocale } from "../locale";
import { defaultSourceSelection, sourceRouteLabel, rememberedSourceSelection, selectedSourceRoute, sourceRouteSupportsAgent, type SourceRuntimeAgent, type SourceSelection } from "./source-state";
import "./model-sources.css";

export function SourceSelector({ sources, loading, error, value, agent, onChange, onRefresh, disabled }: {
  sources: ModelSource[]; loading: boolean; error: string | undefined; value: SourceSelection | undefined; agent?: SourceRuntimeAgent; onChange: (value: SourceSelection | undefined) => void; onRefresh: () => void; disabled: boolean;
}) {
  const { t } = useLocale();
  const preferred = useRef(rememberedSourceSelection());
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!value && !loading) {
      const next = defaultSourceSelection(sources, preferred.current, agent);
      if (next) change.current(next);
    }
  }, [agent, sources, value, loading]);
  const source = sources.find(item => item.id === value?.sourceId);
  const selection = selectedSourceRoute(sources, value, agent);
  return <div className="model-source-selector">
    <div className="model-source-selector-fields">
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor="session-model-source">{t("API 模型源", "Model source")}</FieldLabel>
          <Button className="h-6 px-2 text-xs" variant="ghost" size="sm" disabled={disabled || loading} onClick={onRefresh}>↻ {t("刷新模型源", "Refresh sources")}</Button>
        </div>
        <NativeSelect id="session-model-source" disabled={disabled || loading} value={source?.id ?? ""} onChange={event => onChange(defaultSourceSelection(sources.filter(item => item.id === event.target.value), undefined, agent))}>
          <NativeSelectOption value="" disabled>{loading ? t("读取中…", "Loading…") : t("选择模型源", "Choose source")}</NativeSelectOption>
          {sources.map(item => <NativeSelectOption key={item.id} value={item.id} disabled={!item.enabled || !item.routes.some(route => route.enabled && route.modelCapabilities?.tools !== false && sourceRouteSupportsAgent(route, agent))}>{item.name}{!item.enabled ? t("（已停用）", " (disabled)") : ""}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <Field>
        <div className="flex items-center justify-between gap-2 min-h-6">
          <FieldLabel htmlFor="session-source-route">{t("已启用模型", "Model")}</FieldLabel>
        </div>
        <NativeSelect id="session-source-route" disabled={disabled || loading || !source} value={selection?.route.id ?? ""} onChange={event => { if (source) onChange({ sourceId: source.id, routeId: event.target.value, revision: source.revision, ...(agent ? { agent } : {}) }); }}>
          <NativeSelectOption value="" disabled>{t("选择已启用的模型", "Choose enabled model")}</NativeSelectOption>
          {source?.routes.map(route => <NativeSelectOption key={route.id} value={route.id} disabled={!route.enabled || route.modelCapabilities?.tools === false || !sourceRouteSupportsAgent(route, agent)}>{sourceRouteLabel(route)}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
    </div>
    {error && <p role="alert">{error}</p>}
    {selection && <div className="session-auth-status-bar">
      <span>{t("协议：", "Protocol: ")}{accountApiProtocolLabel(selection.route.protocol)} · {t("凭据：", "Key: ")}{selection.source.credentials.find(item => item.id === selection.route.credentialId)?.name}{selection.route.defaultEffort ? ` · ${selection.route.defaultEffort}` : ""}</span>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("连接详情", "Connection details")}</summary>
        <FieldDescription className="mt-1">{t("模型源更新不会改变已创建的会话。", "Source updates do not change existing sessions.")}</FieldDescription>
      </details>
    </div>}
    {source && value && source.revision !== value.revision && <p role="alert">{t("模型源已更新，请确认后使用新配置。", "The source changed. Confirm before using its new configuration.")}<Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(defaultSourceSelection([source], value, agent))}>{t("使用新配置", "Use updated configuration")}</Button></p>}
    {!loading && !sources.some(item => item.enabled && item.routes.some(route => route.enabled)) && <p className="text-xs text-muted-foreground">{t("请在“账号与模型源”页面的 API 模型源中添加并启用模型。", "Add a source and enable models on the Accounts & model sources page.")}</p>}
  </div>;
}
