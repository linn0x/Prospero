import { preferLocalTerminalSelection } from "./terminal-mouse";
import { scheduleTerminalCache } from "./terminal-cache-scheduler";
import "./workspace/terminal-status.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { terminalFontFamilyWithFallbacks, TERMINAL_LINE_HEIGHT } from "../../shared/terminal-typography";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { SessionInfo } from "../../shared/types";
import { EXTERNAL_URL_REGEX, normalizeExternalUrl } from "../../shared/external-url";
import { displayError, isMissingSessionError, isUnrecoverableTerminalError, reportError, number, text } from "./state";
import { useLocale } from "./locale";
import { allowNativeTerminalPaste, bindTerminalPaste, consumeTerminalKey, terminalClipboardShortcut } from "./terminal-clipboard";
import { terminalBytes } from "./terminal-bytes";
import { configureRustTerminalUnicode } from "./terminal-unicode";
import { TerminalInputBuffer, TerminalInputQueue } from "./terminal-input-buffer";
import { suppressDaemonTerminalQueries, writeTerminalEvents } from "./terminal-events";
import { TerminalResizeCoordinator } from "./terminal-resize";
import { TerminalStreamController, type TerminalStreamState } from "./terminal-stream-controller";
import { TerminalStreamKind, type TerminalStreamFrame } from "../../shared/terminal-stream";
import { readTerminalReadingState, saveTerminalReadingState } from "./workspace/terminal-reading-state";
import {
  deleteTerminalSessionCache,
  loadTerminalSessionCache,
  saveTerminalSessionCache,
  TERMINAL_SESSION_CACHE_SCROLLBACK,
} from "./terminal-session-cache";

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

function persistTerminalSession(
  sessionId: string,
  terminal: Terminal,
  serialize: SerializeAddon,
  cursor: number,
): boolean {
  const entry = {
    sessionId,
    cursor,
    cols: terminal.cols,
    rows: terminal.rows,
    serialized: serialize.serialize({ scrollback: TERMINAL_SESSION_CACHE_SCROLLBACK }),
  };
  if (saveTerminalSessionCache(entry)) return true;
  const fallback = {
    ...entry,
    serialized: serialize.serialize({ scrollback: Math.min(250, TERMINAL_SESSION_CACHE_SCROLLBACK) }),
  };
  return saveTerminalSessionCache(fallback);
}

