import { useEffect, useRef, useState } from "react";
import type { DesktopSettings, RemoteWorkspace, SessionInfo } from "../../../shared/types";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import { displayError, record, text } from "../state";
import { RemoteTerminal } from "./RemoteTerminal";
import { RemoteWorkspaceOpenQueue, chooseRemoteShell, rememberRemoteShell, rememberedRemoteShell, remoteShellEnded, remoteWorkspaceShells } from "./remote-workspace-state";
import "./remote-workspaces.css";

const openingWorkspaces = new RemoteWorkspaceOpenQueue();

export function RemoteWorkspacePane({ workspace, settings, focus, onToggleFocus, newSessionRequest = 0 }: {
  workspace: RemoteWorkspace; settings: DesktopSettings; focus: boolean; onToggleFocus: () => void; newSessionRequest?: number;
}) {
  const { t } = useLocale();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sid, setSid] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<"open" | "new" | "refresh">();
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("");
  const [resolved, setResolved] = useState<RemoteWorkspace>();
  const current = useRef(workspace);
  const selected = useRef(sid);
  const generation = useRef(0);
  const pending = useRef(false);
  const consumedRequest = useRef(newSessionRequest);
  current.current = workspace;
  selected.current = sid;
  const active = resolved?.id === workspace.id ? resolved : workspace;
  const supported = typeof window.prospero.openRemoteWorkspace === "function" && typeof window.prospero.listRemoteWorkspaceShells === "function";
  const select = (id: string) => { selected.current = id; setSid(id); rememberRemoteShell(workspace.id, id); };
  const refresh = async () => {
    if (pending.current || !supported) return;
    pending.current = true; setBusy("refresh"); setError("");
    const token = generation.current;
    const id = workspace.id;
    try {
      const available = remoteWorkspaceShells(await window.prospero.listRemoteWorkspaceShells(id), current.current.cwd);
      if (token !== generation.current || current.current.id !== id) return;
      setSessions(available); setConnected(true);
      if (selected.current && !available.some(session => session.id === selected.current)) { selected.current = undefined; setSid(undefined); }
    } catch (reason) { if (token === generation.current) setError(displayError(reason)); }
    finally { if (token === generation.current) { pending.current = false; setBusy(undefined); } }
  };
  const open = async (newSession: boolean) => {
    if (pending.current || !supported) return;
    pending.current = true; setBusy(newSession ? "new" : "open"); setError("");
    const token = generation.current;
    const id = workspace.id;
    const preferred = newSession ? undefined : rememberedRemoteShell(id);
    let confirmed: string | undefined;
    try {
      const result = await openingWorkspaces.run(id, () => window.prospero.openRemoteWorkspace(id, { newSession }));
      if (token !== generation.current || current.current.id !== id) return;
      if (result.workspace.id !== id || result.workspace.hostId !== workspace.hostId) throw new Error(t("远程工作区已变更，请重新打开。", "The remote workspace changed. Open it again."));
      confirmed = result.sessionId;
      setResolved(result.workspace); setConnected(true);
      if (!preferred || preferred === result.sessionId) select(result.sessionId);
      const available = remoteWorkspaceShells(await window.prospero.listRemoteWorkspaceShells(id), result.workspace.cwd);
      if (token !== generation.current || current.current.id !== id) return;
      setSessions(available);
      select(chooseRemoteShell(available, preferred, result.sessionId));
    } catch (reason) { if (token === generation.current) setError(displayError(reason)); }
    finally {
      if (token === generation.current) {
        if (!selected.current && confirmed) select(confirmed);
        pending.current = false; setBusy(undefined);
      }
    }
  };

  useEffect(() => {
    generation.current++;
    pending.current = false;
    selected.current = undefined;
    setSid(undefined); setSessions([]); setResolved(undefined); setError(""); setConnected(false); setConnection("");
    consumedRequest.current = newSessionRequest;
    const unsubscribe = window.prospero.subscribeRemoteShell(event => {
      if (event.hostId !== workspace.hostId) return;
      const message = event.message;
      if (message.type === "remote.connected") {
        setConnected(true);
        setConnection(message.transport === "relay" ? t("中继连接", "Relay connection") : t("直连", "Direct connection"));
        if (!pending.current && selected.current) void refresh();
      } else if (message.type === "remote.closed") {
        setConnected(false); setConnection(t("已断开，远程进程仍保留", "Disconnected; remote processes are retained"));
      } else if (message.type === "remote.reconnecting") {
        setConnected(false); setConnection(t("正在重连…", "Reconnecting…"));
      } else if (message.type === "remote.error") setError(text(message.message, t("远程连接失败，请重试。", "Remote connection failed. Retry.")));
      else if (message.type === "session.state" || message.type === "session.create.result") {
        const session = record(message.session) as SessionInfo;
        if (!session.id || session.kind !== "pty") return;
        if (remoteShellEnded(session)) {
          setSessions(previous => previous.filter(item => item.id !== session.id));
          if (selected.current === session.id) { selected.current = undefined; setSid(undefined); }
        } else if (remoteWorkspaceShells([session], current.current.cwd).length) {
          setSessions(previous => remoteWorkspaceShells([...previous.filter(item => item.id !== session.id), session], current.current.cwd));
        }
      }
    });
    void open(newSessionRequest > 0);
    return () => { generation.current++; pending.current = false; unsubscribe(); };
  }, [workspace.id]);

  useEffect(() => {
    if (newSessionRequest <= consumedRequest.current) return;
    consumedRequest.current = newSessionRequest;
    if (!pending.current) void open(true);
  }, [newSessionRequest]);

  const tabs = sessions.some(session => session.id === sid) || !sid ? sessions.map(session => ({ id: session.id, title: session.title || session.agent, cwd: session.cwd }))
    : [{ id: sid, title: "Shell", cwd: active.cwd }, ...sessions.map(session => ({ id: session.id, title: session.title || session.agent, cwd: session.cwd }))];
  const activeIndex = tabs.findIndex(tab => tab.id === sid);
  return <section className="remote-workspace-pane" aria-label={t(`远程工作区：${active.hostName} · ${active.cwd}`, `Remote workspace: ${active.hostName} · ${active.cwd}`)}>
    {!focus && <>
      <header className="remote-workspace-toolbar">
        <div className="remote-workspace-title"><DesktopIcon name="server" /><strong>{t("远程", "Remote")} · {active.hostName}</strong><span title={active.cwd}>{active.cwd}</span></div>
        <button type="button" disabled={Boolean(busy) || !supported} aria-busy={busy === "new"} aria-label={t("新建远程 Shell", "New remote Shell")} onClick={() => void open(true)}><DesktopIcon name="add" />Shell</button>
        <button type="button" disabled={Boolean(busy) || !supported} aria-label={t("刷新远程会话", "Refresh remote sessions")} onClick={() => void refresh()}><DesktopIcon name="refresh" className={busy ? "daemon-spinner" : undefined} /></button>
        <button type="button" aria-label={t("进入专注模式", "Enter focus mode")} onClick={onToggleFocus}><DesktopIcon name="expand" /></button>
      </header>
      {tabs.length > 0 && <div className="remote-workspace-tabs" role="tablist" aria-label={t("此目录的远程 Shell", "Remote Shells in this directory")}>
        {tabs.map((tab, index) => <button type="button" role="tab" id={`remote-shell-tab-${tab.id}`} key={tab.id} aria-selected={tab.id === sid} aria-controls="remote-workspace-terminal" tabIndex={tab.id === sid || activeIndex < 0 && index === 0 ? 0 : -1} title={tab.cwd} onClick={() => select(tab.id)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          const item = tabs[next];
          if (item) { select(item.id); document.getElementById(`remote-shell-tab-${item.id}`)?.focus(); }
        }}><DesktopIcon name="terminal" size={14} /><span>{tab.title}</span></button>)}
      </div>}
    </>}
    {focus && <button type="button" className="remote-workspace-focus-exit" aria-label={t("退出专注模式", "Exit focus mode")} onClick={onToggleFocus}><DesktopIcon name="collapse" /></button>}
    {(!connected || error || !supported) && <div className={`remote-workspace-status${error || !supported ? " is-error" : ""}`} role={error || !supported ? "alert" : "status"} tabIndex={error ? 0 : undefined}>
      <DesktopIcon name={error || !supported ? "alert" : "relay"} size={14} />
      <span>{!supported ? t("请更新桌面客户端以打开远程工作区。", "Update the desktop client to open remote workspaces.") : error || connection || t("正在连接远程电脑…", "Connecting to the remote computer…")}</span>
      {supported && <button type="button" disabled={Boolean(busy)} onClick={() => void open(false)}>{busy ? t("连接中…", "Connecting…") : t("重连", "Reconnect")}</button>}
    </div>}
    {sid ? <div id="remote-workspace-terminal" role="tabpanel" aria-label={focus ? t("远程终端", "Remote terminal") : undefined} aria-labelledby={focus ? undefined : `remote-shell-tab-${sid}`} className="remote-terminal">
      <RemoteTerminal key={`${active.hostId}:${sid}`} hostId={active.hostId} sid={sid} connected={connected} settings={settings} label={t(`远程终端：${active.hostName} · ${active.cwd}`, `Remote terminal: ${active.hostName} · ${active.cwd}`)} />
    </div> : <div className="remote-workspace-empty"><DesktopIcon name="terminal" size={28} /><strong>{busy ? t("正在打开远程工作区…", "Opening remote workspace…") : t("此工作区没有打开的 Shell", "No Shell is open in this workspace")}</strong><p>{t("Shell 会在远程电脑的这个目录中运行，可直接输入 codex、claude 或项目命令。切换工作区不会结束远程进程。", "The Shell runs in this directory on the remote computer. Enter codex, claude, or project commands. Switching workspaces keeps remote processes running.")}</p>{!busy && supported && <button type="button" onClick={() => void open(false)}><DesktopIcon name="terminal" />{t("打开 Shell", "Open Shell")}</button>}</div>}
  </section>;
}
