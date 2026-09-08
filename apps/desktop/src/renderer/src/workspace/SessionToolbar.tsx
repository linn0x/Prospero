import { useRef, useState } from "react";
import { DesktopIcon } from "../design-system/icons";
import type { JsonObject, SessionInfo } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useLocale } from "../locale";
import { reportError, shortPath } from "../state";

import { sessionLabel, StatusMark } from "./session-presentation";

export function SessionToolbar({ session, account, contextVisible, onToggleContext, onToggleFocus }: { session: SessionInfo; account: JsonObject | undefined; contextVisible: boolean; onToggleContext: () => void; onToggleFocus: () => void }) {
  const { t, status } = useLocale();
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
  return <>
    <header className="pane-toolbar session-toolbar">
      <div className="session-toolbar-identity" title={`${sessionLabel(session)} · ${session.cwd}`}><StatusMark status={session.status} /><strong>{sessionLabel(session)}</strong><span>{status(session.status)}</span><small>{shortPath(session.cwd)}</small></div>
      <div className="pane-toolbar-actions">

        <Button variant="ghost" size="icon-sm" aria-label={isMac ? t("在终端中打开", "Open in Terminal") : t("在 Windows Terminal 中打开", "Open in Windows Terminal")} title={isMac ? t("终端", "Terminal") : "Windows Terminal"} disabled={busy} onClick={() => void action(() => window.prospero.openWindowsTerminal(session.cwd), t("已打开终端", "Terminal opened"))}><DesktopIcon name="terminal" /></Button>
        <Button variant="ghost" size="icon-sm" disabled={busy || !["running", "starting", "waiting_input", "waiting_approval"].includes(session.status)} aria-label={t("停止当前轮次", "Stop current turn")} title={t("停止当前轮次", "Stop current turn")} onClick={() => void action(() => window.prospero.interruptSession(session.id))}><DesktopIcon name="stop" /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("切换工具栏", "Toggle tools")} title={t("任务、Diff、执行与终端", "Task, diff, execution and terminal")} aria-pressed={contextVisible} onClick={onToggleContext}><DesktopIcon name="sidebar" /></Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("会话操作", "Session actions")} />}><DesktopIcon name="more" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>
          <DropdownMenuItem onClick={onToggleFocus}><DesktopIcon name="expand" />{t("进入专注模式", "Enter focus mode")}</DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onClick={() => void action(() => window.prospero.revealPath(session.cwd))}><DesktopIcon name="folderOpen" />{isMac ? t("在访达中显示", "Reveal in Finder") : t("在资源管理器中打开", "Open in Explorer")}</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={busy || ["done", "completed", "exited", "cancelled"].includes(session.status)} onClick={() => void action(() => window.prospero.killSession(session.id))}><DesktopIcon name="close" />{t("结束会话", "End session")}</DropdownMenuItem>
        </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
      </div>
    </header>
    {error && <div className="workspace-action-error" role="alert"><span>{error}</span><Button size="xs" variant="ghost" onClick={() => setError(undefined)}>{t("关闭", "Dismiss")}</Button></div>}
    {notice && <span className="sr-only" role="status">{notice}</span>}
  </>;
}
