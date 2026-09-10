import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Plus, RefreshCw, Server, Trash2, Unplug } from "lucide-react";
import type { RemoteHostSummary, SessionInfo } from "../../shared/types";
import { useLocale } from "./locale";
import { reportError } from "./state";
import { RemoteTerminal, type RemoteTerminalHandle, type RemoteTerminalSettings } from "./remote-workspaces/RemoteTerminal";


export default function RemoteHostsPane({ settings = { terminalFontFamily: "monospace", terminalFontSize: 13, theme: "system" } }: { settings?: RemoteTerminalSettings } = {}) {
  const { t } = useLocale();
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [pairing, setPairing] = useState("");
  const pairingDetails = useRef<HTMLDetailsElement | null>(null);
  const terminalControls = useRef<RemoteTerminalHandle>(null);
  const [selected, setSelected] = useState<string>();
  const selectedRef = useRef<string | undefined>(undefined);
  const [sid, setSid] = useState<string>();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("");
  const [connected, setConnected] = useState(false);
  const refreshHosts = useCallback(async () => setHosts(await window.prospero.listRemoteHosts()), []);
  useEffect(() => { void refreshHosts().catch((reason) => setError(reportError(reason))); }, [refreshHosts]);
  useEffect(() => window.prospero.subscribeRemoteShell((event) => {
    if (event.hostId !== selectedRef.current) return;
    const message = event.message;
    if (message.type === "remote.connected") {
      setConnected(true); setError(undefined);
      setStatus(message.transport === "relay" ? t("中继已连接", "Connected via relay") : t("直连已连接", "Direct connection"));
    } else if (message.type === "remote.closed") { setConnected(false); setStatus(t("已断开", "Disconnected")); }
    else if (message.type === "remote.reconnecting") setStatus(t(`正在重连（${String(message.attempt)}）`, `Reconnecting (${String(message.attempt)})`));
    else if (message.type === "remote.error" || message.type === "error") setError(String(message.message));
    else if (message.type === "session.state" || message.type === "session.create.result") {
      const session = message.session as SessionInfo | undefined;
      if (session?.kind === "pty") {
        setSessions((current) => {
          if (["done", "died", "completed"].includes(session.status)) return current.filter((value) => value.id !== session.id);
          return current.some((value) => value.id === session.id)
            ? current.map((value) => value.id === session.id ? session : value) : [...current, session].slice(0, 128);
        });
      }
    }
  }), [t]);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    try { await action(); } catch (reason) { setError(reportError(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const connect = async (hostId: string) => {
    if (pairingDetails.current) pairingDetails.current.open = false;
    if (selectedRef.current === hostId && connected) {
      const available = await window.prospero.listRemoteShells(hostId);
      setSessions(available);
      if (!sid && available[0]) setSid(available[0].id);
      return;
    }
    selectedRef.current = hostId; setSelected(hostId); setSid(undefined); setSessions([]); setStatus(t("连接中…", "Connecting…")); setConnected(false);
    await window.prospero.connectRemoteHost(hostId);
    const available = await window.prospero.listRemoteShells(hostId);
    setSessions(available); setConnected(true);
    if (available[0]) setSid(available[0].id);
    else setSid(await window.prospero.createRemoteShell(hostId, cwd.trim() || undefined));
  };
  const newShell = async () => {
    if (selected) setSid(await window.prospero.createRemoteShell(selected, cwd.trim() || undefined));
  };
  const remove = async (hostId: string) => {
    await window.prospero.removeRemoteHost(hostId);
    if (selected === hostId) { selectedRef.current = undefined; setSelected(undefined); setSid(undefined); setSessions([]); setConnected(false); }
    await refreshHosts();
  };
  return <div className="page remote-computers-page">
    <header className="page-header"><div><span className="eyebrow">DESKTOP TO DESKTOP</span><h1>{t("远程电脑", "Remote computers")}</h1><p>{t("通过局域网或中继连接其他电脑，在交互式 Shell 中使用 Agent CLI。", "Connect to another computer over LAN or relay and use its agent CLI in an interactive Shell.")}</p></div></header>
    <section className="form-card remote-control-card" aria-labelledby="remote-hosts-title">
    <div className="section-title"><Server size={16} /><h2 id="remote-hosts-title">{t("已配对电脑", "Paired computers")}</h2><span>{hosts.length}</span></div>
    <details ref={pairingDetails} className="remote-pairing-details" open={hosts.length === 0}><summary>{t("添加远程电脑", "Add remote computer")}</summary>
    <p className="security-note">{t("在另一台电脑的「移动端 → 让其他设备连接本机」中生成配对串，粘贴到这里。连接后可在 Shell 中运行 codex、claude 或其他 CLI。", "Generate a pairing code under Mobile → Pair a device with this computer on another computer and paste it here. Run codex, claude or another CLI in its Shell.")}</p>
    <form className="remote-host-import" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      await window.prospero.importRemoteHost(pairing.trim()); setPairing(""); await refreshHosts();
    }); }}>
      <input type="password" aria-label={t("远程电脑配对串", "Remote computer pairing code")} value={pairing} onChange={(event) => setPairing(event.target.value)} placeholder="prospero://pair?d=…" autoComplete="off" maxLength={65536} disabled={busy} />
      <button disabled={busy || !pairing.trim()}><Link2 size={14} />{t("导入电脑", "Import computer")}</button>
    </form></details>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="remote-host-list">{hosts.map((host) => <article className={`device-card${selected === host.id ? " remote-host-selected" : ""}`} key={host.id}>
      <div className="device-icon"><Server size={20} /></div><div><strong>{host.name}</strong><p>{host.addrs.length ? host.addrs.join(" · ") : t("通过中继连接", "Relay connection")}{host.hasRelay && host.addrs.length ? t(" · 支持中继", " · Relay available") : ""}</p></div>
      <button disabled={busy} onClick={() => void run(() => connect(host.id))}>{selected === host.id && connected ? t("会话列表", "Sessions") : t("连接 Shell", "Connect Shell")}</button>
      <button className="icon-button danger" disabled={busy} aria-label={t(`移除 ${host.name}`, `Remove ${host.name}`)} onClick={() => void run(() => remove(host.id))}><Trash2 size={15} /></button>
    </article>)}</div>
    {selected && <div className="remote-shell-workspace">
      <div className="remote-shell-toolbar">
        <span className="pill" role="status" aria-live="polite">{status}</span>
        <input value={cwd} onChange={(event) => setCwd(event.target.value)} maxLength={4096} placeholder={t("新 Shell 工作目录（可选）", "New Shell directory (optional)")} aria-label={t("远程工作目录", "Remote working directory")} />
        <button disabled={busy || !connected} onClick={() => void run(newShell)}><Plus size={14} />Shell</button>
        <button disabled={busy} title={t("刷新会话", "Refresh sessions")} aria-label={t("刷新会话", "Refresh sessions")} onClick={() => void run(async () => { setSessions(await window.prospero.listRemoteShells(selected)); setConnected(true); })}><RefreshCw size={14} /></button>
        <button disabled={busy} onClick={() => void run(async () => { await window.prospero.disconnectRemoteHost(selected); setConnected(false); })}><Unplug size={14} />{t("断开", "Disconnect")}</button>
      </div>
      {sessions.length > 0 && <div className="remote-session-tabs" aria-label={t("远程会话", "Remote sessions")}>{sessions.map((session) => <button key={session.id} data-liquid-glass="tab" aria-pressed={sid === session.id} disabled={busy || !connected} onClick={() => setSid(session.id)} title={session.cwd}>{session.title || session.agent}</button>)}</div>}
      {sid && <RemoteTerminal key={`${selected}:${sid}`} hostId={selected} sid={sid} connected={connected} settings={settings} controlRef={terminalControls} />}
      {sid && <div className="button-row compact"><button disabled={busy || !connected} onClick={() => terminalControls.current?.interrupt()}>Ctrl+C</button><button className="danger" disabled={busy || !connected} onClick={() => void run(async () => { await window.prospero.killRemoteShell(selected, sid); setSessions((current) => current.filter((s) => s.id !== sid)); setSid(undefined); })}>{t("结束当前 Shell", "End current Shell")}</button></div>}
    </div>}
  </section></div>;
}
