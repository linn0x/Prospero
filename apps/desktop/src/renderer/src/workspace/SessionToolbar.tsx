import { writeTerminalMousePreference } from "./TerminalMouseToggle";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Columns2, MousePointer2, RotateCcw } from "lucide-react";
import { DesktopIcon } from "../design-system/icons";
import type { JsonObject, NativeTerminalState, SessionInfo } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useLocale } from "../locale";
import { reportError, shortPath } from "../state";

import { ApiModelSourceSwitcher } from "./ApiModelSourceSwitcher";
import { modelSourceSwitchSupported } from "./model-catalog";
import { sessionLabel, StatusMark } from "./session-presentation";

export function SessionToolbar({ session, account, unread = false, contextVisible, onToggleContext, onToggleFocus, localSelection, onLocalSelectionChange, nativeTerminal = false, nativeTerminalState, onNativeTerminalAction, onSplit, variant, actionsHost }: { session: SessionInfo; account: JsonObject | undefined; unread?: boolean; contextVisible: boolean; onToggleContext: () => void; onToggleFocus: () => void; localSelection: boolean; onLocalSelectionChange: (value: boolean) => void; onSplit?: (() => void) | undefined; nativeTerminal?: boolean; nativeTerminalState?: NativeTerminalState; onNativeTerminalAction?: (action: "acquire" | "takeover" | "release" | "reconnect") => void; variant?: "pane" | "topbar"; actionsHost?: HTMLDivElement | null | undefined }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const pending = useRef(false);
  const isMac = window.prospero.platform === "darwin";
  const mode = variant ?? (actionsHost ? "topbar" : "pane");
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
  const kindBadge = session.kind === "pty" ? (session.agent === "shell" ? "Shell" : "TUI") : "Chat";
  const rawModel = session.agentControls?.currentModel || session.model;
  const modelName = rawModel ? rawModel.split("/").at(-1) : undefined;
  const showPtySourceSwitcher = session.kind === "pty" && modelSourceSwitchSupported(session, account);
  const focusTitle = isMac ? t("进入专注模式 (⌥⌘F)", "Enter focus mode (⌥⌘F)") : t("进入专注模式 (Ctrl+Alt+F)", "Enter focus mode (Ctrl+Alt+F)");
  const actions = (
    <div className="pane-toolbar-actions">
      {showPtySourceSwitcher && <ApiModelSourceSwitcher key={session.id} session={session} account={account} triggerSize="xs" />}
      {["running", "starting", "waiting_input", "waiting_approval"].includes(session.status) && <Button variant="ghost" size="xs" disabled={busy} aria-label={t("停止当前轮次", "Stop current turn")} title={t("停止当前轮次", "Stop current turn")} onClick={() => void action(() => window.prospero.interruptSession(session.id))}><DesktopIcon name="stop" /><span className="session-toolbar-action-label">{t("停止", "Stop")}</span></Button>}
      {(session.archived || (session.kind === "pty" && ["completed", "done", "died", "failed", "stopped", "cancelled", "exited", "killed"].includes(session.status))) && <Button variant="ghost" size="xs" disabled={busy} aria-label={t("继续对话", "Resume chat")} title={t("继续对话", "Resume chat")} onClick={() => void action(() => window.prospero.setSessionArchived(session.id, false))}><RotateCcw /><span className="session-toolbar-action-label">{t("继续对话", "Resume")}</span></Button>}
      <Button variant="ghost" size="xs" aria-label={t("切换工具栏", "Toggle tools")} title={t("文件、搜索、Git 与会话工具", "Files, search, Git and session tools")} aria-pressed={contextVisible} onClick={onToggleContext}><DesktopIcon name="sidebar" /><span className="session-toolbar-action-label">{t("工具", "Tools")}</span></Button>
      <Button variant="ghost" size="xs" aria-label={t("进入专注模式", "Enter focus mode")} title={focusTitle} onClick={onToggleFocus}><DesktopIcon name="expand" /><span className="session-toolbar-action-label">{t("专注", "Focus")}</span></Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t("会话操作", "Session actions")} title={t("更多会话操作", "More session actions")} />}><DesktopIcon name="more" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>
        {mode === "topbar" && <DropdownMenuLabel className="session-toolbar-menu-meta" title={`${sessionLabel(session)} · ${session.cwd}`}>{shortPath(session.cwd)} · {session.agent} · {kindBadge}{modelName ? ` · ${modelName}` : ""}</DropdownMenuLabel>}
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
        <DropdownMenuItem disabled={busy} onClick={() => void action(() => window.prospero.setSessionArchived(session.id, !session.archived))}><RotateCcw />{session.archived ? t("恢复会话", "Resume session") : t("归档会话", "Archive session")}</DropdownMenuItem>
      </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
    </div>
  );
  if (mode === "topbar") {
    const topbarBar = <div className="session-toolbar is-topbar">{actions}</div>;
    return <>
      {actionsHost ? createPortal(topbarBar, actionsHost) : topbarBar}
      {error && <div className="workspace-action-error" role="alert"><span>{error}</span><Button size="xs" variant="ghost" onClick={() => setError(undefined)}>{t("关闭", "Dismiss")}</Button></div>}
      {notice && <span className="sr-only" role="status">{notice}</span>}
    </>;
  }
  return <>
    <header className="pane-toolbar session-toolbar">
      <div className="session-toolbar-identity" title={`${sessionLabel(session)} · ${session.cwd}`}>
        <StatusMark status={session.status} unread={unread} pendingPermissions={session.pendingPermissions} pendingQuestions={session.pendingQuestions} busySince={session.busySince} />
        <span className="session-toolbar-path">{shortPath(session.cwd)}</span>
        <span className="session-toolbar-sep" aria-hidden="true">·</span>
        <span className="session-toolbar-chip">{session.agent} · {kindBadge}</span>
        {session.kind === "pty" && !showPtySourceSwitcher && modelName && <>
          <span className="session-toolbar-sep" aria-hidden="true">·</span>
          <span className="session-toolbar-chip session-toolbar-model" title={rawModel}>{modelName}</span>
        </>}
      </div>
      {actions}
    </header>
    {error && <div className="workspace-action-error" role="alert"><span>{error}</span><Button size="xs" variant="ghost" onClick={() => setError(undefined)}>{t("关闭", "Dismiss")}</Button></div>}
    {notice && <span className="sr-only" role="status">{notice}</span>}
  </>;
}
