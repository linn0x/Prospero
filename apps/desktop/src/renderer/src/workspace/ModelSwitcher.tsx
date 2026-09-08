import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import type { AgentModelCatalog, JsonObject, SessionInfo } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { useLocale } from "../locale";
import { reportError } from "../state";

import { cachedModelCatalog, loadModelCatalog, modelSwitchSupported, saveModelCatalog, supportedModelEffort } from "./model-catalog";

export function ModelSwitcher({ session, account }: { session: SessionInfo; account: JsonObject | undefined }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<AgentModelCatalog | undefined>(() => cachedModelCatalog(session.id));
  const [query, setQuery] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const request = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);
  const supported = modelSwitchSupported(session, account);
  const controls = session.agentControls;
  useEffect(() => {
    if (!controls?.currentModel) return;
    setCatalog((previous) => previous ? { models: previous.models, currentModel: controls.currentModel!, ...(controls.currentEffort ? { currentEffort: controls.currentEffort } : {}) } : previous);
  }, [controls?.currentModel, controls?.currentEffort]);
  const current = catalog?.currentModel || controls?.currentModel;
  const model = catalog?.models.find((entry) => entry.id === modelId);
  const models = useMemo(() => catalog?.models.filter((entry) => `${entry.label} ${entry.id} ${entry.description ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 200) ?? [], [catalog, query]);
  const unavailable = !supported || session.status === "starting" || ["failed", "cancelled", "exited", "stopped"].includes(session.status);
  const load = async (refresh = false): Promise<void> => {
    if (busy.current || unavailable) return;
    const token = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const value = await loadModelCatalog(window.prospero, session.id, refresh);
      if (!mounted.current || token !== request.current) return;
      setCatalog(value);
      setModelId(value.currentModel ?? value.models.find((entry) => entry.isDefault)?.id ?? value.models[0]?.id ?? "");
      setEffort(value.currentEffort ?? "");
    } catch (reason) {
      if (mounted.current && token === request.current) setError(reportError(reason));
    } finally {
      if (mounted.current && token === request.current) setLoading(false);
    }
  };
  const save = async (): Promise<void> => {
    if (busy.current || !model || unavailable || loading) return;
    busy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const selectedEffort = supportedModelEffort(model, effort);
      const selection = await window.prospero.setAgentModel(session.id, model.id, selectedEffort);
      const next: AgentModelCatalog = { models: catalog?.models ?? [], ...selection };
      saveModelCatalog(session.id, next);
      if (!mounted.current) return;
      setCatalog(next);
      setNotice(t("模型已更新，下一轮生效", "Model updated for the next turn"));
      setOpen(false);
    } catch (reason) {
      if (mounted.current) setError(reportError(reason));
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  if (!supported) return null;
  return <>
    <Button className="session-model-chip" variant="outline" size="sm" disabled={unavailable} aria-label={t("切换模型", "Switch model")} title={current || t("切换模型", "Switch model")} onClick={() => { setOpen(true); setQuery(""); setNotice(undefined); void load(); }}>
      <span>{current?.split("/").at(-1) || t("模型", "Model")}</span><ChevronDown />
    </Button>
    {notice && <span className="sr-only" role="status">{notice}</span>}
    <Dialog open={open} onOpenChange={(value) => { if (!busy.current) setOpen(value); }}>
      <DialogContent className="session-model-dialog" showCloseButton={!saving} closeLabel={t("关闭", "Close")} aria-busy={loading || saving}>
        <DialogHeader><DialogTitle>{t("模型与推理强度", "Model and reasoning effort")}</DialogTitle><DialogDescription>{t("选择会话下一轮使用的模型。", "Choose the model for the next turn.")}</DialogDescription></DialogHeader>
        <div className="model-search-row"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索模型", "Search models")} aria-label={t("搜索模型", "Search models")} disabled={saving} /><Button variant="outline" size="icon-sm" aria-label={t("刷新模型", "Refresh models")} disabled={loading || saving} onClick={() => void load(true)}><RefreshCw className={loading ? "animate-spin" : undefined} /></Button></div>
        {error && <div className="workspace-action-error" role="alert">{error}</div>}
        <div className="model-options" role="group" aria-label={t("可用模型", "Available models")}>
          {loading ? <p role="status">{t("正在加载模型…", "Loading models…")}</p> : models.length === 0 ? <p>{t("没有匹配的模型，可刷新目录后重试。", "No matching models. Refresh the catalog to retry.")}</p> : models.map((entry) => <button type="button" key={entry.id} className="model-option" data-slot="session-model-option" aria-pressed={entry.id === modelId} disabled={saving} onClick={() => { setModelId(entry.id); setEffort(""); }}><span><strong>{entry.label || entry.id}</strong><small>{entry.description || entry.id}</small></span>{entry.id === modelId && <Check />}</button>)}
        </div>
        {Boolean(model?.supportedEfforts.length) && <label className="model-effort-field"><span>{t("推理强度", "Reasoning effort")}</span><NativeSelect aria-label={t("推理强度", "Reasoning effort")} value={supportedModelEffort(model, effort) ?? ""} onChange={(event) => setEffort(event.target.value)} disabled={saving || loading || !model?.supportedEfforts.length}><NativeSelectOption value="">{t("使用模型默认值", "Use model default")}</NativeSelectOption>{model?.supportedEfforts.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></label>}
        <DialogFooter><Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>{t("取消", "Cancel")}</Button><Button disabled={saving || loading || !model || unavailable} onClick={() => void save()}>{saving ? t("正在切换…", "Switching…") : t("应用到下一轮", "Apply to next turn")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
