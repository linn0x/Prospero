import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Copy, FilePlus2, Folder, FolderOpen, FolderPlus, Pencil, Search, Trash2, X } from "lucide-react";
import type { ProjectFile } from "../../../shared/project-tools";
import { Button } from "../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "../components/ui/context-menu";
import { Spinner } from "../components/ui/spinner";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { reportError } from "../state";
import { ProjectFileIcon } from "./ProjectFileIcon";

export type ExplorerAction = { kind: "create-file" | "create-directory" | "rename" | "trash"; path: string };
type Props = { root: string; revision: number; selected: string | undefined; onOpen: (path: string) => void; onAction: (action: ExplorerAction) => void; onError: (error: string) => void; filter?: string };

function Directory({ root, path = "", depth = 0, ...props }: Props & { path?: string; depth?: number }) {
  const { t } = useLocale();
  const [entries, setEntries] = useState<ProjectFile[]>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void window.prospero.listProjectFiles(root, path).then(entries => { if (active) setEntries(entries); }).catch(reason => { if (active) setError(reportError(reason)); });
    return () => { active = false; };
  }, [root, path, props.revision, retry]);
  if (error) return <div className="project-tree-message" role="alert"><p>{error}</p><Button variant="ghost" size="xs" onClick={() => setRetry(value => value + 1)}>{t("重试", "Retry")}</Button></div>;
  if (!entries) return <div className="project-tree-message" role="status"><Spinner />{t("正在读取…", "Loading…")}</div>;
  return <ul className="project-tree-list">
    {entries.map(entry => <Entry key={entry.name} {...props} root={root} entry={entry} path={path ? `${path}/${entry.name}` : entry.name} depth={depth} />)}
    {!entries.length && <li className="project-tree-message">{t("空文件夹", "Empty folder")}</li>}
    {entries.length >= 2000 && <li className="project-tree-message">{t("仅显示前 2,000 项", "Showing the first 2,000 entries")}</li>}
  </ul>;
}

function Entry({ entry, path, depth, ...props }: Props & { entry: ProjectFile; path: string; depth: number }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const directory = entry.kind === "dir";
  const Icon = expanded ? FolderOpen : Folder;
  const matches = !props.filter || path.toLocaleLowerCase().includes(props.filter.toLocaleLowerCase());
  return <li hidden={!directory && !matches}>
    <ContextMenu>
      <ContextMenuTrigger render={<button type="button" />} className={cn("project-tree-row", props.selected === path && "is-selected")} style={{ paddingLeft: 10 + depth * 14 }} aria-expanded={directory ? expanded : undefined} aria-current={!directory && props.selected === path ? "true" : undefined} title={path} onClick={() => directory ? setExpanded(value => !value) : props.onOpen(path)} onKeyDown={event => { if (directory && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setExpanded(event.key === "ArrowRight"); } }}>
        {directory ? expanded ? <ChevronDown /> : <ChevronRight /> : <span className="project-tree-indent" />}{directory ? <Icon /> : <ProjectFileIcon path={path} />}<span className="truncate">{entry.name}</span>{entry.kind === "symlink" && <span aria-label={t("符号链接", "Symbolic link")}>↗</span>}
      </ContextMenuTrigger>
      <ContextMenuContent><ContextMenuGroup>
        {directory && <><ContextMenuItem onClick={() => { setExpanded(true); props.onAction({ kind: "create-file", path }); }}><FilePlus2 />{t("新建文件", "New file")}</ContextMenuItem><ContextMenuItem onClick={() => { setExpanded(true); props.onAction({ kind: "create-directory", path }); }}><FolderPlus />{t("新建文件夹", "New folder")}</ContextMenuItem></>}
        <ContextMenuItem onClick={() => void window.prospero.writeClipboard(path).catch(reason => props.onError(reportError(reason)))}><Copy />{t("复制相对路径", "Copy relative path")}</ContextMenuItem>
        <ContextMenuItem disabled={entry.kind === "symlink"} onClick={() => props.onAction({ kind: "rename", path })}><Pencil />{t("重命名", "Rename")}</ContextMenuItem>
        <ContextMenuItem disabled={entry.kind === "symlink"} variant="destructive" onClick={() => props.onAction({ kind: "trash", path })}><Trash2 />{t("移入回收站", "Move to trash")}</ContextMenuItem>
      </ContextMenuGroup></ContextMenuContent>
    </ContextMenu>
    {directory && expanded && <Directory {...props} path={path} depth={depth + 1} />}
  </li>;
}

export function FileExplorer(props: Props) {
  const { t } = useLocale();
  const [filter, setFilter] = useState("");
  return <>
    <div className="project-file-filter"><Search /><input data-slot="project-file-filter" aria-label={t("筛选文件名，文件夹可继续展开", "Filter file names; expand folders to browse matches")} placeholder={t("筛选文件…", "Filter files…")} value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setFilter(""); } }} />{filter && <Button variant="ghost" size="icon-xs" aria-label={t("清除文件筛选", "Clear file filter")} onClick={() => setFilter("")}><X /></Button>}</div>
    <div className="project-panel-scroll" onKeyDown={event => {
      if (!(event.target as HTMLElement).closest(".project-tree-row") || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".project-tree-row")].filter(row => row.getClientRects().length);
      const index = rows.indexOf(event.target as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      event.preventDefault(); rows[next]?.focus();
    }}><Directory {...props} filter={filter.trim()} /></div>
  </>;
}
