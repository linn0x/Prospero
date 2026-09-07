import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteDirectoryListing, RemoteDirectoryRoot, RemoteHostSummary, RemoteWorkspace } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { Spinner } from "../components/ui/spinner";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import { displayError } from "../state";
import { remoteChildLocation, remoteParentLocation } from "./workspace-location";
import "./workspace-picker.css";

export function AddWorkspaceDialog({ onClose, onLocalAdded, onRemoteAdded, onManageHosts }: {
  onClose: () => void;
  onLocalAdded: (cwd: string) => void;
  onRemoteAdded: (workspace: RemoteWorkspace) => void;
  onManageHosts: () => void;
}) {
  const { t } = useLocale();
  const [location, setLocation] = useState("local");
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [hostId, setHostId] = useState("");
  const [listing, setListing] = useState<RemoteDirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [hostsLoading, setHostsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [hostsError, setHostsError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const generation = useRef(0);
  const hostGeneration = useRef(0);
  const mutation = useRef(false);
  const mounted = useRef(false);
  const refreshHosts = useCallback(async () => {
    const token = ++hostGeneration.current;
    setHostsLoading(true);
    setHostsError(undefined);
    try {
      const next = await window.prospero.listRemoteHosts();
      if (token !== hostGeneration.current) return;
      setHosts(next);
      setHostId(current => next.some(host => host.id === current) ? current : next[0]?.id ?? "");
    } catch (reason) {
      if (token === hostGeneration.current) setHostsError(displayError(reason));
    } finally {
      if (token === hostGeneration.current) setHostsLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refreshHosts();
    return () => { mounted.current = false; generation.current++; hostGeneration.current++; };
  }, [refreshHosts]);
  const load = useCallback(async (path = "", root: RemoteDirectoryRoot = "home") => {
    if (!hostId) return;
    const token = ++generation.current;
    setLoading(true);
    setError(undefined);
    setListing(undefined);
    setQuery("");
    try {
      const result = await window.prospero.listRemoteDirectories({ hostId, path, root });
      if (result.hostId !== hostId || result.path !== path || result.root !== root) throw new Error("远程目录响应不匹配，请重试 / Remote directory response does not match the selection");
      if (token === generation.current) setListing(result);
    } catch (reason) {
      if (token === generation.current) setError(displayError(reason));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [hostId]);
  useEffect(() => {
    setListing(undefined);
    setError(undefined);
    setLoading(false);
    if (location === "remote") void load();
    return () => { generation.current++; };
  }, [load, location]);
  const choose = async () => {
    if (mutation.current || (location === "remote" && (!listing?.cwd || listing.hostId !== hostId || loading || error))) return;
    mutation.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (location === "local") {
        const cwd = await window.prospero.chooseProject();
        if (cwd && mounted.current) { onLocalAdded(cwd); onClose(); }
      } else if (listing) {
        const workspace = await window.prospero.addRemoteWorkspace({ hostId: listing.hostId, path: listing.path, root: listing.root });
        if (mounted.current) { onRemoteAdded(workspace); onClose(); }
      }
    } catch (reason) {
      if (mounted.current) setError(displayError(reason));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const parent = listing && remoteParentLocation(listing);
  const directories = listing?.entries.filter(entry => entry.kind === "dir" && entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <Dialog open onOpenChange={open => { if (!open && !mutation.current) onClose(); }}>
    <DialogContent className="workspace-picker-dialog" showCloseButton={!busy} closeLabel={t("关闭", "Close")}>
      <DialogHeader><DialogTitle>{t("添加工作区", "Add workspace")}</DialogTitle><DialogDescription>{t("选择本机或远程电脑上的文件夹。会话会在对应电脑上运行。", "Choose a folder on this computer or a remote computer. Sessions run on the selected computer.")}</DialogDescription></DialogHeader>
      <div className="workspace-location-toggle" role="radiogroup" aria-label={t("工作区位置", "Workspace location")} onKeyDown={event => {
        if (busy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "local" : event.key === "End" ? "remote" : location === "local" ? "remote" : "local";
        setLocation(next);
        (event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next === "local" ? 0 : 1])?.focus();
      }}>
        {[["local", t("本机（默认）", "This computer (default)")], ["remote", t("远程电脑", "Remote computer")]].map(([value, label]) => <Button key={value} variant={location === value ? "secondary" : "ghost"} role="radio" aria-checked={location === value} tabIndex={location === value ? 0 : -1} disabled={busy} onClick={() => setLocation(value!)}><DesktopIcon name={value === "local" ? "folder" : "server"} />{label}</Button>)}
      </div>
      {location === "local" ? <div className="workspace-local-description"><DesktopIcon name="folderOpen" /><p>{t("使用本机文件夹和本机 Agent 环境。", "Use a local folder and this computer’s agent environment.")}</p></div> : <div className="workspace-remote-picker">
        <label htmlFor="workspace-remote-host">{t("已配对电脑", "Paired computer")}</label>
        <div className="workspace-location-row"><NativeSelect id="workspace-remote-host" value={hostId} disabled={busy || hostsLoading} onChange={event => setHostId(event.target.value)}>
          {!hosts.length && <NativeSelectOption value="">{hostsLoading ? t("读取中…", "Loading…") : t("没有已配对电脑", "No paired computers")}</NativeSelectOption>}
          {hosts.map(host => <NativeSelectOption key={host.id} value={host.id}>{host.name}</NativeSelectOption>)}
        </NativeSelect><Button variant="ghost" size="icon-sm" disabled={busy || hostsLoading} aria-label={t("刷新远程电脑", "Refresh remote computers")} onClick={() => void refreshHosts()}><DesktopIcon name="refresh" /></Button></div>
        {hostsError && <p role="alert" className="workspace-picker-error">{hostsError}</p>}
        {!hostsLoading && !hosts.length && <Button variant="outline" disabled={busy} onClick={() => { onClose(); onManageHosts(); }}><DesktopIcon name="add" />{t("配对远程电脑", "Pair a remote computer")}</Button>}
        {hostId && <>
          <div className="workspace-location-row"><Button variant="ghost" size="sm" disabled={busy || !parent || loading} onClick={() => { if (parent) void load(parent.path, parent.root); }}>{t("上一级", "Up")}</Button><Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void load()}>{t("用户目录", "Home")}</Button>{listing?.supportsRoots && <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void load("", "computer")}>{t("此电脑", "Computer")}</Button>}</div>
          <div className="workspace-location-path" title={listing?.cwd}>{loading ? t("正在读取远程文件夹…", "Reading remote folders…") : listing?.cwd || (listing?.root === "computer" ? t("此电脑", "Computer") : "—")}</div>
          <Input type="search" value={query} onChange={event => setQuery(event.target.value)} disabled={!listing || busy} maxLength={200} aria-label={t("筛选文件夹", "Filter folders")} placeholder={t("筛选当前目录的文件夹", "Filter folders in this directory")} />
          <div className="workspace-directory-list" aria-label={t("远程文件夹", "Remote folders")} aria-busy={loading}>
            {loading ? <span role="status"><Spinner />{t("读取中…", "Loading…")}</span> : directories.slice(0, 200).map(entry => <Button key={entry.name} variant="ghost" disabled={busy} onClick={() => { if (!listing) return; const next = remoteChildLocation(listing, entry.name); if (next) void load(next.path, next.root); }}><DesktopIcon name="folder" /><span>{entry.name}</span><DesktopIcon name="arrowRight" /></Button>)}
            {listing && !directories.length && <p>{t("没有匹配的子文件夹，可以选择当前目录。", "No matching subfolders. You can select the current folder.")}</p>}
            {directories.length > 200 && <p>{t(`显示前 200 个，共 ${directories.length} 个；输入名称可筛选。`, `Showing 200 of ${directories.length} folders; type a name to filter.`)}</p>}
          </div>
          <p className="workspace-picker-hint">{t("远程文件不会挂载或复制到本机。可浏览范围由远端服务的目录权限决定。", "Remote files are not mounted or copied locally. Folder access follows the remote service’s permissions.")}</p>
        </>}
      </div>}
      {error && <div role="alert" className="workspace-picker-error">{error}{location === "remote" && <Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void load()}>{t("重试", "Retry")}</Button>}</div>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{t("取消", "Cancel")}</Button><Button disabled={busy || (location === "remote" && (loading || !listing?.cwd || listing.hostId !== hostId || !!error))} onClick={() => void choose()}>{busy && <Spinner />}{location === "local" ? t("选择本机文件夹", "Choose local folder") : t("添加当前远程文件夹", "Add current remote folder")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
