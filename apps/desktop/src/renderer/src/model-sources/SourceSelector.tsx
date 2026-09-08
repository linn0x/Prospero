import { useEffect, useRef } from "react";
import type { ModelSource } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { accountApiEngineLabel, accountApiProtocolLabel } from "../account-profile-form";
import { useLocale } from "../locale";
import { defaultSourceSelection, rememberedSourceSelection, selectedSourceRoute, type SourceSelection } from "./source-state";
import "./model-sources.css";

export function SourceSelector({ sources, loading, error, value, onChange, onRefresh, disabled }: {
  sources: ModelSource[]; loading: boolean; error: string | undefined; value: SourceSelection | undefined; onChange: (value: SourceSelection | undefined) => void; onRefresh: () => void; disabled: boolean;
}) {
  const { t } = useLocale();
  const preferred = useRef(rememberedSourceSelection());
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!value && !loading) {
      const next = defaultSourceSelection(sources, preferred.current);
      if (next) change.current(next);
    }
  }, [sources, value, loading]);
  const source = sources.find(item => item.id === value?.sourceId);
  const selection = selectedSourceRoute(sources, value);
  return <div className="model-source-selector">
    <div className="model-source-selector-fields">
      <Field><FieldLabel htmlFor="session-model-source">{t("模型源", "Model source")}</FieldLabel><NativeSelect id="session-model-source" disabled={disabled || loading} value={source?.id ?? ""} onChange={event => onChange(defaultSourceSelection(sources.filter(item => item.id === event.target.value)))}>
        <NativeSelectOption value="" disabled>{loading ? t("读取中…", "Loading…") : t("选择模型源", "Choose source")}</NativeSelectOption>
        {sources.map(item => <NativeSelectOption key={item.id} value={item.id} disabled={!item.enabled || !item.routes.some(route => route.enabled && route.modelCapabilities?.tools !== false)}>{item.name}{!item.enabled ? t("（已停用）", " (disabled)") : ""}</NativeSelectOption>)}
      </NativeSelect></Field>
      <Field><FieldLabel htmlFor="session-source-route">{t("模型", "Model")}</FieldLabel><NativeSelect id="session-source-route" disabled={disabled || loading || !source} value={source?.routes.some(route => route.id === value?.routeId) ? value!.routeId : ""} onChange={event => { if (source) onChange({ sourceId: source.id, routeId: event.target.value, revision: source.revision }); }}>
        <NativeSelectOption value="" disabled>{t("选择已启用的模型", "Choose enabled model")}</NativeSelectOption>
        {source?.routes.map(route => <NativeSelectOption key={route.id} value={route.id} disabled={!route.enabled || route.modelCapabilities?.tools === false}>{route.name} · {accountApiEngineLabel(route.protocol)}</NativeSelectOption>)}
      </NativeSelect></Field>
    </div>
    {error && <p role="alert">{error}</p>}
    {selection && <FieldDescription>{accountApiProtocolLabel(selection.route.protocol)} · {selection.source.credentials.find(item => item.id === selection.route.credentialId)?.name}{selection.route.defaultEffort ? ` · ${selection.route.defaultEffort}` : ""}<br />{t("使用共享连接；创建后固定此版本，不随模型源编辑自动切换。", "Uses the shared connection. The session stays on this version after source edits.")}</FieldDescription>}
    {source && value && source.revision !== value.revision && <p role="alert">{t("模型源已更新，请确认后使用新配置。", "The source changed. Confirm before using its new configuration.")}<Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(defaultSourceSelection([source], value))}>{t("使用新配置", "Use updated configuration")}</Button></p>}
    {!loading && !sources.some(item => item.enabled && item.routes.some(route => route.enabled)) && <p>{t("请在“Agent 与账号”同一页面添加模型源并启用模型。", "Add a source and enable models on the Agents & accounts page.")}</p>}
    <Button className="w-fit" variant="ghost" size="sm" disabled={disabled || loading} onClick={onRefresh}>{t("刷新模型源", "Refresh sources")}</Button>
  </div>;
}
