import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
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

type TerminalShortcutEvent = Pick<KeyboardEvent, "type" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
  key?: string;
};

type TerminalInteraction =
  | { type: "term.input"; dataB64: string }
  | { type: "term.resize"; cols: number; rows: number };

export type TerminalShortcutAction =
  | "copy"
  | "paste"
  | "selectAll"
  | "clear"
  | "find"
  | "beginningOfLine"
  | "endOfLine"
  | "deleteToBeginning"
  | "deleteToEnd"
  | "backwardWord"
  | "forwardWord";

export function terminalShortcutAction(
  event: TerminalShortcutEvent,
  isMac: boolean,
): TerminalShortcutAction | undefined {
  if (event.type !== "keydown") return undefined;
  const macCommand =
    isMac &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey;
  const otherClipboard = !isMac && event.ctrlKey && event.shiftKey;
  if (macCommand || otherClipboard) {
    if (event.code === "KeyC") return "copy";
    if (event.code === "KeyV") return "paste";
    // 查找在两个平台都要有:mac 是 ⌘F,其它平台跟随剪贴板的 Ctrl+Shift 约定。
    if (event.code === "KeyF") return "find";
  }
  if (!macCommand) {
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.code === "Insert") return "paste";
    if (isMac && event.altKey && !event.metaKey && !event.ctrlKey) {
      if (event.key === "ArrowLeft") return "backwardWord";
      if (event.key === "ArrowRight") return "forwardWord";
    }
    return undefined;
  }
  if (event.code === "KeyA") return "selectAll";
  if (event.code === "KeyK") return "clear";
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") return "beginningOfLine";
  if (event.key === "ArrowRight" || event.key === "ArrowDown") return "endOfLine";
  if (event.key === "Backspace") return "deleteToBeginning";
  if (event.key === "Delete") return "deleteToEnd";
  return undefined;
}

export function terminalClipboardAction(event: TerminalShortcutEvent, isMac: boolean): "copy" | "paste" | undefined {
  const action = terminalShortcutAction(event, isMac);
  return action === "copy" || action === "paste" ? action : undefined;
}

