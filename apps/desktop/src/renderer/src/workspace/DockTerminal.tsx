import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { DesktopSnapshot, SessionInfo } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";
import { reportError } from "../state";
import { shellIsLive, workspaceShell } from "./shell-session";

const TerminalPane = lazy(() => import("../TerminalPane").then((module) => ({ default: module.TerminalPane })));

export function DockTerminal({ session, snapshot }: { session: SessionInfo; snapshot: DesktopSnapshot }) {
  const { t } = useLocale();
  const [shell, setShell] = useState<SessionInfo>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const sessions = useRef(snapshot.daemon.sessions);
  sessions.current = snapshot.daemon.sessions;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setShell(undefined);
    void workspaceShell(window.prospero, session.cwd, sessions.current).then((created) => { if (active) setShell(created); }).catch((reason) => { if (active) setError(reportError(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session.cwd, attempt]);
  const current = snapshot.daemon.sessions.find((item) => item.id === shell?.id) ?? shell;
  return <div className="dock-terminal">
    <div className="dock-terminal-toolbar"><span title={session.cwd}>{t("工作区 Shell", "Workspace shell")}</span><span>{t("关闭标签会保留终端", "Closing the tab keeps it running")}</span>{(error || current && !shellIsLive(current)) && <Button variant="ghost" size="icon-xs" disabled={loading} aria-label={t("重建终端", "Recreate terminal")} onClick={() => setAttempt((value) => value + 1)}><RefreshCw /></Button>}</div>
    {error && <div className="workspace-action-error" role="alert">{error}</div>}
    {loading ? <div className="dock-empty" role="status">{t("正在连接工作区终端…", "Connecting workspace terminal…")}</div> : current ? <Suspense fallback={<div className="dock-empty" role="status">{t("正在加载终端…", "Loading terminal…")}</div>}><TerminalPane key={current.id} session={current} fontFamily={snapshot.settings.terminalFontFamily} fontSize={snapshot.settings.terminalFontSize} /></Suspense> : null}
  </div>;
}
