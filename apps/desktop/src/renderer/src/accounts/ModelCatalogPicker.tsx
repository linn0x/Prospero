import { useDeferredValue, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AccountModelsInput, AgentApiCatalogModel } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import { featureErrorText } from "./feature-errors";
import { AccountRequestGate } from "./account-request-state";

export function ModelCatalogPicker({ value, onChange, request, supported, disabled = false, unavailableReason }: {
  value: string;
  onChange: (value: string) => void;
  request?: AccountModelsInput | undefined;
  supported: boolean;
  disabled?: boolean;
  unavailableReason?: string | undefined;
}) {
  const { t } = useLocale();
  const id = useId();
  const [models, setModels] = useState<AgentApiCatalogModel[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<object>();
  const [limit, setLimit] = useState(100);
  const [active, setActive] = useState(0);
  const [requests] = useState(() => new AccountRequestGate());
  const canFetch = supported && typeof window.prospero.getAccountModels === "function";
  const source = useMemo(() => ({}), [request?.accountId, request?.protocol, request?.baseUrl, request?.apiKey, canFetch]);
  const currentSource = useRef(source);
  currentSource.current = source;
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  useLayoutEffect(() => {
    requests.invalidate();
    setBusy(false);
    setModels([]);
    setLoaded(undefined);
    setError("");
    setOpen(false);
    setQuery(""); setLimit(100); setActive(0);
    return () => { requests.invalidate(); };
  }, [source, requests]);
  const filtered = useMemo(() => models.filter(model => !deferredQuery ||
    [model.id, model.label, model.owner, model.description].some(value => value?.toLocaleLowerCase().includes(deferredQuery))),
  [models, deferredQuery]);
  const fetchModels = async () => {
    if (disabled || !canFetch || !request) return;
    const token = requests.begin();
    if (token === undefined) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.prospero.getAccountModels(request);
      if (!requests.current(token) || currentSource.current !== source) return;
      if (!result.ok) { setError(featureErrorText(result.error, t)); return; }
      setModels(result.models);
      setLoaded(source);
      setQuery("");
      setLimit(100);
      setActive(0);
      setOpen(true);
      if (!result.models.length) setError(t("服务未返回模型，仍可手动填写模型 ID。", "No models were returned. You can still enter a model ID."));
    } catch {
      if (requests.current(token) && currentSource.current === source) setError(t("无法读取目录，请重试或手动填写模型。", "Unable to fetch the catalog. Retry or enter a model manually."));
    } finally {
      if (requests.finish(token)) setBusy(false);
    }
  };
  const visible = loaded === source ? filtered.slice(0, limit) : [];
  return <Field>
    <FieldLabel htmlFor={id}>{t("模型", "Model")}</FieldLabel>
    <div className="account-model-input">
      <Input id={id} value={value} onChange={event => onChange(event.target.value)} maxLength={300} spellCheck={false} disabled={disabled} autoComplete="off" />
      {canFetch && <Button type="button" variant="outline" size="sm" aria-busy={busy} disabled={busy || disabled || !request} onClick={() => void fetchModels()}>
        <DesktopIcon name="refresh" className={busy ? "daemon-spinner" : undefined} />
        {busy ? t("读取中", "Loading") : models.length ? t("刷新目录", "Refresh") : t("拉取模型", "Fetch models")}
      </Button>}
      {loaded === source && models.length > 0 && <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-expanded={open} aria-controls={id + "-catalog"} aria-label={t("展开模型目录", "Toggle model catalog")} onClick={() => setOpen(!open)}><DesktopIcon name={open ? "chevronUp" : "chevronDown"} /></Button>}
    </div>
    {!canFetch && <FieldDescription>{t("当前 daemon 不支持拉取目录，仍可手动填写模型。", "This daemon cannot fetch model catalogs. Enter a model manually.")}</FieldDescription>}
    {canFetch && !request && <FieldDescription>{unavailableReason ?? t("填写服务地址和 API Key 后可拉取目录。", "Enter a service URL and API key to fetch the catalog.")}</FieldDescription>}
    {error && <div className="account-inline-error" role="alert" tabIndex={0}>{error}</div>}
    {open && loaded === source && models.length > 0 && <div id={id + "-catalog"} className="model-catalog" onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); document.getElementById(id)?.focus();
    }}>
      <Input type="search" value={query} maxLength={200} disabled={disabled} aria-label={t("搜索模型", "Search models")} placeholder={t("搜索名称或模型 ID", "Search name or model ID")} onChange={event => { setQuery(event.target.value); setActive(0); setLimit(100); }} />
      <div className="model-catalog-options" role="listbox" aria-label={t("服务商模型目录", "Provider model catalog")}>
        {visible.map((model, index) => <button type="button" role="option" id={id + "-option-" + index} key={model.id} aria-selected={model.id === value} tabIndex={index === active ? 0 : -1} disabled={disabled}
          onFocus={() => setActive(index)} onClick={() => { onChange(model.id); setOpen(false); document.getElementById(id)?.focus(); }}
          onKeyDown={event => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
            setActive(next);
            document.getElementById(id + "-option-" + next)?.focus();
          }}>
          <span><strong>{model.label || model.id}</strong>{model.label && model.label !== model.id && <small>{model.id}</small>}{model.owner && <small>{model.owner}</small>}</span>
          {model.id === value && <DesktopIcon name="check" />}
        </button>)}
        {!visible.length && <p>{t("没有匹配的模型，可以直接输入自定义 ID。", "No matches. You can enter a custom model ID.")}</p>}
      </div>
      <div className="model-catalog-summary"><span role="status">{filtered.length} {t("个模型", "models")}</span>{filtered.length > limit && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setLimit(current => current + 100)}>{t("显示更多", "Show more")}</Button>}</div>
    </div>}
  </Field>;
}