export function TerminalPane({ session, fontFamily, fontSize }: { session: SessionInfo; fontFamily: string; fontSize: number }) {
  const { t } = useLocale();
  const isMac = navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.includes("Macintosh");
  const shortcutHint = isMac
    ? t("⌥拖动选中 · ⌘C/⌘V 复制粘贴 · ⌘F 查找 · ⌘K 清屏", "⌥drag to select · ⌘C/⌘V copy and paste · ⌘F find · ⌘K clear")
    : t("Ctrl+Shift+C/V 复制粘贴 · Shift+Insert 粘贴", "Ctrl+Shift+C/V copy and paste · Shift+Insert paste");
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const searchRef = useRef<SearchAddon | undefined>(undefined);
  const cursorRef = useRef<number | undefined>(undefined);
  const writeChain = useRef(Promise.resolve());
  const interactionChain = useRef(Promise.resolve());
  const replayingRef = useRef(false);
  const connectedRef = useRef(false);
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [bell, setBell] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const findInputRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const queueInteraction = useCallback((message: TerminalInteraction): void => {
    interactionChain.current = interactionChain.current
      .then(() => connectedRef.current ? window.prospero.interact(session.id, message) : undefined)
      .catch((reason) => {
        connectedRef.current = false;
        cursorRef.current = undefined;
        if (terminalRef.current) terminalRef.current.options.disableStdin = true;
        setConnected(false);
        setError(displayError(reason));
      });
  }, [session.id]);
  /// 提示统一走这里:直接 setNotice 的话没有定时清除,那条提示会一直挂在屏幕上。
  const showNotice = useCallback((message: string): void => {
    setNotice(message);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(undefined), 1_250);
  }, []);

  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      fontFamily,
      fontSize,
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: 1.16,
      letterSpacing: 0.1,
      scrollback: 3_000,
      minimumContrastRatio: 4.5,
      customGlyphs: true,
      drawBoldTextInBrightColors: true,
      rescaleOverlappingGlyphs: true,
      smoothScrollDuration: 80,
      fastScrollSensitivity: 4,
      macOptionIsMeta: isMac,
      macOptionClickForcesSelection: isMac,
      altClickMovesCursor: false,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      theme: {
        background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5",
        cursorAccent: "#1a1b26", selectionBackground: "#283457",
        selectionInactiveBackground: "#242b49", scrollbarSliderBackground: "#7aa2f733",
        scrollbarSliderHoverBackground: "#7dcfff66", scrollbarSliderActiveBackground: "#7dcfff88",
        black: "#15161e", brightBlack: "#414868", red: "#f7768e", brightRed: "#f7768e",
        green: "#9ece6a", brightGreen: "#9ece6a", yellow: "#e0af68", brightYellow: "#e0af68",
        blue: "#7aa2f7", brightBlue: "#7aa2f7", magenta: "#bb9af7", brightMagenta: "#bb9af7",
        cyan: "#7dcfff", brightCyan: "#7dcfff", white: "#a9b1d6", brightWhite: "#c0caf5",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const search = new SearchAddon();
    terminal.loadAddon(search);
    // URL 可点。在 Electron 里必须显式交给系统浏览器打开 —— 渲染进程的
    // will-navigate 是被拦掉的,直接跳转只会是一个什么都不发生的点击。
    terminal.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      if (/^https?:\/\//i.test(uri)) void window.prospero.openExternal(uri);
    }));
    terminal.open(host.current);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch { /* Canvas renderer remains available. */ }
    fit.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;

    let input = "";
    let inputTimer: number | undefined;
    let bellTimer: number | undefined;
    const queueInputText = (value: string): void => {
      if (value && connectedRef.current) queueInteraction({ type: "term.input", dataB64: toBase64(value) });
    };
    const flushInput = (): void => {
      if (!input) return;
      const payload = input;
      input = "";
      queueInputText(payload);
    };
    const inputDisposable = terminal.onData((value) => {
      if (replayingRef.current || !connectedRef.current) return;
      input += value;
      window.clearTimeout(inputTimer);
      inputTimer = window.setTimeout(flushInput, 4);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      const action = terminalShortcutAction(event, isMac);
      if (action === "copy") {
        const selection = terminal.getSelection();
        if (selection) {
          void window.prospero.writeClipboard(selection)
            .then(() => showNotice(t("已复制", "Copied")))
            .catch((reason) => setError(displayError(reason)));
        } else showNotice(t("按住 ⌥ 拖动选择文本", "Hold Option while dragging to select text"));
        return false;
      }
      if (action === "paste") {
        void window.prospero.readClipboard()
          .then((value) => {
            if (value) {
              terminal.paste(value);
              showNotice(t("已粘贴", "Pasted"));
            } else showNotice(t("剪贴板为空", "Clipboard is empty"));
          })
          .catch((reason) => setError(displayError(reason)));
        return false;
      }
      if (action === "selectAll") {
        terminal.selectAll();
        showNotice(t("已选择终端内容", "Terminal contents selected"));
        return false;
      }
      if (action === "find") {
        setFindOpen(true);
        // autoFocus 只在挂载那次生效;条已经开着时再按 ⌘F 得把焦点收回来。
        window.setTimeout(() => findInputRef.current?.select(), 0);
        return false;
      }
      if (action === "clear") {
        terminal.clear();
        queueInputText("\x0c");
        showNotice(t("已清屏", "Terminal cleared"));
        return false;
      }
      if (action === "beginningOfLine") { queueInputText("\x01"); return false; }
      if (action === "endOfLine") { queueInputText("\x05"); return false; }
      if (action === "deleteToBeginning") { queueInputText("\x15"); return false; }
      if (action === "deleteToEnd") { queueInputText("\x0b"); return false; }
      if (action === "backwardWord") { queueInputText("\x1bb"); return false; }
      if (action === "forwardWord") { queueInputText("\x1bf"); return false; }
      return true;
    });
    const osc52Disposable = terminal.parser.registerOscHandler(52, (data) => {
      const separator = data.indexOf(";");
      if (separator < 0) return false;
      const payload = data.slice(separator + 1);
      if (payload === "?" || payload.length > 8 * 1024 * 1024) return true;
      try {
        const text = fromBase64(payload);
        if (text) void window.prospero.writeClipboard(text).then(() => showNotice(t("终端已复制到剪贴板", "Terminal copied to clipboard"))).catch((reason) => setError(displayError(reason)));
      } catch {
        showNotice(t("无法读取终端剪贴板内容", "Unable to read terminal clipboard data"));
      }
      return true;
    });
    const bellDisposable = terminal.onBell(() => {
      setBell(true);
      window.clearTimeout(bellTimer);
      bellTimer = window.setTimeout(() => setBell(false), 170);
    });

    let resizeTimer: number | undefined;
    const resize = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fit.fit();
        if (connectedRef.current) {
          queueInteraction({ type: "term.resize", cols: terminal.cols, rows: terminal.rows });
        }
      }, 80);
    });
    resize.observe(host.current);

    return () => {
      window.clearTimeout(inputTimer);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(noticeTimerRef.current);
      window.clearTimeout(bellTimer);
      flushInput();
      resize.disconnect();
      inputDisposable.dispose();
      osc52Disposable.dispose();
      bellDisposable.dispose();
      terminal.dispose();
      connectedRef.current = false;
      terminalRef.current = undefined;
      fitRef.current = undefined;
      cursorRef.current = undefined;
    };
  }, [isMac, queueInteraction, showNotice]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    let active = true;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    const fit = (): void => {
      if (!active) return;
      fitRef.current?.fit();
      const current = terminalRef.current;
      if (current && connectedRef.current) {
        queueInteraction({ type: "term.resize", cols: current.cols, rows: current.rows });
      }
    };
    const requestedFont = fontFamily.trim();
    if (requestedFont && document.fonts?.load) {
      void document.fonts
        .load(`${String(fontSize)}px ${requestedFont.split(",")[0] ?? requestedFont}`)
        .then(fit, fit);
    } else fit();
    return () => {
      active = false;
    };
  }, [fontFamily, fontSize, queueInteraction]);

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
              replayingRef.current = true;
              current.reset();
              current.resize(Math.max(20, number(frame["cols"], 120)), Math.max(5, number(frame["rows"], 40)));
              current.write(ansi, () => {
                replayingRef.current = false;
                done();
              });
            }));
          }
          await writeChain.current;
          cursorRef.current = seq;
          connectedRef.current = true;
          const current = terminalRef.current;
          if (current) {
            current.options.disableStdin = false;
            if (mode !== "delta") {
              fitRef.current?.fit();
              queueInteraction({ type: "term.resize", cols: current.cols, rows: current.rows });
            }
          }
          setConnected(true);
          setError(undefined);
        } catch (reason) {
          if (!active) break;
          connectedRef.current = false;
          if (terminalRef.current) terminalRef.current.options.disableStdin = true;
          setConnected(false);
          setError(displayError(reason));
          cursorRef.current = undefined;
          await new Promise((wait) => window.setTimeout(wait, 900));
        }
      }
    };
    void poll();
    return () => {
      active = false;
      connectedRef.current = false;
      if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    };
  }, [queueInteraction, session.id, t]);

  const runFind = (backwards: boolean): void => {
    const value = findText.trim();
    if (!value) return;
    // 概览标尺的两个颜色是必填项:搜索命中会在右侧滚动条上留下标记。
    const options = {
      decorations: {
        matchBackground: "#3d59a1",
        matchOverviewRuler: "#3d59a1",
        activeMatchBackground: "#7aa2f7",
        activeMatchColorOverviewRuler: "#7aa2f7",
      },
    };
    const hit = backwards
      ? searchRef.current?.findPrevious(value, options)
      : searchRef.current?.findNext(value, options);
    if (hit === false) showNotice(t("没有找到匹配", "No matches"));
  };
  const closeFind = (): void => {
    setFindOpen(false);
    searchRef.current?.clearDecorations();
    terminalRef.current?.focus();
  };

  return <div className={bell ? "terminal-shell terminal-bell" : "terminal-shell"}>
    <div className="terminal-status"><span className={connected ? "live-dot" : "live-dot offline"} />{connected ? t("实时终端", "Live terminal") : t("正在重连", "Reconnecting")}<span className="terminal-shortcut" title={shortcutHint}>{isMac ? "⌘C / ⌘V" : "Ctrl+Shift+C / V"}</span></div>
    {findOpen && <div className="terminal-find">
      <input
        ref={findInputRef}
        autoFocus
        value={findText}
        placeholder={t("在终端中查找", "Find in terminal")}
        onChange={(event) => setFindText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); closeFind(); return; }
          if (event.key === "Enter") { event.preventDefault(); runFind(event.shiftKey); }
        }}
      />
      <button type="button" onClick={() => runFind(true)} aria-label={t("上一个", "Previous")}>↑</button>
      <button type="button" onClick={() => runFind(false)} aria-label={t("下一个", "Next")}>↓</button>
      <button type="button" onClick={closeFind} aria-label={t("关闭查找", "Close find")}>✕</button>
    </div>}
    <div ref={host} className="terminal-host" />
    {notice && <div className="terminal-toast" role="status">{notice}</div>}
    {error && <div className="inline-error">{error}</div>}
  </div>;
}
