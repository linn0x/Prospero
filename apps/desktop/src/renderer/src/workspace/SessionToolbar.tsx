import { writeTerminalMousePreference } from "./TerminalMouseToggle";
import { sessionTabName } from "./session-tab-labels";
import { useRef, useState } from "react";
import { Columns2, MousePointer2 } from "lucide-react";
import { DesktopIcon } from "../design-system/icons";
import type { JsonObject, NativeTerminalState, SessionInfo } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useLocale } from "../locale";
import { reportError, shortPath } from "../state";

import { sessionLabel, StatusMark } from "./session-presentation";

export function SessionToolbar({ session, account, unread = false, contextVisible, onToggleContext, onToggleFocus, localSelection, onLocalSelectionChange, nativeTerminal = false, nativeTerminalState, onNativeTerminalAction, onSplit }: { session: SessionInfo; account: JsonObject | undefined; unread?: boolean; contextVisible: boolean; onToggleContext: () => void; onToggleFocus: () => void; localSelection: boolean; onLocalSelectionChange: (value: boolean) => void; onSplit?: (() => void) | undefined; nativeTerminal?: boolean; nativeTerminalState?: NativeTerminalState; onNativeTerminalAction?: (action: "acquire" | "takeover" | "release" | "reconnect") => void }) {
  const { t } = useLocale();
  const label = sessionTabName(session);
  const project = session.cwd.split(/[\\/]/).filter(Boolean).at(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const pending = useRef(false);
  const isMac = window.prospero.platform === "darwin";
  const action = async (run: () => Promise<unknown>, success?: string): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await run();
      if (result && typeof result === "object" && "ok" in result && result.ok === false) throw new Error("error" in result && typeof result.error === "string" ? result.error : t("操作失败，请重试", "Action failed. Please retry."));
      setNotice(success);
    } catch (reason) { setError(reportError(reason)); } finally { pending.current = false; setBusy(false); }
  };
  const nativeConnected = Boolean(nativeTerminalState?.connected && !nativeTerminalState.syncing && !nativeTerminalState.exited);
  const nativeCanRelease = nativeConnected && Boolean(nativeTerminalState?.controller) && !nativeTerminalState?.readOnly;
  const nativeCanAcquire = nativeConnected && !nativeTerminalState?.controller;
  const nativeDisconnected = Boolean(nativeTerminal && nativeTerminalState && !nativeTerminalState.connected && !nativeTerminalState.syncing && !nativeTerminalState.exited);
  return <>
    <header className="pane-toolbar session-toolbar">
      <div className="session-toolbar-identity" title={`${sessionLabel(session)} · ${session.cwd}`}><StatusMark status={session.status} unread={unread} pendingPermissions={session.pendingPermissions} pendingQuestions={session.pendingQuestions} busySince={session.busySince} /><strong>{label === project ? shortPath(session.cwd) : label}</strong>{label !== project && <small>{shortPath(session.cwd)}</small>}</div>
      <div className="pane-toolbar-actions">
        {["running", "starting", "waiting_input", "waiting_approval"].includes(session.status) && <Button variant="ghost" size="sm" disabled={busy} aria-label={t("停止当前轮次", "Stop current turn")} onClick={() => void action(() => window.prospero.interruptSession(session.id))}><DesktopIcon name="stop" />{t("停止", "Stop")}</Button>}
        <Button variant="ghost" size="sm" aria-label={t("切换工具栏", "Toggle tools")} title={t("文件、搜索、Git 与会话工具", "Files, search, Git and session tools")} aria-pressed={contextVisible} onClick={onToggleContext}><DesktopIcon name="sidebar" />{t("工具", "Tools")}</Button>
        <Button variant="ghost" size="sm" aria-label={t("进入专注模式", "Enter focus mode")} onClick={onToggleFocus}><DesktopIcon name="expand" />{t("专注", "Focus")}</Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("会话操作", "Session actions")} />}><DesktopIcon name="more" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>
          {onSplit && <DropdownMenuItem onClick={onSplit}><Columns2 />{t("分屏查看会话", "Split sessions")}</DropdownMenuItem>}
          {session.kind === "pty" && !nativeTerminal && <DropdownMenuItem onClick={() => { writeTerminalMousePreference(!localSelection, undefined, session.id); onLocalSelectionChange(!localSelection); }}><MousePointer2 />{localSelection ? t("启用应用鼠标交互", "Enable application mouse interaction") : t("恢复本地选字", "Restore local text selection")}</DropdownMenuItem>}
          <DropdownMenuItem disabled={busy} onClick={() => void action(() => window.prospero.openWindowsTerminal(session.cwd), t("已打开终端", "Terminal opened"))}><DesktopIcon name="terminal" />{t("在外部终端打开", "Open in external terminal")}</DropdownMenuItem>
          {nativeCanRelease && <DropdownMenuItem onClick={() => onNativeTerminalAction?.("release")}><DesktopIcon name="terminal" />{t("释放终端控制", "Release terminal control")}</DropdownMenuItem>}
          {nativeCanAcquire && <>
            <DropdownMenuItem onClick={() => onNativeTerminalAction?.("acquire")}><DesktopIcon name="terminal" />{t("请求终端控制", "Request terminal control")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onNativeTerminalAction?.("takeover")}><DesktopIcon name="terminal" />{t("接管终端控制", "Take over terminal control")}</DropdownMenuItem>
          </>}
          {nativeDisconnected && <DropdownMenuItem onClick={() => onNativeTerminalAction?.("reconnect")}><DesktopIcon name="terminal" />{t("重新连接终端", "Reconnect terminal")}</DropdownMenuItem>}
          <DropdownMenuItem disabled={busy} onClick={() => void action(() => window.prospero.revealPath(session.cwd))}><DesktopIcon name="folderOpen" />{isMac ? t("在访达中显示", "Reveal in Finder") : t("在资源管理器中打开", "Open in Explorer")}</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={busy || ["done", "completed", "exited", "cancelled"].includes(session.status)} onClick={() => void action(() => window.prospero.killSession(session.id))}><DesktopIcon name="close" />{t("结束会话", "End session")}</DropdownMenuItem>
        </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
      </div>
    </header>
    {error && <div className="workspace-action-error" role="alert"><span>{error}</span><Button size="xs" variant="ghost" onClick={() => setError(undefined)}>{t("关闭", "Dismiss")}</Button></div>}
    {notice && <span className="sr-only" role="status">{notice}</span>}
  </>;
}
