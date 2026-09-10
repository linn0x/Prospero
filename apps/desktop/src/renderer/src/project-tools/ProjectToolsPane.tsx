import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, FilePlus2, FolderOpen, FolderPlus, PanelRight, RefreshCw } from "lucide-react";
import type { ProjectTool } from "../../../shared/project-tools";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { reportError } from "../state";
import { FileExplorer, type ExplorerAction } from "./FileExplorer";
import { FilePreview } from "./FilePreview";
import { ProjectFileTabs } from "./ProjectFileTabs";
import type { DocumentTabs } from "../components/TabStrip";
import { GitPanel } from "./GitPanel";
import { SearchPanel } from "./SearchPanel";
import { fileName, getProjectFileRequest, parentPath, subscribeProjectFileRequests, tabId, type PreviewTab } from "./tool-state";

export function ProjectToolsPane({ root, mode, active, tabsHost, onActivate, onDocumentTabs }: { root: string; mode: ProjectTool; active: boolean; tabsHost?: HTMLDivElement | null | undefined; onActivate?: (() => void) | undefined; onDocumentTabs?: ((tabs: DocumentTabs | undefined) => void) | undefined }) {
  const { t } = useLocale();
  const prefix = useId();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [explorerVisible, setExplorerVisible] = useState(true);
  useEffect(() => { setPreviewOpen(false); }, [mode]);
  const [tabs, setTabs] = useState<PreviewTab[]>([]);
  const [selected, setSelected] = useState("");
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<ExplorerAction>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [confirmation, setConfirmation] = useState<(() => void)>();
  const pending = useRef(false);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const refresh = useCallback(() => { setRevision(value => value + 1); }, []);
  const onDirty = useCallback((id: string, changed: boolean) => setDirty(current => { const next = new Set(current); changed ? next.add(id) : next.delete(id); return next.size === current.size && next.has(id) === current.has(id) ? current : next; }), []);
  const guard = (proceed: () => void, needed = dirtyRef.current.size > 0): void => { if (needed) setConfirmation(() => proceed); else proceed(); };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current.size) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  useEffect(() => {
    if (!active) return;
    refresh();
    const focus = () => refresh();
    window.addEventListener("focus", focus); return () => window.removeEventListener("focus", focus);
  }, [active, refresh]);
  const open = (path: string, kind: "file" | "diff" = "file", staged = false, line = 0): void => {
    const id = tabId(path, kind, staged);
    setTabs(current => current.some(tab => tab.id === id) ? current.map(tab => tab.id === id ? { ...tab, line } : tab) : [...current, { id, path, kind, staged, line }]); setSelected(id); setPreviewOpen(true);
  };
  const fileRequest = useSyncExternalStore(subscribeProjectFileRequests, () => getProjectFileRequest(root));
  useEffect(() => {
    if (fileRequest) open(fileRequest.path, "file", false, fileRequest.line);
  }, [fileRequest]);
  const close = (id: string): void => guard(() => {
    const index = tabs.findIndex(tab => tab.id === id), next = tabs.filter(tab => tab.id !== id);
    setTabs(next); if (!next.length) setPreviewOpen(false); if (selected === id) setSelected(next[Math.max(0, index - 1)]?.id ?? "");
    setDirty(current => { const next = new Set(current); next.delete(id); return next; });
  }, dirty.has(id));
  const startAction = (next: ExplorerAction): void => {
    const affected = tabs.some(tab => (tab.path === next.path || tab.path.startsWith(`${next.path}/`)) && dirty.has(tab.id));
    guard(() => { setAction(next); setName(next.kind === "rename" ? fileName(next.path) : ""); setActionError(undefined); }, affected && (next.kind === "rename" || next.kind === "trash"));
  };
  const mutate = async (): Promise<void> => {
    if (!action || pending.current) return;
    pending.current = true; setBusy(true); setActionError(undefined);
    try {
      if (action.kind !== "trash" && (!name.trim() || /[\\/]/.test(name) || [".", "..", ".git"].includes(name.toLowerCase()))) throw new Error(t("请输入有效的文件或文件夹名称", "Enter a valid file or folder name"));
      const target = [action.kind === "rename" ? parentPath(action.path) : action.path, name.trim()].filter(Boolean).join("/");
      await window.prospero.mutateProjectFile(root, action.kind === "rename" ? { kind: "rename", path: action.path, destination: target } : { kind: action.kind, path: action.kind === "trash" ? action.path : target });
      if (action.kind === "rename" || action.kind === "trash") {
        const removed = new Set(tabs.filter(tab => tab.path === action.path || tab.path.startsWith(`${action.path}/`)).map(tab => tab.id));
        setTabs(current => current.filter(tab => !removed.has(tab.id))); setDirty(current => new Set([...current].filter(id => !removed.has(id))));
        if (removed.has(selected)) setSelected(tabs.find(tab => !removed.has(tab.id))?.id ?? "");
      }
      if (action.kind === "create-file") open(target);
      setAction(undefined); refresh();
    } catch (reason) { setActionError(reportError(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const current = tabs.find(tab => tab.id === selected);
  const selectTab = (id: string) => { setSelected(id); setPreviewOpen(true); onActivate?.(); };
  const tabActions = useRef({ select: selectTab, close }); tabActions.current = { select: selectTab, close };
  useLayoutEffect(() => {
    onDocumentTabs?.({ items: tabs.map(tab => ({ id: `document:${tab.id}`, label: tab.path + (tab.kind === "diff" ? " · Diff" : ""), onSelect: () => tabActions.current.select(tab.id), onClose: () => tabActions.current.close(tab.id) })), activeId: active && previewOpen && selected ? `document:${selected}` : undefined });
    return () => onDocumentTabs?.(undefined);
  }, [tabs, selected, active, previewOpen, onDocumentTabs]);
  const fileTabs = tabs.length > 0 ? <ProjectFileTabs tabs={tabs} selected={selected} active={active && previewOpen} dirty={dirty} prefix={prefix} onSelect={selectTab} onClose={close} onReorder={ids => setTabs(current => ids.map(id => current.find(tab => tab.id === id)!).filter(Boolean))} embedded={Boolean(tabsHost)} /> : null;
  const title = mode === "files" ? t("文件管理", "Files") : mode === "search" ? t("全局搜索", "Search") : t("源代码管理", "Source control");
  return <div className="project-tools-shell">
    {tabsHost && createPortal(fileTabs, tabsHost)}
    {error && <Alert variant="destructive" className="m-3 w-auto"><AlertDescription>{error}</AlertDescription><Button size="xs" variant="ghost" onClick={() => setError(undefined)}>{t("关闭", "Dismiss")}</Button></Alert>}
    <div className={cn("project-tools-body", previewOpen && tabs.length > 0 && "has-preview", !explorerVisible && "is-explorer-hidden")}>
      <aside className="project-tools-panel" aria-label={title}>
        <div className="project-panel-heading"><strong title={root}><FolderOpen />{fileName(root)}</strong><div>{tabs.length > 0 && <Button className="project-open-files" variant="ghost" size="xs" onClick={() => setPreviewOpen(true)}>{t(`打开的文件 (${tabs.length})`, `Open files (${tabs.length})`)}</Button>}{mode === "files" && <><Button variant="ghost" size="icon-xs" aria-label={t("新建文件", "New file")} title={t("新建文件", "New file")} onClick={() => startAction({ kind: "create-file", path: "" })}><FilePlus2 /></Button><Button variant="ghost" size="icon-xs" aria-label={t("新建文件夹", "New folder")} title={t("新建文件夹", "New folder")} onClick={() => startAction({ kind: "create-directory", path: "" })}><FolderPlus /></Button></>}<Button variant="ghost" size="icon-xs" aria-label={t("刷新项目", "Refresh project")} title={t("刷新项目", "Refresh project")} onClick={refresh}><RefreshCw /></Button></div></div>
        <div className="project-tool-tabpanel" hidden={mode !== "files"}><FileExplorer key={root} root={root} revision={revision} selected={current?.path} onOpen={path => open(path)} onAction={startAction} onError={setError} /></div>
        <div className="project-tool-tabpanel" hidden={mode !== "search"}><SearchPanel key={root} root={root} revision={revision} active={active && mode === "search" && !previewOpen} onOpen={(path, line) => open(path, "file", false, line)} /></div>
        <div className="project-tool-tabpanel" hidden={mode !== "git"}><GitPanel key={root} root={root} revision={revision} active={active && mode === "git"} onOpen={(path, staged) => open(path, "diff", staged)} onRefresh={refresh} /></div>
      </aside>
      <section className="project-preview-area" aria-label={t("文件预览", "File preview")} hidden={!previewOpen || !tabs.length}>
        <div className="project-preview-navigation"><Button variant="ghost" size="sm" onClick={() => { setPreviewOpen(false); setExplorerVisible(true); }}><ArrowLeft data-icon="inline-start" />{mode === "files" ? t("返回文件", "Back to files") : mode === "search" ? t("返回搜索结果", "Back to results") : t("返回变更", "Back to changes")}</Button><span title={root}>{fileName(root)}</span></div>
        {tabs.length ? <>{!tabsHost && fileTabs}{tabs.map((tab, index) => <div className="project-preview-tabpanel" key={`${root}:${tab.id}`} id={`${prefix}-file-panel-${index}`} role="tabpanel" aria-labelledby={`${prefix}-file-tab-${index}`} hidden={selected !== tab.id}><FilePreview root={root} tab={tab} active={active && previewOpen && selected === tab.id} explorerToggle={<Button className="project-explorer-toggle" variant="ghost" size="icon-xs" aria-label={t("切换文件树", "Toggle file tree")} title={t("切换文件树", "Toggle file tree")} aria-pressed={explorerVisible} onClick={() => setExplorerVisible(value => !value)}><PanelRight data-icon="inline-start" /></Button>} revision={revision} onDirty={onDirty} onRefresh={refresh} /></div>)}</> : null}
      </section>
    </div>
    <Dialog open={Boolean(action)} onOpenChange={value => { if (!value && !busy) setAction(undefined); }}><DialogContent><form onSubmit={event => { event.preventDefault(); void mutate(); }}><DialogHeader><DialogTitle>{action?.kind === "trash" ? t("移入回收站", "Move to trash") : action?.kind === "rename" ? t("重命名", "Rename") : action?.kind === "create-directory" ? t("新建文件夹", "New folder") : t("新建文件", "New file")}</DialogTitle><DialogDescription>{action?.kind === "trash" ? t(`将“${action.path}”及其内容移入系统回收站。`, `Move “${action.path}” and its contents to the system trash.`) : action?.path || fileName(root)}</DialogDescription></DialogHeader>{action?.kind !== "trash" && <FieldGroup className="my-4"><Field><FieldLabel htmlFor={`${prefix}-file-name`}>{t("名称", "Name")}</FieldLabel><Input autoFocus id={`${prefix}-file-name`} data-slot="project-file-name" value={name} maxLength={255} disabled={busy} onChange={event => setName(event.target.value)} /></Field></FieldGroup>}{actionError && <p className="project-tree-message" role="alert">{actionError}</p>}<DialogFooter className="mt-4"><Button variant="outline" type="button" disabled={busy} onClick={() => setAction(undefined)}>{t("取消", "Cancel")}</Button><Button variant={action?.kind === "trash" ? "destructive" : "default"} type="submit" disabled={busy || action?.kind !== "trash" && !name.trim()}>{busy ? t("处理中…", "Working…") : t("确认", "Confirm")}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={Boolean(confirmation)} onOpenChange={value => { if (!value) setConfirmation(undefined); }}><DialogContent><DialogHeader><DialogTitle>{t("有尚未保存的修改", "Unsaved changes")}</DialogTitle><DialogDescription>{t("继续会丢弃相关文件的未保存修改。你也可以取消，先保存文件。", "Continuing discards unsaved edits to the affected files. Cancel to save them first.")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirmation(undefined)}>{t("取消", "Cancel")}</Button><Button variant="destructive" onClick={() => { const proceed = confirmation; setConfirmation(undefined); proceed?.(); }}>{t("丢弃并继续", "Discard and continue")}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
