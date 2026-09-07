import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { DesktopSettings } from "../../../shared/types";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import { displayError } from "../state";
import { RemoteTerminalBuffer, remoteInputBase64, remoteTerminalTheme } from "./remote-terminal-state";
import "./remote-workspaces.css";

export type RemoteTerminalSettings = Pick<DesktopSettings, "terminalFontFamily" | "terminalFontSize" | "theme">;
export type RemoteTerminalHandle = { interrupt(): void; focus(): void };

export function RemoteTerminal({ hostId, sid, connected, settings, label, controlRef }: {
  hostId: string; sid: string; connected: boolean; settings: RemoteTerminalSettings; label?: string; controlRef?: Ref<RemoteTerminalHandle>;
}) {
  const { t } = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const connectedRef = useRef(connected);
  const settingsRef = useRef(settings);
  const refit = useRef<(() => void) | undefined>(undefined);
  const retry = useRef<(() => void) | undefined>(undefined);
  const updateInputRef = useRef<(() => void) | undefined>(undefined);
  const translate = useRef(t);
  const sendInputRef = useRef<((data: string) => void) | undefined>(undefined);
  const [error, setError] = useState("");
  const [attaching, setAttaching] = useState(true);
  connectedRef.current = connected;
  settingsRef.current = settings;
  translate.current = t;
  useImperativeHandle(controlRef, () => ({ interrupt: () => sendInputRef.current?.("\x03"), focus: () => terminal.current?.focus() }), []);

  useEffect(() => {
    if (!container.current) return;
    const ownerId = crypto.randomUUID();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const term = new Terminal({ cols: 120, rows: 36, scrollback: 3000, disableStdin: true,
      fontSize: settingsRef.current.terminalFontSize, fontFamily: settingsRef.current.terminalFontFamily,
      cursorBlink: !motion.matches, cursorStyle: "bar", lineHeight: 1.16, minimumContrastRatio: 4.5,
      theme: remoteTerminalTheme(getComputedStyle(document.documentElement)) });
    terminal.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    let disposed = false;
    let attached = false;
    let snapshotRequested = false;
    let fitAfterWrite = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let inputQueue = Promise.resolve();
    const canInput = () => !disposed && attached && connectedRef.current;
    const updateInput = () => { term.options.disableStdin = !canInput(); };
    const fail = (reason: unknown) => { if (!disposed) setError(displayError(reason)); };
    const fitTerminal = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || !container.current?.clientWidth || !container.current.clientHeight) return;
        fit.fit();
        if (!canInput()) return;
        void window.prospero.resizeRemoteShell(hostId, sid, term.cols, term.rows, ownerId).catch(fail);
      }, 100);
    };
    const requestSnapshot = () => {
      if (snapshotRequested || disposed) return;
      snapshotRequested = true;
      setAttaching(true); setError("");
      clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        snapshotRequested = false; attached = false; updateInput();
        if (!disposed) { setAttaching(false); setError(translate.current("终端画面恢复超时，请重试连接。", "Terminal restoration timed out. Retry the connection.")); }
      }, 12_000);
      void window.prospero.attachRemoteShell(hostId, sid, ownerId).then(() => {
        if (disposed) { void window.prospero.detachRemoteShell(hostId, sid, ownerId).catch(() => {}); return; }
        attached = true; updateInput();
      }).catch(reason => {
        if (disposed) return;
        snapshotRequested = false; attached = false; clearTimeout(snapshotTimer); updateInput(); setAttaching(false); fail(reason);
      });
    };
    const buffer = new RemoteTerminalBuffer({
      reset: (cols, rows) => { term.resize(cols, rows); term.reset(); fitAfterWrite = true; },
      write: (data, done) => {
        const refitSnapshot = fitAfterWrite; fitAfterWrite = false;
        term.write(data, () => { done(); if (!disposed && refitSnapshot) fitTerminal(); });
      },
    }, requestSnapshot);
    const unsubscribe = window.prospero.subscribeRemoteShell(event => {
      if (event.hostId !== hostId || disposed) return;
      const message = event.message;
      if (message.type === "remote.connected") { connectedRef.current = true; updateInput(); fitTerminal(); return; }
      if (message.type === "remote.closed" || message.type === "remote.reconnecting") { connectedRef.current = false; updateInput(); return; }
      if (message.sid !== sid) return;
      try {
        if (message.type === "term.snapshot") {
          buffer.snapshot(Number(message.seq), String(message.ansi ?? ""), Number(message.cols), Number(message.rows));
          snapshotRequested = false; clearTimeout(snapshotTimer); attached = true; updateInput(); setAttaching(false); setError("");
        } else if (message.type === "term.output") buffer.output(Number(message.seq), String(message.dataB64 ?? ""));
      } catch (reason) { attached = false; updateInput(); snapshotRequested = false; clearTimeout(snapshotTimer); setAttaching(false); fail(reason); }
    });
    const sendInput = (data: string) => {
      if (!canInput()) return;
      inputQueue = inputQueue.then(async () => {
        if (canInput()) await window.prospero.sendRemoteShellInput(hostId, sid, remoteInputBase64(data), ownerId);
      }).catch(reason => { attached = false; updateInput(); fail(reason); });
    };
    sendInputRef.current = sendInput;
    const input = term.onData(sendInput);
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown") return true;
      const command = window.prospero.platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
      if (!command || event.altKey) return true;
      if (event.code === "KeyC") { const selection = term.getSelection(); if (selection) void window.prospero.writeClipboard(selection).catch(fail); return false; }
      if (event.code === "KeyV") {
        if (canInput()) void window.prospero.readClipboard().then(value => { if (value && canInput()) term.paste(value); }).catch(fail);
        return false;
      }
      if (event.code === "KeyA" && window.prospero.platform === "darwin") { term.selectAll(); return false; }
      return true;
    });
    const updateTheme = () => {
      if (disposed) return;
      term.options.theme = remoteTerminalTheme(getComputedStyle(document.documentElement));
      term.options.cursorBlink = !motion.matches;
    };
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-high-contrast", "data-reduced-transparency"] });
    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(container.current);
    motion.addEventListener("change", updateTheme);
    refit.current = fitTerminal; retry.current = requestSnapshot; updateInputRef.current = updateInput;
    requestSnapshot();
    term.focus();
    return () => {
      disposed = true; attached = false; buffer.dispose(); unsubscribe(); input.dispose(); resizeObserver.disconnect(); themeObserver.disconnect();
      motion.removeEventListener("change", updateTheme);
      clearTimeout(resizeTimer); clearTimeout(snapshotTimer);
      refit.current = undefined; retry.current = undefined; updateInputRef.current = undefined; sendInputRef.current = undefined; terminal.current = undefined;
      void window.prospero.detachRemoteShell(hostId, sid, ownerId).catch(() => {});
      term.dispose();
    };
  }, [hostId, sid]);

  useEffect(() => { updateInputRef.current?.(); }, [connected]);
  useEffect(() => {
    if (!terminal.current) return;
    terminal.current.options.fontFamily = settings.terminalFontFamily;
    terminal.current.options.fontSize = settings.terminalFontSize;
    terminal.current.options.theme = remoteTerminalTheme(getComputedStyle(document.documentElement));
    refit.current?.();
  }, [settings.terminalFontFamily, settings.terminalFontSize, settings.theme]);

  return <div className="remote-terminal" aria-busy={attaching}>
    {(error || attaching) && <div className="remote-terminal-error" role={error ? "alert" : "status"} tabIndex={error ? 0 : undefined}>
      <DesktopIcon name={error ? "alert" : "refresh"} className={attaching ? "daemon-spinner" : undefined} />
      <span>{error || t("正在恢复远程终端…", "Restoring remote terminal…")}</span>
      {error && <button type="button" disabled={attaching} onClick={() => retry.current?.()}>{t("重试", "Retry")}</button>}
    </div>}
    <div className="remote-terminal-canvas" ref={container} aria-label={label ?? t("远程 Shell 终端", "Remote Shell terminal")} />
  </div>;
}