type TerminalShortcutEvent = Pick<KeyboardEvent, "type" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
  key?: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
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
  if (event.type !== "keydown" || event.defaultPrevented || event.isComposing) return undefined;
  const clipboard = terminalClipboardShortcut(event, isMac);
  if (clipboard) return clipboard;
  const macCommand =
    isMac &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey;
  const otherClipboard = !isMac && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
  if (macCommand || otherClipboard) {
    if (event.code === "KeyF") return "find";
  }
  if (!macCommand) {
    if (isMac && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
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

export function getTerminalEmptyFrameDelay(elapsedMs: number, eventStream = false): number {
  // Rust long polls also wake for input activity before echo bytes arrive.
  // Retrying that stream immediately is essential for interactive latency.
  return !eventStream && elapsedMs < 500 ? 650 : 0;
}

export function terminalSessionIsReadOnly(status: string): boolean {
  return ["idle", "completed", "done", "died", "failed", "stopped", "cancelled", "exited", "killed"].includes(status);
}

export function terminalStreamCanControl(state: Pick<TerminalStreamState, "connected" | "syncing" | "controller" | "readOnly" | "exited">, status: string): boolean {
  return !terminalSessionIsReadOnly(status) && state.connected && !state.syncing && state.controller && !state.readOnly && !state.exited;
}

export function canDeliverTerminalInteraction(
  connected: boolean,
  readOnly: boolean,
  accepted = false,
): boolean {
  return !readOnly && (connected || accepted);
}

function isTerminalMouseSequence(value: string, index: number): number {
  if (value.startsWith("\x1b[<", index)) {
    let cursor = index + 3;
    let separators = 0;
    while (cursor < value.length) {
      const char = value[cursor]!;
      if (char >= "0" && char <= "9") {
        cursor += 1;
        continue;
      }
      if (char === ";") {
        separators += 1;
        cursor += 1;
        continue;
      }
      if ((char === "M" || char === "m") && separators === 2) return cursor + 1;
      return -1;
    }
    return -1;
  }
  if (value.startsWith("\x1b[M", index) && index + 6 <= value.length) return index + 6;
  return -1;
}

function isOnlyTerminalMouseInput(value: string): boolean {
  if (!value) return false;
  let index = 0;
  while (index < value.length) {
    const next = isTerminalMouseSequence(value, index);
    if (next < 0) return false;
    index = next;
  }
  return true;
}

export function terminalInputShouldScrollToBottom(value: string): boolean {
  return !isOnlyTerminalMouseInput(value);
}

export function terminalBootstrapCursor(cachedCursor?: number): number {
  return typeof cachedCursor === "number" && Number.isSafeInteger(cachedCursor) && cachedCursor >= 0 ? cachedCursor : 0;
}

/** Hello dimensions are only a cold-start hint; replayed cells own their resize order. */
export function terminalShouldApplyHelloDimensions(cursor: number | undefined, hasPresentedFrame: boolean): boolean {
  return cursor === undefined && !hasPresentedFrame;
}

export function terminalNormalizeProposedSize(
  size: { cols: number; rows: number } | undefined,
): { cols: number; rows: number } | undefined {
  if (!size) return undefined;
  return {
    cols: Math.max(20, Math.min(500, size.cols)),
    rows: Math.max(5, Math.min(300, size.rows)),
  };
}

export function terminalProposedSizeDiffers(
  cols: number,
  rows: number,
  size: { cols: number; rows: number } | undefined,
): boolean {
  const next = terminalNormalizeProposedSize(size);
  return Boolean(next && (next.cols !== cols || next.rows !== rows));
}

export function fitTerminalViewport(
  terminal: Pick<Terminal, "cols" | "rows">,
  fit: Pick<FitAddon, "fit" | "proposeDimensions">,
  state: { events: boolean; connected: boolean; readOnly: boolean; replaying: boolean; stable: boolean },
  resize: (size: { cols: number; rows: number }) => void,
): void {
  if (state.replaying || !state.stable) return;
  // Only daemon resize events may reflow an event-mode terminal.
  if (state.events) {
    if (!state.connected || state.readOnly) return;
    const next = terminalNormalizeProposedSize(fit.proposeDimensions());
    if (next && terminalProposedSizeDiffers(terminal.cols, terminal.rows, next)) resize(next);
  } else {
    fit.fit();
    if (state.connected && !state.readOnly) resize({ cols: terminal.cols, rows: terminal.rows });
  }
}

export function openTerminalExternalUrl(event: MouseEvent, uri: string): boolean {
  event.preventDefault();
  const url = normalizeExternalUrl(uri);
  if (!url) return false;
  void window.prospero.openExternal(url);
  return true;
}

export function TerminalPane({ session, fontFamily, fontSize, active = true, localSelection = true, onMissingSession }: { session: SessionInfo; fontFamily: string; fontSize: number; active?: boolean; localSelection?: boolean; onMissingSession?: (id: string) => void }) {
  const { t } = useLocale();
  const tRef = useRef(t);
  tRef.current = t;
  const sessionStatusRef = useRef(session.status);
  sessionStatusRef.current = session.status;
  const readingStateRef = useRef(readTerminalReadingState(session.id));
  const isMac = navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.includes("Macintosh");
  const shortcutHint = isMac
    ? t("拖动选中（应用交互模式下按住 ⌥） · ⌘C/⌘V 复制粘贴 · ⌘F 查找 · ⌘K 清屏", "Drag to select (hold ⌥ in application mode) · ⌘C/⌘V copy and paste · ⌘F find · ⌘K clear")
    : t("Ctrl+Shift+C/V 复制粘贴 · Ctrl+Shift+F 查找 · Shift+Insert 粘贴", "Ctrl+Shift+C/V copy and paste · Ctrl+Shift+F find · Shift+Insert paste");
  const localSelectionRef = useRef(localSelection);
  localSelectionRef.current = localSelection;
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const searchRef = useRef<SearchAddon | undefined>(undefined);
  const serializeRef = useRef<SerializeAddon | undefined>(undefined);
  const cursorRef = useRef<number | undefined>(undefined);
  const writeChain = useRef(Promise.resolve());
  const restoreReadyRef = useRef(Promise.resolve());
  const interactionQueue = useRef(new TerminalInputQueue());
  const streamControllerRef = useRef<TerminalStreamController | undefined>(undefined);
  const pollGenerationRef = useRef(0);
  const stableBufferRef = useRef(true);
  const replayingRef = useRef(false);
  const suppressInputScrollRef = useRef(false);
  const connectedRef = useRef(false);
  const exitedRef = useRef(false);
  const needsFitRef = useRef(true);
  const hasPresentedFrameRef = useRef(false);
  const readingRestoredRef = useRef(false);
  const resizeCoordinatorRef = useRef(new TerminalResizeCoordinator());
  const [streamMode, setStreamMode] = useState<"pending" | "stream" | "legacy">("pending");
  const streamModeRef = useRef(streamMode);
  streamModeRef.current = streamMode;
  const [streamState, setStreamState] = useState<TerminalStreamState>({ connected: false, syncing: true, readOnly: false, exited: false, controller: false });
  const streamStateRef = useRef(streamState);
  streamStateRef.current = streamState;
  const epochRef = useRef<string | undefined>(undefined);
  const [streamReconnectNonce, setStreamReconnectNonce] = useState(0);
  const [requiresFreshReload, setRequiresFreshReload] = useState(false);
  const readOnly = terminalSessionIsReadOnly(session.status) || (streamMode === "stream" && streamState.readOnly);
  const sessionEnded = terminalSessionIsReadOnly(session.status) || (streamMode === "stream" && streamState.exited);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly || exitedRef.current || (streamMode === "stream" && !terminalStreamCanControl(streamState, session.status));
  const activeRef = useRef(active);
  activeRef.current = active;
  const [operationError, setOperationError] = useState<string>();
  const [connectionError, setConnectionError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [hasPresentedFrame, setHasPresentedFrame] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [bell, setBell] = useState(false);
  const [findOpen, setFindOpen] = useState(() => Boolean(readingStateRef.current.find));
  const [findText, setFindText] = useState(() => readingStateRef.current.find);
  const findInputRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const historyNoticeRef = useRef(false);
  const queueInteraction = useCallback((message: TerminalInteraction, accepted = false): Promise<boolean> => {
    // Choose transport at admission. A queued stream write must never become a
    // legacy HTTP write merely because the pane unmounted or reattached.
    const admittedMode = streamModeRef.current;
    const admittedStream = streamControllerRef.current;
    const result = interactionQueue.current
      .enqueue(async () => {
        if (!canDeliverTerminalInteraction(connectedRef.current, readOnlyRef.current, accepted)) return false;
        if (admittedMode === "stream") {
          if (!admittedStream || streamControllerRef.current !== admittedStream) throw new Error("Terminal stream attachment changed before interaction was sent");
          if (message.type === "term.input") await admittedStream.input(terminalBytes(message.dataB64));
          else await admittedStream.resize(message.cols, message.rows);
        } else if (admittedMode === "legacy") await window.prospero.interact(session.id, message);
        else return false;
        setOperationError(undefined);
        return true;
      }, message.type === "term.input" ? Math.ceil(message.dataB64.length * 3 / 4) : 0)
      .catch((reason): false => {
        if (isMissingSessionError(reason)) {
          onMissingSession?.(session.id);
          return false;
        }
        // Stream connection state is owned by controller callbacks. An input
        // Result rejection says nothing about whether output is still live.
        if (admittedMode === "legacy") {
          connectedRef.current = false;
          if (terminalRef.current) terminalRef.current.options.disableStdin = true;
          setConnected(false);
          setSyncing(false);
        }
        setOperationError(reportError(reason));
        return false;
      });
    return result;
  }, [onMissingSession, session.id]);
  const fitToHost = useCallback((): void => {
    const terminal = terminalRef.current; const fit = fitRef.current;
    const element = host.current;
    if (!terminal || !fit || !activeRef.current || !element?.isConnected || element.clientWidth === 0 || element.clientHeight === 0) return;
    // Observers preserve the host's grid exactly. They neither fit locally nor
    // emit a ResizeRequest; only a controller may change live PTY geometry.
    if (session.terminalMode === "events" && streamModeRef.current !== "legacy" && !streamStateRef.current.exited && !terminalStreamCanControl(streamStateRef.current, sessionStatusRef.current)) return;
    const proposed = terminalNormalizeProposedSize(fit.proposeDimensions());
    if (proposed && !stableBufferRef.current) {
      resizeCoordinatorRef.current.request(
        proposed,
        false,
        false,
        () => undefined,
        size => terminal.resize(size.cols, size.rows),
      );
      return;
    }
    // An exited PTY cannot accept a daemon resize, but its local viewport can
    // still adapt when the dock or font changes.
    if (readOnlyRef.current) {
      const prior = suppressInputScrollRef.current;
      suppressInputScrollRef.current = true;
      try {
        resizeCoordinatorRef.current.flush(false, () => undefined, size => terminal.resize(size.cols, size.rows));
        fit.fit();
      } finally { suppressInputScrollRef.current = prior; }
      return;
    }
    const prior = suppressInputScrollRef.current;
    suppressInputScrollRef.current = true;
    try {
      fitTerminalViewport(terminal, fit, {
        events: session.terminalMode === "events", connected: connectedRef.current,
        readOnly: readOnlyRef.current, replaying: replayingRef.current, stable: stableBufferRef.current,
      }, size => resizeCoordinatorRef.current.request(
        size,
        stableBufferRef.current,
        connectedRef.current && !readOnlyRef.current,
        next => queueInteraction({ type: "term.resize", ...next }),
        next => terminal.resize(next.cols, next.rows),
      ));
    } finally { suppressInputScrollRef.current = prior; }
  }, [queueInteraction, session.terminalMode]);
  const restoreReadingState = useCallback((terminal: Terminal): void => {
    const state = readingStateRef.current;
    const smooth = terminal.options.smoothScrollDuration;
    terminal.options.smoothScrollDuration = 0;
    try {
      if (state.followBottom) terminal.scrollToBottom();
      else terminal.scrollToLine(state.viewport);
    } finally { if (smooth !== undefined) terminal.options.smoothScrollDuration = smooth; }
  }, []);
  /// 提示统一走这里:直接 setNotice 的话没有定时清除,那条提示会一直挂在屏幕上。
  const showNotice = useCallback((message: string): void => {
    setNotice(message);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(undefined), 1_250);
  }, []);

  useEffect(() => {
    if (!host.current) return;
    const cached = session.terminalMode === "events" ? undefined : loadTerminalSessionCache(session.id);
    exitedRef.current = false;
    hasPresentedFrameRef.current = false;
    needsFitRef.current = true;
    const terminal = new Terminal({
      ...(cached ? { cols: cached.cols, rows: cached.rows } : {}),
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      fontFamily: terminalFontFamilyWithFallbacks(fontFamily),
      fontSize,
      fontWeight: "400",
      fontWeightBold: "700",
      lineHeight: TERMINAL_LINE_HEIGHT,
      letterSpacing: 0,
      scrollback: 10_000,
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
      scrollOnUserInput: false,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: openTerminalExternalUrl,
      },
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
    configureRustTerminalUnicode(terminal);
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const search = new SearchAddon();
    terminal.loadAddon(search);
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    serializeRef.current = serialize;
    // URL 可点。在 Electron 里必须显式交给系统浏览器打开 —— 渲染进程的
    // will-navigate 是被拦掉的,直接跳转只会是一个什么都不发生的点击。
    terminal.loadAddon(new WebLinksAddon(openTerminalExternalUrl, { urlRegex: EXTERNAL_URL_REGEX }));
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;
    terminal.open(host.current);
    // WebGL is substantially cheaper for long scrollback. If the GPU context
    // disappears (driver reset, suspend, remote desktop), xterm's DOM renderer
    // remains the reliable fallback.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      terminal.loadAddon(webgl);
      webgl.onContextLoss(() => { webgl?.dispose(); webgl = undefined; });
    } catch {
      webgl?.dispose();
      webgl = undefined;
    }
    const disposeDaemonQueries = session.terminalMode === "events"
      ? suppressDaemonTerminalQueries(terminal.parser)
      : () => {};
    const scrollDisposable = terminal.onScroll(() => {
      if (!readingRestoredRef.current || replayingRef.current || suppressInputScrollRef.current) return;
      const viewport = terminal.buffer.active.viewportY;
      const followBottom = viewport >= terminal.buffer.active.baseY;
      readingStateRef.current = saveTerminalReadingState(session.id, { viewport, followBottom });
    });
    const mouseHost = host.current;
    const selectLocally = (event: MouseEvent) => preferLocalTerminalSelection(event, isMac, localSelectionRef.current, terminal.modes.mouseTrackingMode);
    mouseHost.addEventListener("mousedown", selectLocally, true);
    const fitVisibleSoon = (): void => {
      window.requestAnimationFrame(() => {
        if (terminalRef.current !== terminal) return;
        fitToHost();
        if (host.current?.getClientRects().length && activeRef.current) terminal.focus();
      });
    };
    if (cached) {
      cursorRef.current = terminalBootstrapCursor(cached.cursor);
      replayingRef.current = true;
      stableBufferRef.current = false;
      restoreReadyRef.current = new Promise<void>((done) => {
        terminal.write(cached.serialized, () => {
            if (terminalRef.current === terminal) {
            replayingRef.current = false;
            stableBufferRef.current = true;
            restoreReadingState(terminal);
            readingRestoredRef.current = true;
            setSyncing(true);
            fitToHost();
            fitVisibleSoon();
          }
          done();
        });
      });
    } else {
      cursorRef.current = session.terminalMode === "events" ? undefined : terminalBootstrapCursor();
      stableBufferRef.current = false;
      setSyncing(true);
      restoreReadyRef.current = Promise.resolve();
    }
    if (!cached) {
      fitToHost();
      fitVisibleSoon();
    }

    let bellTimer: number | undefined;
    const scrollForUserInput = (): void => {
      if (!activeRef.current || !connectedRef.current || readOnlyRef.current || replayingRef.current) return;
      readingStateRef.current = saveTerminalReadingState(session.id, { viewport: terminal.buffer.active.baseY, followBottom: true });
      terminal.scrollToBottom();
    };
    // IME commits do not necessarily emit onKey. These events originate in
    // the input textarea, unlike onData which also carries parser replies.
    mouseHost.addEventListener("input", scrollForUserInput, true);
    mouseHost.addEventListener("compositionend", scrollForUserInput, true);
    const inputBuffer = new TerminalInputBuffer(value => queueInteraction({ type: "term.input", dataB64: toBase64(value) }, true));
    const queueInputText = (value: string): Promise<boolean> => {
      if (!activeRef.current || !canDeliverTerminalInteraction(connectedRef.current, readOnlyRef.current)) return Promise.resolve(false);
      scrollForUserInput();
      void inputBuffer.flush();
      return queueInteraction({ type: "term.input", dataB64: toBase64(value) }, true);
    };
    const inputDisposable = terminal.onData((value) => {
      if (replayingRef.current || !activeRef.current || !connectedRef.current) return;
      inputBuffer.append(value);
    });
    const canPaste = (): boolean => activeRef.current && connectedRef.current && !readOnlyRef.current && !replayingRef.current && terminalRef.current === terminal && !terminal.options.disableStdin;
    const pasteBlocked = (): void => showNotice(readOnlyRef.current
      ? t("会话已结束，终端为只读", "The session has ended; the terminal is read-only")
      : t("终端尚未就绪，请连接后再粘贴", "The terminal is not ready; paste after connecting"));
    const pasteNonText = (): void => showNotice(t("终端只支持粘贴纯文本", "The terminal only accepts plain text paste"));
    const disposePaste = bindTerminalPaste(host.current, terminal, canPaste, pasteBlocked, () => {
      setOperationError(undefined);
      scrollForUserInput();
      void inputBuffer.flush();
    }, pasteNonText);
    const keyDisposable = terminal.onKey(scrollForUserInput);
    terminal.attachCustomKeyEventHandler((event) => {
      const action = terminalShortcutAction(event, isMac);
      if (action === "paste") {
        const allowed = canPaste();
        if (!allowed) pasteBlocked();
        return allowNativeTerminalPaste(event, allowed);
      }
      if (action) consumeTerminalKey(event);
      if (readOnlyRef.current && action && action !== "copy" && action !== "selectAll" && action !== "find") {
        showNotice(t("会话已结束，终端为只读", "The session has ended; the terminal is read-only"));
        return false;
      }
      if (action === "copy") {
        const selection = terminal.getSelection();
        if (selection) {
          void window.prospero.writeClipboard(selection)
            .then(() => showNotice(t("已复制", "Copied")))
            .catch((reason) => setOperationError(reportError(reason)));
        } else showNotice(localSelectionRef.current ? t("拖动选择文本后再复制", "Drag to select text before copying") : isMac ? t("按住 ⌥ 拖动选择文本", "Hold Option while dragging to select text") : t("按住 Shift 拖动选择文本", "Hold Shift while dragging to select text"));
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
        void queueInputText("\x0c");
        showNotice(t("已清屏", "Terminal cleared"));
        return false;
      }
      if (action === "beginningOfLine") { void queueInputText("\x01"); return false; }
      if (action === "endOfLine") { void queueInputText("\x05"); return false; }
      if (action === "deleteToBeginning") { void queueInputText("\x15"); return false; }
      if (action === "deleteToEnd") { void queueInputText("\x0b"); return false; }
      if (action === "backwardWord") { void queueInputText("\x1bb"); return false; }
      if (action === "forwardWord") { void queueInputText("\x1bf"); return false; }
      return true;
    });
    const osc52Disposable = terminal.parser.registerOscHandler(52, (data) => {
      if (replayingRef.current || !connectedRef.current || !activeRef.current) return true;
      const separator = data.indexOf(";");
      if (separator < 0) return false;
      const payload = data.slice(separator + 1);
      if (payload === "?" || payload.length > 8 * 1024 * 1024) return true;
      try {
        const text = fromBase64(payload);
        if (text) void window.prospero.writeClipboard(text).then(() => showNotice(t("终端已复制到剪贴板", "Terminal copied to clipboard"))).catch((reason) => setOperationError(reportError(reason)));
      } catch {
        showNotice(t("无法读取终端剪贴板内容", "Unable to read terminal clipboard data"));
      }
      return true;
    });
    const bellDisposable = terminal.onBell(() => {
      if (replayingRef.current || !connectedRef.current || !activeRef.current) return;
      setBell(true);
      window.clearTimeout(bellTimer);
      bellTimer = window.setTimeout(() => setBell(false), 170);
    });
    let lastWheelRefit = 0;
    terminal.attachCustomWheelEventHandler(() => {
      // tmux mouse scroll depends on the browser terminal dimensions matching
      // the attached tmux pane. Some Electron layouts can settle without a
      // ResizeObserver tick; users noticed wheel scroll returning only after
      // Cmd+Shift+F changed the dock size. Probe on wheel and perform the same
      // fit path opportunistically before xterm translates the wheel event.
      if (!replayingRef.current && host.current?.getClientRects().length) {
        const now = performance.now();
        if (now - lastWheelRefit > 250 && terminalProposedSizeDiffers(terminal.cols, terminal.rows, fit.proposeDimensions())) {
          lastWheelRefit = now;
          fitToHost();
        }
      }
      return true;
    });

    let resizeTimer: number | undefined;
    const resize = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const element = host.current;
        if (replayingRef.current || !element?.isConnected || element.clientWidth === 0 || element.clientHeight === 0) return;
        fitToHost();
      }, 80);
    });
    resize.observe(host.current);
    const refitOnFocus = (): void => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (terminalRef.current !== terminal || replayingRef.current) return;
        fitToHost();
      }, 80);
    };
    window.addEventListener("focus", refitOnFocus);
    document.addEventListener("visibilitychange", refitOnFocus);

    return () => {
      window.clearTimeout(resizeTimer);
      window.clearTimeout(noticeTimerRef.current);
      window.clearTimeout(bellTimer);
      const cursor = cursorRef.current;
      if (session.terminalMode !== "events" && stableBufferRef.current && cursor !== undefined) {
        try {
          persistTerminalSession(session.id, terminal, serialize, cursor);
        } catch {}
      }
      void inputBuffer.flush();
      resize.disconnect();
      window.removeEventListener("focus", refitOnFocus);
      document.removeEventListener("visibilitychange", refitOnFocus);
      inputDisposable.dispose();
      keyDisposable.dispose();
      scrollDisposable.dispose();
      disposePaste();
      disposeDaemonQueries();
      osc52Disposable.dispose();
      bellDisposable.dispose();
      mouseHost.removeEventListener("mousedown", selectLocally, true);
      mouseHost.removeEventListener("input", scrollForUserInput, true);
      mouseHost.removeEventListener("compositionend", scrollForUserInput, true);
      terminal.dispose();
      resizeCoordinatorRef.current.clear();
      connectedRef.current = false;
      stableBufferRef.current = false;
      restoreReadyRef.current = Promise.resolve();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      serializeRef.current = undefined;
      cursorRef.current = undefined;
    };
  }, [isMac, queueInteraction, showNotice, fitToHost, restoreReadingState]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.disableStdin = !activeRef.current || readOnlyRef.current || !connectedRef.current;
  }, [readOnly]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.disableStdin = !active || readOnlyRef.current || !connectedRef.current;
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      if (!terminal || !host.current?.getClientRects().length) return;
      fitToHost();
      // Repaint retained canvas cells after making a background view visible.
      terminal.refresh(0, terminal.rows - 1);
      terminal.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, fitToHost]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    let active = true;
    terminal.options.fontFamily = terminalFontFamilyWithFallbacks(fontFamily);
    terminal.options.fontSize = fontSize;
    const fit = (): void => {
      if (!active || !host.current?.getClientRects().length) return;
      fitToHost();
    };
    const requestedFont = fontFamily.trim();
    const fontReady = requestedFont && document.fonts?.load
      ? document.fonts.load(`${String(fontSize)}px ${requestedFont.split(",")[0] ?? requestedFont}`).then(() => undefined, () => undefined)
      : Promise.resolve();
    void Promise.all([restoreReadyRef.current, fontReady]).then(fit);
    return () => {
      active = false;
    };
  }, [fontFamily, fontSize, fitToHost]);

  useEffect(() => {
    // Ended sessions have no live host to attach to. This is an explicit
    // static-history route selected from session metadata, never a fallback
    // after a stream error.
    if (session.terminalMode !== "events" || terminalSessionIsReadOnly(session.status)) { setStreamMode("legacy"); return; }
    let alive = true;
    const requestId = crypto.randomUUID();
    const applyState = (state: TerminalStreamState): void => {
      if (!alive) return;
      const wasSyncing = streamStateRef.current.syncing;
      const wasController = streamStateRef.current.controller;
      streamStateRef.current = state;
      if (state.epoch) epochRef.current = state.epoch;
      connectedRef.current = state.connected;
      exitedRef.current = state.exited;
      readOnlyRef.current = !terminalStreamCanControl(state, sessionStatusRef.current);
      const terminal = terminalRef.current;
      if (terminal) terminal.options.disableStdin = !activeRef.current || !state.connected || state.syncing || !state.controller || readOnlyRef.current;
      setConnected(state.connected);
      setSyncing(state.syncing);
      setStreamState(state);
      if ((wasSyncing || !wasController) && terminalStreamCanControl(state, sessionStatusRef.current)) {
        fitToHost();
        const settled = terminalRef.current;
        if (settled) resizeCoordinatorRef.current.flush(
          terminalStreamCanControl(state, sessionStatusRef.current),
          size => queueInteraction({ type: "term.resize", ...size }),
          size => settled.resize(size.cols, size.rows),
        );
        needsFitRef.current = false;
      }
    };
    const controller = new TerminalStreamController({
      sessionId: session.id,
      cursor: () => cursorRef.current,
      epoch: () => epochRef.current,
      wantControl: true,
      onState: applyState,
      onHello: ({ cols, rows }) => {
        const terminal = terminalRef.current;
        // Hello dimensions bootstrap an empty cold screen only. A resume may
        // already show retained cells; changing its geometry here would reflow
        // those cells before the authoritative ordered Resize frame arrives.
        if (terminal && terminalShouldApplyHelloDimensions(cursorRef.current, hasPresentedFrameRef.current) && (terminal.cols !== cols || terminal.rows !== rows)) terminal.resize(cols, rows);
      },
      consume: async (frame: TerminalStreamFrame) => {
        // Stream attachments and a just-retired attachment share this chain.
        // xterm writes are asynchronous; serializing them prevents a fresh
        // snapshot/reset from racing a prior frame's completion callback.
        const prior = writeChain.current;
        const work = prior.then(async () => {
        const terminal = terminalRef.current;
        if (!terminal) throw new Error("Terminal was detached during stream write");
        stableBufferRef.current = false;
        suppressInputScrollRef.current = true;
        try {
          if (frame.kind === TerminalStreamKind.Resize) {
            if (frame.payload.byteLength !== 4) throw new Error("Invalid terminal resize frame");
            const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
            terminal.resize(view.getUint16(0, false), view.getUint16(2, false));
          } else {
            if (frame.kind === TerminalStreamKind.Snapshot) { replayingRef.current = true; terminal.reset(); }
            await new Promise<void>(done => terminal.write(frame.payload, done));
            if (readingRestoredRef.current) restoreReadingState(terminal);
            if (frame.kind === TerminalStreamKind.Snapshot) replayingRef.current = false;
          }
          cursorRef.current = frame.sequence;
          hasPresentedFrameRef.current = true;
          setHasPresentedFrame(true);
          stableBufferRef.current = true;
          if (!readingRestoredRef.current) { restoreReadingState(terminal); readingRestoredRef.current = true; }
        } finally { suppressInputScrollRef.current = false; }
        });
        writeChain.current = work.catch(() => undefined);
        await work;
      },
      onError: (message, _recoverable) => { if (alive) setConnectionError(message); },
      onHistoryGap: message => { if (alive) { setConnectionError(message); setSyncing(false); setRequiresFreshReload(true); } },
    });
    streamControllerRef.current = controller;
    const receivePort = (event: MessageEvent): void => {
      const value = event.data as { type?: unknown; requestId?: unknown } | undefined;
      if (event.source !== window || value?.type !== "terminal:port" || value.requestId !== requestId || !event.ports[0]) return;
      const port = event.ports[0];
      // Do not snapshot the resume cursor until an earlier attachment's xterm
      // write has committed. Otherwise its late callback could advance the
      // screen after this Attach has already requested replay.
      void writeChain.current.then(() => {
        if (alive && streamControllerRef.current === controller) {
          streamModeRef.current = "stream";
          setStreamMode("stream");
          controller.attach(port);
        }
        else port.close();
      });
    };
    window.addEventListener("message", receivePort);
    void window.prospero.openTerminalStream(session.id, requestId).then(result => {
      if (!alive) return;
      if (!result.supported) { controller.close(); streamControllerRef.current = undefined; setStreamMode("legacy"); }
      else setStreamMode("stream");
    }).catch(reason => { if (alive) { setConnectionError(displayError(reason)); setStreamMode("stream"); } });
    return () => {
      alive = false;
      window.removeEventListener("message", receivePort);
      controller.close();
      if (streamControllerRef.current === controller) streamControllerRef.current = undefined;
    };
  // A new attachment is authoritative; it must never resume from renderer cache.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.terminalMode, streamReconnectNonce]);

  useEffect(() => {
    if (streamMode !== "legacy") return;
    let active = true;
    let waitForOutput = false;
    let cachedState: string | undefined;
    const generation = ++pollGenerationRef.current;
    const isCurrent = (): boolean => active && pollGenerationRef.current === generation;
    const cache = scheduleTerminalCache(document, () => {
      if (!isCurrent()) return true;
      if (!stableBufferRef.current) return false;
      const terminal = terminalRef.current;
      const serialize = serializeRef.current;
      const cursor = cursorRef.current;
      if (!terminal || !serialize || cursor === undefined) return true;
      const state = `${cursor}:${terminal.cols}:${terminal.rows}`;
      if (cachedState === state) return true;
      try {
        if (persistTerminalSession(session.id, terminal, serialize, cursor)) {
          cachedState = state;
          return true;
        }
      } catch {}
      return false;
    });
    const scheduleCache = (): void => {
      if (session.terminalMode !== "events") cache.schedule();
    };
    setOperationError(undefined);
    setConnectionError(undefined);
    setSyncing(true);
    const poll = async (): Promise<void> => {
      await restoreReadyRef.current;
      // A previous poll may still have an xterm write callback in flight.
      // Drain it before a new snapshot can reset the same terminal.
      await writeChain.current.catch(() => undefined);
      if (!isCurrent()) return;
      writeChain.current = Promise.resolve();
      while (isCurrent()) {
        try {
          const startedAt = performance.now();
          const cursor = cursorRef.current;
          const frame = await window.prospero.getSessionView(session.id, cursor === undefined ? {} : { outputAfterSeq: cursor, ...(waitForOutput ? { waitMs: 20_000 } : {}) });
          if (!isCurrent()) break;
          waitForOutput = true;
          if (!frame) {
            if (cursor !== undefined) {
              connectedRef.current = true;
              stableBufferRef.current = true;
              const settled = terminalRef.current;
              if (settled) resizeCoordinatorRef.current.flush(
                !readOnlyRef.current,
                size => queueInteraction({ type: "term.resize", ...size }),
                size => settled.resize(size.cols, size.rows),
              );
              if (needsFitRef.current) { fitToHost(); needsFitRef.current = false; }
              if (terminalRef.current) terminalRef.current.options.disableStdin = !activeRef.current || readOnlyRef.current;
              setConnected(true);
              setSyncing(false);
              setConnectionError(undefined);
            }
            const delay = getTerminalEmptyFrameDelay(performance.now() - startedAt, session.terminalMode === "events");
            if (delay) await new Promise((wait) => window.setTimeout(wait, delay));
            continue;
          }
          if (text(frame["kind"]) !== "pty") throw new Error(tRef.current("daemon 返回了错误的会话类型", "The daemon returned the wrong session type"));
          const mode = text(frame["mode"], "snapshot");
          const seq = number(frame["seq"]);
          const historyTruncated = frame["historyTruncated"] === true;
          if (historyTruncated && !historyNoticeRef.current) {
            historyNoticeRef.current = true;
            showNotice(tRef.current("更早的终端历史已被裁剪，已从当前保留位置恢复", "Earlier terminal history was truncated; restored from the retained output"));
          }
          if (frame["exited"] === true) { exitedRef.current = true; readOnlyRef.current = true; }
          const bootstrapDelta = mode === "delta" && cursorRef.current === 0 && number(frame["baseSeq"], -1) === 0;
          if (mode === "events") {
            if (!historyTruncated && number(frame["baseSeq"], -1) !== (cursorRef.current ?? 0)) { cursorRef.current = undefined; continue; }
            if (historyTruncated) deleteTerminalSessionCache(session.id);
            const target = terminalRef.current;
            stableBufferRef.current = false;
            const bootstrap = cursor === undefined || historyTruncated;
            writeChain.current = writeChain.current.then(async () => {
              if (!isCurrent() || !target || terminalRef.current !== target) return;
              suppressInputScrollRef.current = true;
              try {
                if (bootstrap) { replayingRef.current = true; target.reset(); target.resize(number(frame["cols"], 120), number(frame["rows"], 40)); }
                await writeTerminalEvents(target, frame["events"], isCurrent);
                if (readingRestoredRef.current) restoreReadingState(target);
              }
              finally { suppressInputScrollRef.current = false; }
              if (frame["caughtUp"] !== false) replayingRef.current = false;
            });
          } else if (mode === "delta") {
            if (number(frame["baseSeq"], -1) !== cursorRef.current) {
              deleteTerminalSessionCache(session.id);
              cursorRef.current = undefined;
              connectedRef.current = false;
              if (terminalRef.current) terminalRef.current.options.disableStdin = true;
              setConnected(false);
              continue;
            }
            const output = terminalBytes(text(frame["dataB64"]));
            const target = terminalRef.current;
            stableBufferRef.current = false;
            writeChain.current = writeChain.current.then(() => new Promise<void>((done) => {
              if (!isCurrent() || !target || terminalRef.current !== target) { done(); return; }
              if (bootstrapDelta) {
                target.resize(
                  Math.max(20, number(frame["cols"], target.cols)),
                  Math.max(5, number(frame["rows"], target.rows)),
                );
              }
              suppressInputScrollRef.current = true;
              target.write(output, () => {
                if (readingRestoredRef.current) restoreReadingState(target);
                suppressInputScrollRef.current = false;
                done();
              });
            }));
          } else {
            deleteTerminalSessionCache(session.id);
            const ansi = typeof frame["dataB64"] === "string" ? terminalBytes(frame["dataB64"]) : text(frame["ansi"]);
            const target = terminalRef.current;
            stableBufferRef.current = false;
            writeChain.current = writeChain.current.then(() => new Promise<void>((done) => {
              if (!isCurrent() || !target || terminalRef.current !== target) { done(); return; }
              suppressInputScrollRef.current = true;
              replayingRef.current = true;
              target.reset();
              target.resize(Math.max(20, number(frame["cols"], 120)), Math.max(5, number(frame["rows"], 40)));
              target.write(ansi, () => {
                if (readingRestoredRef.current) restoreReadingState(target);
                suppressInputScrollRef.current = false;
                if (isCurrent()) replayingRef.current = false;
                done();
              });
            }));
          }
          await writeChain.current;
          if (!isCurrent()) break;
          cursorRef.current = seq;
          stableBufferRef.current = true;
          connectedRef.current = frame["caughtUp"] !== false;
          const settled = terminalRef.current;
          if (settled) resizeCoordinatorRef.current.flush(
            connectedRef.current && !readOnlyRef.current,
            size => queueInteraction({ type: "term.resize", ...size }),
            size => settled.resize(size.cols, size.rows),
          );
          scheduleCache();
          const current = terminalRef.current;
          if (current) {
            if (!readingRestoredRef.current && connectedRef.current) {
              restoreReadingState(current);
              readingRestoredRef.current = true;
            }
            current.options.disableStdin = !activeRef.current || readOnlyRef.current || !connectedRef.current;
            if ((mode === "snapshot" || bootstrapDelta || needsFitRef.current) && connectedRef.current && host.current?.getClientRects().length) {
              fitToHost();
              needsFitRef.current = false;
            }
          }
          setConnected(connectedRef.current);
          if (connectedRef.current) setHasPresentedFrame(true);
          setSyncing(!connectedRef.current);
          setConnectionError(undefined);
          if (frame["exited"] === true && frame["caughtUp"] !== false) break;
        } catch (reason) {
          if (!isCurrent()) break;
          if (isMissingSessionError(reason)) {
            onMissingSession?.(session.id);
            break;
          }
          waitForOutput = false;
          connectedRef.current = false;
          if (terminalRef.current) terminalRef.current.options.disableStdin = true;
          setConnected(false);
          setSyncing(false);
          const message = displayError(reason);
          setConnectionError(message);
          if (isUnrecoverableTerminalError(reason)) break;
          await new Promise((wait) => window.setTimeout(wait, 900));
        }
      }
    };
    void poll();
    return () => {
      active = false;
      // The cursor commits only after a whole page. A partially applied page
      // cannot be resumed from its old cursor without duplicating its prefix.
      if (!stableBufferRef.current) cursorRef.current = undefined;
      needsFitRef.current = true;
      cache.dispose();
      if (pollGenerationRef.current === generation) pollGenerationRef.current += 1;
      connectedRef.current = false;
      replayingRef.current = false;
      if (terminalRef.current) terminalRef.current.options.disableStdin = true;
      void window.prospero.cancelSessionView(session.id).catch(() => undefined);
    };
  }, [onMissingSession, queueInteraction, session.id, fitToHost, restoreReadingState, streamMode]);

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
  const acquireControl = (takeover: boolean): void => {
    void streamControllerRef.current?.acquire(takeover).then(() => setOperationError(undefined)).catch(reason => setOperationError(reportError(reason)));
  };
  const releaseControl = (): void => {
    void streamControllerRef.current?.release().then(() => setOperationError(undefined)).catch(reason => setOperationError(reportError(reason)));
  };
  const reconnectStream = (): void => {
    if (requiresFreshReload) {
      // A history gap or epoch change has no safe renderer-side continuation.
      // The user explicitly chooses a fresh host snapshot; unknown input stays
      // rejected by the old attachment and is never sent again.
      void writeChain.current.then(() => {
        cursorRef.current = undefined;
        epochRef.current = undefined;
        hasPresentedFrameRef.current = false;
        terminalRef.current?.reset();
        setHasPresentedFrame(false);
        setRequiresFreshReload(false);
        setConnectionError(undefined);
        setStreamReconnectNonce(value => value + 1);
      });
      return;
    }
    setConnectionError(undefined);
    setStreamReconnectNonce(value => value + 1);
  };

  return <div className={bell ? "terminal-shell terminal-bell" : "terminal-shell"}>
    <div className={connected && !readOnly && streamMode === "legacy" ? "terminal-status is-quiet" : "terminal-status"} role="status" aria-live="polite"><span className={sessionEnded ? "live-dot offline" : connected ? "live-dot" : syncing ? "live-dot syncing" : "live-dot offline"} />{sessionEnded ? t("会话已结束 · 只读", "Session ended · Read only") : streamMode === "stream" && connected && !streamState.controller ? t("正在观察 · 只读", "Observing · Read only") : connected ? t("实时终端", "Live terminal") : syncing ? t("正在同步", "Syncing") : t("流已断开", "Stream disconnected")}<span className="terminal-shortcut" title={shortcutHint}>{isMac ? "⌘C / ⌘V" : "Ctrl+Shift+C / V"}</span>{streamMode === "stream" && !sessionEnded && <span className="terminal-control">{!connected ? <button type="button" onClick={reconnectStream}>{requiresFreshReload ? t("重新载入画面", "Reload screen") : t("重新连接", "Reconnect")}</button> : streamState.controller ? <button type="button" onClick={releaseControl}>{t("释放控制", "Release control")}</button> : <><button type="button" onClick={() => acquireControl(false)}>{t("请求控制", "Request control")}</button><button type="button" onClick={() => acquireControl(true)}>{t("接管", "Take over")}</button></>}</span>}</div>
    {findOpen && <div className="terminal-find">
      <input
        ref={findInputRef}
        autoFocus
        value={findText}
        placeholder={t("在终端中查找", "Find in terminal")}
        onChange={(event) => {
          const value = event.target.value;
          setFindText(value);
          readingStateRef.current = saveTerminalReadingState(session.id, { find: value });
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") { event.preventDefault(); closeFind(); return; }
          if (event.key === "Enter") { event.preventDefault(); runFind(event.shiftKey); }
        }}
      />
      <button type="button" onClick={() => runFind(true)} aria-label={t("上一个", "Previous")}>↑</button>
      <button type="button" onClick={() => runFind(false)} aria-label={t("下一个", "Next")}>↓</button>
      <button type="button" onClick={closeFind} aria-label={t("关闭查找", "Close find")}>✕</button>
    </div>}
    <div ref={host} className="terminal-host" style={{ visibility: syncing && !hasPresentedFrame ? "hidden" : undefined }} aria-busy={syncing} onContextMenu={event => {
      event.preventDefault();
      const terminal = terminalRef.current;
      if (terminal) void window.prospero.openTerminalContextMenu({ copy: terminal.hasSelection(), paste: connectedRef.current && !readOnlyRef.current && !replayingRef.current && !terminal.options.disableStdin }).catch(reason => setOperationError(reportError(reason)));
    }} />
    {notice && <div className="terminal-toast" role="status">{notice}</div>}
    {connectionError && <div className="inline-error">{connectionError}</div>}
    {operationError && <div className="inline-error">{operationError}</div>}
  </div>;
}
