import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { SessionInfo } from "../../shared/types";
import { displayError, number, text } from "./state";
import { useLocale } from "./locale";

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

function fromBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export function TerminalPane({ session, fontFamily, fontSize }: { session: SessionInfo; fontFamily: string; fontSize: number }) {
  const { t } = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const cursorRef = useRef<number | undefined>(undefined);
  const writeChain = useRef(Promise.resolve());
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily,
      fontSize,
      lineHeight: 1.15,
      scrollback: 10_000,
      theme: {
        background: "#090a0d", foreground: "#d9dce2", cursor: "#8da4ff",
        selectionBackground: "#3c5088aa", black: "#17181d", red: "#ff6b7a",
        green: "#69d19b", yellow: "#e7c46b", blue: "#78a7ff", magenta: "#c391ff",
        cyan: "#63c7d6", white: "#d9dce2", brightBlack: "#626873",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    try { terminal.loadAddon(new WebglAddon()); } catch { /* Canvas renderer remains available. */ }
    fit.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitRef.current = fit;

    let input = "";
    let inputTimer: number | undefined;
    const flushInput = (): void => {
      if (!input) return;
      const payload = input;
      input = "";
      void window.prospero.interact(session.id, { type: "term.input", dataB64: toBase64(payload) }).catch((reason) => setError(displayError(reason)));
    };
    const inputDisposable = terminal.onData((value) => {
      input += value;
      window.clearTimeout(inputTimer);
      inputTimer = window.setTimeout(flushInput, 4);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (event.ctrlKey && event.shiftKey && event.code === "KeyC") {
        const selection = terminal.getSelection();
        if (selection) void navigator.clipboard.writeText(selection);
        return false;
      }
      if (event.ctrlKey && event.shiftKey && event.code === "KeyV") {
        void navigator.clipboard.readText().then((value) => terminal.paste(value));
        return false;
      }
      return true;
    });

    let resizeTimer: number | undefined;
    const resize = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fit.fit();
        void window.prospero.interact(session.id, { type: "term.resize", cols: terminal.cols, rows: terminal.rows }).catch((reason) => setError(displayError(reason)));
      }, 80);
    });
    resize.observe(host.current);

    return () => {
      window.clearTimeout(inputTimer);
      window.clearTimeout(resizeTimer);
      flushInput();
      resize.disconnect();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      cursorRef.current = undefined;
    };
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontFamily, fontSize]);

  useEffect(() => {
    let active = true;
    const poll = async (): Promise<void> => {
      while (active) {
        try {
          const cursor = cursorRef.current;
          const frame = await window.prospero.getSessionView(session.id, cursor === undefined ? {} : { outputAfterSeq: cursor, waitMs: 20_000 });
          if (!active || !frame) continue;
          if (text(frame["kind"]) !== "pty") throw new Error(t("daemon 返回了错误的会话类型", "The daemon returned the wrong session type"));
          const mode = text(frame["mode"], "snapshot");
          const seq = number(frame["seq"]);
          if (mode === "delta") {
            if (number(frame["baseSeq"], -1) !== cursorRef.current) { cursorRef.current = undefined; continue; }
            const output = fromBase64(text(frame["dataB64"]));
            writeChain.current = writeChain.current.then(() => new Promise<void>((done) => terminalRef.current?.write(output, done) ?? done()));
          } else {
            const ansi = text(frame["ansi"]);
            writeChain.current = writeChain.current.then(() => new Promise<void>((done) => {
              const current = terminalRef.current;
              if (!current) { done(); return; }
              current.reset();
              current.resize(Math.max(20, number(frame["cols"], 120)), Math.max(5, number(frame["rows"], 40)));
              current.write(ansi, done);
            }));
          }
          await writeChain.current;
          cursorRef.current = seq;
          setConnected(true);
          setError(undefined);
        } catch (reason) {
          if (!active) break;
          setConnected(false);
          setError(displayError(reason));
          cursorRef.current = undefined;
          await new Promise((wait) => window.setTimeout(wait, 900));
        }
      }
    };
    void poll();
    return () => { active = false; };
  }, [session.id, t]);

  return <div className="terminal-shell">
    <div className="terminal-status"><span className={connected ? "live-dot" : "live-dot offline"} />{connected ? t("实时终端", "Live terminal") : t("正在重连", "Reconnecting")}<span className="terminal-shortcut">Ctrl+Shift+C / V</span></div>
    <div ref={host} className="terminal-host" />
    {error && <div className="inline-error">{error}</div>}
  </div>;
}
