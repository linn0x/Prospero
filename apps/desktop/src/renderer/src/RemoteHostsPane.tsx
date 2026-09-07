import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Link2, Plus, RefreshCw, Server, Trash2, Unplug } from "lucide-react";
import type { RemoteHostSummary, SessionInfo } from "../../shared/types";
import { useLocale } from "./locale";
import { displayError } from "./state";

function encodeInput(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function RemoteTerminal({ hostId, sid, connected, onError }: {
  hostId: string; sid: string; connected: boolean; onError: (error: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  useEffect(() => { if (terminalRef.current) terminalRef.current.options.disableStdin = !connected; }, [connected]);
  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({ cols: 120, rows: 36, scrollback: 3000, fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, monospace', cursorBlink: true,
      theme: { background: "#0a0f18", foreground: "#d8e4f5", cursor: "#88aaff" } });
    terminalRef.current = term;
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current);
    let disposed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = -1;
    let pendingBytes = 0;
    let resync = false;
    let snapshotRequested = false;
    const fitTerminal = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || !container.current?.clientWidth) return;
        fit.fit();
        void window.prospero.resizeRemoteShell(hostId, sid, term.cols, term.rows).catch((reason) => onError(displayError(reason)));
      }, 100);
    };
    const requestSnapshot = () => {
      if (snapshotRequested || disposed) return;
      snapshotRequested = true;
      void window.prospero.attachRemoteShell(hostId, sid).catch((reason) => onError(displayError(reason)));
    };
    const write = (data: string | Uint8Array) => {
      const size = typeof data === "string" ? data.length * 2 : data.byteLength;
      pendingBytes += size;
      term.write(data, () => {
        pendingBytes -= size;
        if (resync && pendingBytes === 0) requestSnapshot();
      });
    };
    const unsubscribe = window.prospero.subscribeRemoteShell((event) => {
      if (event.hostId !== hostId) return;
      const message = event.message;
      if (message.type === "remote.connected") { term.options.disableStdin = false; fitTerminal(); return; }
      if (message.type === "remote.closed") { term.options.disableStdin = true; return; }
      if (message.sid !== sid) return;
      try {
        if (message.type === "term.snapshot") {
          resync = false; snapshotRequested = false;
          lastSeq = Number(message.seq);
          term.reset(); write(String(message.ansi ?? "")); fitTerminal();
        } else if (message.type === "term.output") {
          const seq = Number(message.seq);
          if (seq <= lastSeq || resync) return;
          if (pendingBytes > 2 * 1024 * 1024) { resync = true; return; }
          lastSeq = seq;
          const raw = atob(String(message.dataB64));
          write(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
        }
      } catch (reason) { onError(displayError(reason)); }
    });
    const input = term.onData((data) => {
      // Preserve Enter, arrows, Ctrl-C and bracketed paste exactly as xterm emits them.
      void window.prospero.sendRemoteShellInput(hostId, sid, encodeInput(data)).catch((reason) => onError(displayError(reason)));
    });
    const observer = new ResizeObserver(fitTerminal); observer.observe(container.current);
    requestSnapshot(); term.focus();
    return () => {
      disposed = true; unsubscribe(); input.dispose(); observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      terminalRef.current = undefined; term.dispose();
    };
  }, [hostId, sid, onError]);
  return <div className="remote-xterm" ref={container} aria-label="Remote Shell terminal" />;
}

export default function RemoteHostsPane() {
  const { t } = useLocale();
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [pairing, setPairing] = useState("");
  const pairingDetails = useRef<HTMLDetailsElement | null>(null);
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
  const onError = useCallback((message: string) => setError(message), []);
  const refreshHosts = useCallback(async () => setHosts(await window.prospero.listRemoteHosts()), []);
  useEffect(() => { void refreshHosts().catch((reason) => setError(displayError(reason))); }, [refreshHosts]);
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
    try { await action(); } catch (reason) { setError(displayError(reason)); }
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
    if (selectedRef.current && selectedRef.current !== hostId) await window.prospero.disconnectRemoteHost(selectedRef.current);
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
  return <section className="form-card remote-control-card" aria-labelledby="remote-hosts-title">
    <div className="section-title"><Server size={16} /><h2 id="remote-hosts-title">{t("远程电脑", "Remote computers")}</h2><span>{hosts.length}</span></div>
    <details ref={pairingDetails} className="remote-pairing-details" open={hosts.length === 0}><summary>{t("添加远程电脑", "Add remote computer")}</summary>
    <p className="security-note">{t("在另一台电脑的「远程控制」中生成配对串，粘贴到这里。连接后可在 Shell 中运行 codex、claude 或其他 CLI。", "Generate a pairing code under Remote control on another computer and paste it here. Run codex, claude or another CLI in its Shell.")}</p>
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
      {sessions.length > 0 && <div className="remote-session-tabs" aria-label={t("远程会话", "Remote sessions")}>{sessions.map((session) => <button key={session.id} aria-pressed={sid === session.id} disabled={busy || !connected} onClick={() => setSid(session.id)} title={session.cwd}>{session.title || session.agent}</button>)}</div>}
      {sid && <RemoteTerminal key={`${selected}:${sid}`} hostId={selected} sid={sid} connected={connected} onError={onError} />}
      {sid && <div className="button-row compact"><button disabled={busy || !connected} onClick={() => void run(async () => { await window.prospero.sendRemoteShellInput(selected, sid, "Aw=="); })}>Ctrl+C</button><button className="danger" disabled={busy || !connected} onClick={() => void run(async () => { await window.prospero.killRemoteShell(selected, sid); setSessions((current) => current.filter((s) => s.id !== sid)); setSid(undefined); })}>{t("结束当前 Shell", "End current Shell")}</button></div>}
    </div>}
  </section>;
}
