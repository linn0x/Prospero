import { useEffect, useRef, useState } from "react";
import type { AgentApiCatalogModel, DesktopSnapshot, ModelSource, ModelSourceAction, ModelSourceMigration, ModelSourceRoute } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { Spinner } from "../components/ui/spinner";
import { DesktopIcon } from "../design-system/icons";
import { accountApiEngineLabel, accountApiProtocolLabel } from "../account-profile-form";
import { useLocale } from "../locale";
import { reportError, record, text } from "../state";
import { catalogRouteUpdates, hasPartialCatalogLimits, type SourceSelection } from "./source-state";
import { SourceConnectionDialog, SourceCredentialDialog, SourceRouteDialog } from "./SourceDialogs";
import { runModelSourceAction, useModelSources } from "./use-model-sources";
import "./model-sources.css";

type Editor = { kind: "source"; source?: ModelSource } | { kind: "credential"; source: ModelSource; credentialId?: string } | { kind: "route"; source: ModelSource; route?: ModelSourceRoute };

function SourceCatalog({ source, disabled, onRun }: { source: ModelSource; disabled: boolean; onRun: (action: ModelSourceAction) => Promise<boolean> }) {
  const { t } = useLocale();
  const [protocol, setProtocol] = useState(source.endpoints[0]!.protocol);
  const [credentialId, setCredentialId] = useState(source.credentials[0]?.id ?? "");
  const [models, setModels] = useState<AgentApiCatalogModel[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const selectedProtocol = source.endpoints.some(item => item.protocol === protocol) ? protocol : source.endpoints[0]!.protocol;
  const selectedCredential = source.credentials.some(item => item.id === credentialId) ? credentialId : source.credentials[0]?.id ?? "";
  useEffect(() => { generation.current++; setModels([]); setSelected(new Set()); setLoaded(false); setLoading(false); setError(undefined); return () => { generation.current++; }; }, [source.id, source.revision, selectedProtocol, selectedCredential]);
  const load = async (refresh = false): Promise<AgentApiCatalogModel[] | undefined> => {
    if (loading || !selectedCredential) return;
    const token = ++generation.current;
    setLoading(true); setError(undefined);
    try {
      const result = await runModelSourceAction({ kind: "models", sourceId: source.id, revision: source.revision, protocol: selectedProtocol, credentialId: selectedCredential, ...(refresh ? { refresh: true } : {}) });
      const next = result.models ?? [];
      if (generation.current === token) { setModels(next); setLoaded(true); }
      return next;
    } catch (reason) { if (generation.current === token) setError(reportError(reason)); }
    finally { if (generation.current === token) setLoading(false); }
  };
  const syncAll = async () => {
    const next = await load(true);
    if (!next?.length) return;
    const all = new Set(next.map(model => model.id));
    setSelected(all);
    await onRun({ kind: "routes.set", sourceId: source.id, revision: source.revision, routes: catalogRouteUpdates(source, selectedProtocol, selectedCredential, next, all) });
  };
  const results = models.filter(model => `${model.id} ${model.label ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <details className="model-source-catalog"><summary>{t("从服务商读取模型目录", "Read the provider model catalog")}</summary>
    <div className="model-source-catalog-controls"><NativeSelect value={selectedProtocol} disabled={disabled || loading} aria-label={t("目录协议", "Catalog protocol")} onChange={event => setProtocol(event.target.value as typeof protocol)}>{source.endpoints.map(item => <NativeSelectOption key={item.protocol} value={item.protocol}>{accountApiProtocolLabel(item.protocol)}</NativeSelectOption>)}</NativeSelect>
      <NativeSelect value={selectedCredential} disabled={disabled || loading} aria-label={t("目录凭据", "Catalog credential")} onChange={event => setCredentialId(event.target.value)}>{!source.credentials.length && <NativeSelectOption value="">{t("请先添加凭据", "Add a credential first")}</NativeSelectOption>}{source.credentials.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect>
      <Button variant="outline" size="sm" disabled={disabled || loading || !selectedCredential} onClick={() => void load()}>{loading ? <Spinner /> : <DesktopIcon name="refresh" />}{t("读取目录", "Fetch models")}</Button>
      <Button size="sm" disabled={disabled || loading || !selectedCredential} onClick={() => void syncAll()}>{loading ? <Spinner /> : <DesktopIcon name="refresh" />}{t("同步并启用全部模型", "Sync and enable all models")}</Button></div>
    {error && <p className="model-source-error" role="alert">{error}</p>}
    <p className="model-source-hint">{t("目录按连接和凭据版本缓存；新模型自动填入上游返回的能力参数，已配置模型保留你的设置。未知项可手动补充。", "Catalogs are cached per connection and credential version. New models inherit reported parameters; existing configurations are preserved. Unknown values can be entered manually.")}</p>
    {models.some(model => selected.has(model.id) && hasPartialCatalogLimits(model, selectedProtocol)) && <p className="model-source-hint" role="status">{t("部分模型只返回一个 Token 上限。Chat Completions 引擎要求两个上限同时配置，批量启用时暂不应用这对限制；启用后可编辑补齐，其他能力仍保留。", "Some models report only one token limit. Chat Completions requires both, so bulk enabling omits that pair. Other capabilities are retained; edit the model afterward to supply both limits.")}</p>}
    {loaded && <><Input type="search" maxLength={200} placeholder={t("筛选模型 ID 或名称", "Filter model ID or name")} aria-label={t("筛选目录", "Filter catalog")} value={query} onChange={event => setQuery(event.target.value)} />
      <div className="model-source-catalog-list">{results.slice(0, 100).map(model => {
        const enabled = source.routes.some(route => route.model === model.id && route.protocol === selectedProtocol && route.credentialId === selectedCredential && route.enabled);
        return <label key={model.id}><input type="checkbox" checked={enabled || selected.has(model.id)} disabled={disabled || enabled || !selected.has(model.id) && selected.size >= 500} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(model.id)) next.delete(model.id); else next.add(model.id); return next; })} /><span><strong>{model.label || model.id}</strong><small>{model.id}</small></span>{enabled && <small>{t("已启用", "Enabled")}</small>}</label>;
      })}{!results.length && <p>{t("没有匹配模型，可手动添加。", "No matching models. You can add one manually.")}</p>}</div>
      {results.length > 500 && <p className="model-source-hint">{t(`显示前 500 个，共 ${results.length} 个；输入名称缩小范围。`, `Showing 500 of ${results.length}; narrow the search by name.`)}</p>}
      <Button size="sm" disabled={disabled || !selected.size} onClick={() => void onRun({ kind: "routes.set", sourceId: source.id, revision: source.revision, routes: catalogRouteUpdates(source, selectedProtocol, selectedCredential, models, selected) })}>{t(`启用所选模型（${selected.size}）`, `Enable selected models (${selected.size})`)}</Button>
    </>}
  </details>;
}

function MigrationDialog({ groups, sources, skipped, onClose, onApply, busy, error }: { groups: ModelSourceMigration[]; sources: ModelSource[]; skipped: number; onClose: () => void; onApply: (group: ModelSourceMigration, name: string, target?: { sourceId: string; revision: number }) => void; busy: boolean; error: string | undefined }) {
  const { t } = useLocale();
  const [names, setNames] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="model-source-dialog" showCloseButton={!busy} closeLabel={t("关闭", "Close")}><DialogHeader><DialogTitle>{t("整理已有 API Profile", "Organize existing API profiles")}</DialogTitle><DialogDescription>{t("按协议和规范化地址分组。只有点击迁移才会建立共享引用；账号 ID、历史会话和原始凭据保留，可恢复独立 Profile。", "Grouped by protocol and normalized URL. Migration requires confirmation. Account IDs, history and original credentials are retained, so independent profiles can be restored.")}</DialogDescription></DialogHeader>
    {error && <p className="model-source-error" role="alert">{error}</p>}
    {groups.map(group => {
      const target = sources.find(source => source.id === targets[group.id]);
      return <section className="model-source-migration-group" key={group.id}><strong>{accountApiProtocolLabel(group.protocol)}</strong><code>{group.baseUrl}</code><p>{t(`${group.accounts.length} 个 Profile · ${group.credentialCount} 组不同凭据`, `${group.accounts.length} profiles · ${group.credentialCount} distinct credentials`)}</p><p className="model-source-hint">{group.accounts.map(account => account.name).join(" · ")}</p>
        <NativeSelect aria-label={t("迁移目标", "Migration destination")} disabled={busy} value={target?.id ?? ""} onChange={event => setTargets(current => ({ ...current, [group.id]: event.target.value }))}><NativeSelectOption value="">{t("创建新模型源", "Create a new source")}</NativeSelectOption>{sources.map(source => <NativeSelectOption key={source.id} value={source.id} disabled={source.endpoints.some(endpoint => endpoint.protocol === group.protocol && endpoint.baseUrl !== group.baseUrl)}>{t("合并到", "Merge into")} {source.name}</NativeSelectOption>)}</NativeSelect>
        {!target && <Input value={names[group.id] ?? group.name} maxLength={80} disabled={busy} aria-label={t("迁移后的模型源名称", "Migrated source name")} onChange={event => setNames(current => ({ ...current, [group.id]: event.target.value }))} />}
        <Button disabled={busy || !target && !(names[group.id] ?? group.name).trim()} onClick={() => onApply(group, target?.name ?? (names[group.id] ?? group.name).trim(), target ? { sourceId: target.id, revision: target.revision } : undefined)}>{busy && <Spinner />}{t("确认迁移此组", "Confirm migration of this group")}</Button></section>;
    })}
    {!groups.length && <p>{t("没有待迁移的有效 Profile。", "No valid profiles remain to migrate.")}</p>}
    {skipped > 0 && <p>{t(`已跳过 ${skipped} 个凭据不可用或超出分组限制的 Profile。`, `Skipped ${skipped} profiles with unavailable credentials or grouping limits.`)}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{t("关闭", "Close")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function ModelSourcesPane({ snapshot, onUse }: { snapshot: DesktopSnapshot; onUse: (selection: SourceSelection) => void }) {
  const { t } = useLocale();
  const supported = snapshot.daemon.running && snapshot.daemon.capabilities?.includes("model.sources.v1") === true && typeof window.prospero.modelSourceAction === "function";
  const state = useModelSources(supported);
  const [selectedId, setSelectedId] = useState<string>();
  const [editor, setEditor] = useState<Editor>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState("");
  const [migration, setMigration] = useState<{ groups: ModelSourceMigration[]; skipped: number }>();
  const [confirmation, setConfirmation] = useState<{ action: ModelSourceAction; title: string; description: string }>();
  const pending = useRef(false);
  const selected = state.sources.find(source => source.id === selectedId) ?? state.sources[0];
  const [routeFilter, setRouteFilter] = useState("");
  const [routeLimit, setRouteLimit] = useState(50);
  const [sourceFilter, setSourceFilter] = useState("");
  const run = async (action: ModelSourceAction): Promise<boolean> => {
    if (pending.current || !supported) return false;
    pending.current = true; setBusy(true); setError(undefined); setNotice("");
    try {
      const result = await runModelSourceAction(action);
      if (action.kind === "migration.preview") setMigration({ groups: result.migrations ?? [], skipped: result.skippedAccounts ?? 0 });
      else {
        setNotice(t("已保存，已有会话仍使用原连接版本。", "Saved. Existing sessions keep their original connection version."));
        if (action.kind === "migration.apply") setMigration(current => current && { ...current, groups: current.groups.filter(group => group.id !== action.migrationId) });
      }
      return true;
    } catch (reason) { setError(reportError(reason)); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const disabled = busy || state.loading || !supported;
  const closeEditor = () => { setEditor(undefined); void state.refresh(); };
  const boundAccounts = selected ? snapshot.accounts.filter(account => record(account.modelSource).sourceId === selected.id) : [];
  const legacyAccounts = boundAccounts.filter(account => record(account.modelSource).legacy === true);
  const routes = selected?.routes.filter(route => `${route.name} ${route.model}`.toLowerCase().includes(routeFilter.trim().toLowerCase())) ?? [];
  return <section className="model-sources-section" aria-labelledby="model-sources-title">
    <div className="model-source-section-heading"><div><h2 id="model-sources-title">{t("模型源", "Model sources")}</h2><p>{t("共享连接和凭据，按模型选择 Agent。", "Share connections and credentials; choose an agent by model.")}</p></div><div className="button-row"><Button size="sm" variant="ghost" disabled={disabled} onClick={() => void state.refresh()}><DesktopIcon name="refresh" />{t("刷新", "Refresh")}</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => void run({ kind: "migration.preview" })}>{t("整理已有 Profile", "Organize profiles")}</Button><Button size="sm" disabled={disabled} onClick={() => setEditor({ kind: "source" })}><DesktopIcon name="add" />{t("添加模型源", "Add model source")}</Button></div></div>
    {!supported && <p className="model-source-hint">{t("启动或更新本机 daemon 后可管理共享模型源。CLI 账号与旧 Profile 仍保留。", "Start or update the local daemon to manage shared sources. CLI accounts and legacy profiles are retained.")}</p>}
    {(error || state.error) && <div className="model-source-error" role="alert">{error || state.error}<Button size="sm" variant="ghost" disabled={busy || state.loading} onClick={() => { setError(undefined); void state.refresh(); }}>{t("刷新重试", "Refresh and retry")}</Button></div>}
    {notice && <p className="model-source-notice" role="status">{notice}</p>}
    {state.loading && !state.sources.length && <p role="status"><Spinner />{t("读取模型源…", "Loading model sources…")}</p>}
    {!state.loading && supported && !state.sources.length && <p className="model-source-empty">{t("同一服务地址只需配置一次，然后添加或批量启用多个模型。也可以从下面的旧 Profile 开始迁移。", "Configure a service address once, then add or enable multiple models. You can also migrate the legacy profiles below.")}</p>}
    {selected && <div className="model-source-layout"><aside className="model-source-list" aria-label={t("模型源列表", "Model sources")}><Input type="search" maxLength={200} value={sourceFilter} aria-label={t("筛选模型源", "Filter model sources")} placeholder={t("搜索模型源", "Search sources")} onChange={event => setSourceFilter(event.target.value)} />{state.sources.filter(source => `${source.name} ${source.endpoints.map(endpoint => endpoint.baseUrl).join(" ")}`.toLowerCase().includes(sourceFilter.trim().toLowerCase())).map(source => <button key={source.id} type="button" aria-pressed={source.id === selected.id} onClick={() => { setSelectedId(source.id); setRouteFilter(""); setRouteLimit(50); setError(undefined); }}><DesktopIcon name="server" /><span><strong>{source.name}</strong><small>{t(`${source.routes.filter(route => route.enabled).length} 个模型 · ${source.credentials.length} 组凭据`, `${source.routes.filter(route => route.enabled).length} models · ${source.credentials.length} keys`)}</small>{!source.enabled && <small>{t("已停用", "Disabled")}</small>}</span></button>)}</aside>
      <div className="model-source-detail"><div className="model-source-detail-heading"><div><h3>{selected.name}</h3><span className="model-source-hint">{t(`连接版本 ${selected.revision}`, `Connection version ${selected.revision}`)}</span></div><div className="button-row"><Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditor({ kind: "source", source: selected })}>{t("编辑连接", "Edit connection")}</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={() => void run({ kind: "update", sourceId: selected.id, revision: selected.revision, enabled: !selected.enabled })}>{selected.enabled ? t("停用新会话", "Disable new sessions") : t("启用", "Enable")}</Button><Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("删除模型源", "Delete model source")} onClick={() => setConfirmation({ title: t("删除模型源？", "Delete model source?"), description: t("仅可删除没有账号引用的模型源。存在历史绑定时请使用停用。", "Only unreferenced sources can be deleted. Disable sources that still have historical bindings."), action: { kind: "delete", sourceId: selected.id, revision: selected.revision } })}><DesktopIcon name="delete" /></Button></div></div>
        <div className="model-source-endpoints">{selected.endpoints.map(endpoint => <div key={endpoint.protocol}><span>{accountApiProtocolLabel(endpoint.protocol)}</span><code>{endpoint.baseUrl}</code></div>)}</div>
        <div className="model-source-subheading"><h4>{t("共享凭据", "Shared credentials")}</h4><Button variant="ghost" size="sm" disabled={disabled || selected.credentials.length >= 32} onClick={() => setEditor({ kind: "credential", source: selected })}><DesktopIcon name="add" />{t("添加凭据", "Add credential")}</Button></div>
        <div className="model-source-credentials">{selected.credentials.map(credential => <div key={credential.id}><span><DesktopIcon name="accounts" />{credential.name}<small>v{credential.revision}</small></span><Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditor({ kind: "credential", source: selected, credentialId: credential.id })}>{t("编辑 / 轮换", "Edit / rotate")}</Button><Button variant="ghost" size="icon-sm" aria-label={t(`移除凭据 ${credential.name}`, `Remove credential ${credential.name}`)} disabled={disabled || selected.routes.some(route => route.credentialId === credential.id)} onClick={() => setConfirmation({ title: t("移除此凭据？", "Remove this credential?"), description: t("旧会话的固定凭据版本仍会保留。", "Pinned credential versions for existing sessions are retained."), action: { kind: "credential.remove", sourceId: selected.id, revision: selected.revision, credentialId: credential.id } })}><DesktopIcon name="close" /></Button></div>)}</div>
        <div className="model-source-subheading"><h4>{t("模型与 Agent", "Models & agents")}</h4><Button size="sm" variant="outline" disabled={disabled || !selected.credentials.length || selected.routes.length >= 500} onClick={() => setEditor({ kind: "route", source: selected })}><DesktopIcon name="add" />{t("手动添加模型", "Add model manually")}</Button></div>
        <Input type="search" value={routeFilter} maxLength={200} aria-label={t("筛选已配置模型", "Filter configured models")} placeholder={t("搜索模型名称或 ID", "Search model name or ID")} onChange={event => setRouteFilter(event.target.value)} />
        <div className="model-source-routes">{routes.slice(0, routeLimit).map(route => <article key={route.id}><div><strong>{route.name}</strong><small>{route.model} · {accountApiEngineLabel(route.protocol)} · {selected.credentials.find(item => item.id === route.credentialId)?.name}{route.defaultEffort ? ` · ${route.defaultEffort}` : ""}</small></div><div className="button-row">{selected.defaultRouteId === route.id ? <small>{t("默认", "Default")}</small> : <Button variant="ghost" size="sm" disabled={disabled || !route.enabled} onClick={() => void run({ kind: "update", sourceId: selected.id, revision: selected.revision, defaultRouteId: route.id })}>{t("设为默认", "Set default")}</Button>}<Button size="sm" disabled={disabled || !selected.enabled || !route.enabled || route.modelCapabilities?.tools === false} onClick={() => onUse({ sourceId: selected.id, routeId: route.id, revision: selected.revision })}>{t("新建会话", "New session")}</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditor({ kind: "route", source: selected, route })}>{t("编辑", "Edit")}</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={() => void run({ kind: "routes.set", sourceId: selected.id, revision: selected.revision, routes: [{ ...route, enabled: !route.enabled }] })}>{route.enabled ? t("停用", "Disable") : t("启用", "Enable")}</Button><Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={t(`移除模型 ${route.name}`, `Remove model ${route.name}`)} onClick={() => setConfirmation({ title: t("移除模型路由？", "Remove model route?"), description: t("不删除旧会话及其固定版本。", "Existing sessions and their pinned versions are retained."), action: { kind: "route.remove", sourceId: selected.id, revision: selected.revision, routeId: route.id } })}><DesktopIcon name="close" /></Button></div></article>)}</div>
        {!routes.length && <p className="model-source-hint">{t("没有匹配模型，可以手动添加或从目录启用。", "No matching models. Add one manually or enable one from the catalog.")}</p>}
        {routes.length > routeLimit && <Button size="sm" variant="ghost" onClick={() => setRouteLimit(limit => limit + 50)}>{t("显示更多模型", "Show more models")}</Button>}
        <SourceCatalog key={selected.id} source={selected} disabled={disabled} onRun={run} />
        {boundAccounts.length > 0 && <details className="model-source-bindings"><summary>{t(`会话账号绑定（${boundAccounts.length}）`, `Session account bindings (${boundAccounts.length})`)}</summary><p className="model-source-hint">{t("账号 ID 与历史上下文保留。旧版本不会被连接编辑改写。", "Account IDs and history are retained. Connection edits do not rewrite pinned versions.")}</p>{boundAccounts.map(account => <div key={text(account.id)}><span>{text(account.name)}</span><small>v{String(record(account.modelSource).revision)} · {record(account.modelSource).current ? t("当前版本", "Current version") : t("历史版本", "Historical version")}</small></div>)}{legacyAccounts.length > 0 && <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirmation({ title: t("恢复独立 Profile？", "Restore independent profiles?"), description: t("恢复迁移前的账号绑定；保留模型源、原账号 ID 和会话。原始凭据被外部修改时会拒绝恢复。", "Restore pre-migration account bindings while retaining sources, IDs and sessions. Restore is rejected if original credentials changed externally."), action: { kind: "migration.rollback", accountIds: legacyAccounts.map(account => text(account.id)) } })}>{t("恢复独立 Profile", "Restore independent profiles")}</Button>}</details>}
      </div>
    </div>}
    {editor?.kind === "source" && <SourceConnectionDialog source={editor.source} onClose={closeEditor} />}
    {editor?.kind === "credential" && <SourceCredentialDialog source={editor.source} credentialId={editor.credentialId} onClose={closeEditor} />}
    {editor?.kind === "route" && <SourceRouteDialog source={editor.source} route={editor.route} onClose={closeEditor} />}
    {migration && <MigrationDialog groups={migration.groups} sources={state.sources} skipped={migration.skipped} busy={busy} error={error} onClose={() => setMigration(undefined)} onApply={(group, name, target) => void run({ kind: "migration.apply", migrationId: group.id, name, ...(target ? { target } : {}) })} />}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !busy) setConfirmation(undefined); }}><DialogContent showCloseButton={!busy} closeLabel={t("关闭", "Close")}><DialogHeader><DialogTitle>{confirmation?.title}</DialogTitle><DialogDescription>{confirmation?.description}</DialogDescription></DialogHeader>{error && <p className="model-source-error" role="alert">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(undefined)}>{t("取消", "Cancel")}</Button><Button disabled={busy} onClick={() => { if (confirmation) void run(confirmation.action).then(ok => { if (ok) setConfirmation(undefined); }); }}>{busy && <Spinner />}{t("确认", "Confirm")}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
