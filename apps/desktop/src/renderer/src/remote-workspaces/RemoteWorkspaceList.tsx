import { useRef, useState } from "react";
import type { RemoteWorkspace } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import { reportError } from "../state";

export function RemoteWorkspaceList({ workspaces, activeId, query, sort, onOpen, onUpdate, onForget }: {
  workspaces: RemoteWorkspace[];
  activeId: string | undefined;
  query: string;
  sort: "recent" | "name";
  onOpen: (workspace: RemoteWorkspace, newSession?: boolean) => void;
  onUpdate: (workspace: RemoteWorkspace) => void;
  onForget: (id: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState<RemoteWorkspace>();
  const [removing, setRemoving] = useState<RemoteWorkspace>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const [error, setError] = useState<string>();
  const [limit, setLimit] = useState(40);
  const value = query.trim().toLocaleLowerCase();
  const items = workspaces.filter(workspace => `${workspace.name}\n${workspace.hostName}\n${workspace.cwd}`.toLocaleLowerCase().includes(value)).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt));
  const action = async () => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (editing) { onUpdate(await window.prospero.renameRemoteWorkspace(editing.id, name.trim())); setEditing(undefined); }
      else if (removing) { await onForget(removing.id); setRemoving(undefined); }
    } catch (reason) { setError(reportError(reason)); }
    finally { mutation.current = false; setBusy(false); }
  };
  return <>
    {items.length > 0 && <SidebarMenuItem className="remote-workspace-list-label">{t("远程工作区", "Remote workspaces")}</SidebarMenuItem>}
    {items.slice(0, limit).map(workspace => <SidebarMenuItem key={workspace.id}>
      <ContextMenu><ContextMenuTrigger render={<div />}>
        <SidebarMenuButton className="remote-workspace-sidebar-button" isActive={activeId === workspace.id} tooltip={`${workspace.name} · ${workspace.hostName}`} title={`${workspace.hostName}\n${workspace.cwd}`} onClick={() => onOpen(workspace)}>
          <DesktopIcon name="server" /><span className="remote-workspace-sidebar-copy"><span>{workspace.name}</span><small>{workspace.hostName}</small></span>
        </SidebarMenuButton>
      </ContextMenuTrigger><ContextMenuContent>
        <ContextMenuItem onClick={() => onOpen(workspace)}><DesktopIcon name="folderOpen" />{t("打开远程工作区", "Open remote workspace")}</ContextMenuItem>
        <ContextMenuItem onClick={() => onOpen(workspace, true)}><DesktopIcon name="terminal" />{t("新建远程 Shell", "New remote Shell")}</ContextMenuItem>
        <ContextMenuItem onClick={() => { setEditing(workspace); setName(workspace.name); setError(undefined); }}>{t("重命名", "Rename")}</ContextMenuItem>
        <ContextMenuItem onClick={() => { setRemoving(workspace); setError(undefined); }}><DesktopIcon name="close" />{t("从列表移除", "Remove from list")}</ContextMenuItem>
      </ContextMenuContent></ContextMenu>
    </SidebarMenuItem>)}
    {items.length > limit && <SidebarMenuItem><SidebarMenuButton onClick={() => setLimit(current => current + 40)}>{t("显示更多远程工作区", "Show more remote workspaces")}</SidebarMenuButton></SidebarMenuItem>}
    <Dialog open={!!editing || !!removing} onOpenChange={open => { if (!open && !busy) { setEditing(undefined); setRemoving(undefined); } }}>
      <DialogContent showCloseButton={!busy} closeLabel={t("关闭", "Close")}><DialogHeader><DialogTitle>{editing ? t("重命名远程工作区", "Rename remote workspace") : t("移除远程工作区", "Remove remote workspace")}</DialogTitle><DialogDescription>{editing ? `${editing.hostName} · ${editing.cwd}` : t("仅移除本机列表中的入口，不会删除远程文件或结束会话。", "Only remove the shortcut from this computer. Remote files and sessions are not affected.")}</DialogDescription></DialogHeader>
        {editing && <Input value={name} onChange={event => setName(event.target.value)} maxLength={80} disabled={busy} aria-label={t("工作区名称", "Workspace name")} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && name.trim()) void action(); }} />}
        {error && <p role="alert" className="workspace-picker-error">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setEditing(undefined); setRemoving(undefined); }}>{t("取消", "Cancel")}</Button><Button disabled={busy || (!!editing && !name.trim())} onClick={() => void action()}>{editing ? t("保存", "Save") : t("移除入口", "Remove shortcut")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
