import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { NativeTerminalState, SessionInfo } from "../../shared/types";
import { useLocale } from "./locale";
import { notify } from "./notifications/notifications";
import { displayError } from "./state";
import { terminalAgentImageReference } from "./terminal-agent-input";
const TerminalPane = lazy(() => import("./TerminalPane").then(module => ({ default: module.TerminalPane })));
const READ_ONLY_TERMINAL_STATUSES = new Set(["idle", "completed", "done", "died", "failed", "stopped", "cancelled", "exited", "killed"]);

export function supportsNativeTerminal(session: SessionInfo): boolean {
  return window.prospero.platform === "darwin" && session.kind === "pty" && session.terminalMode === "events" && !READ_ONLY_TERMINAL_STATUSES.has(session.status);
}

function overlayCovers(rect: DOMRect): boolean {
  const selectors = [
    '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]', '[role="tooltip"]',
    '[data-slot="sheet-overlay"]', '[data-slot="dialog-overlay"]', '[data-slot="popover-content"]',
    '[data-slot="dropdown-menu-content"]', '[data-slot="tooltip-content"]', '[data-slot="sheet-content"]',
    '[data-slot="dialog-content"]', '[data-radix-popper-content-wrapper]',
  ].join(",");
  for (const element of document.querySelectorAll<HTMLElement>(selectors)) {
    if (!element.isConnected || element.getClientRects().length === 0) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top) return true;
  }
  return false;
}

export function NativeTerminalPane({ session, fontFamily, fontSize, active = true, focused = active, localSelection = true, onMissingSession, onToggleFocus, onNativeFocus, onNativeAvailabilityChange, onNativeStateChange }: { session: SessionInfo; fontFamily: string; fontSize: number; active?: boolean; focused?: boolean; localSelection?: boolean; onMissingSession?: (id: string) => void; onToggleFocus: () => void; onNativeFocus: (id: string) => void; onNativeAvailabilityChange: (available: boolean) => void; onNativeStateChange: (state: NativeTerminalState) => void }) {
  const { t } = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const nativeId = useRef<number | undefined>(undefined);
  const [nativeIdValue, setNativeIdValue] = useState<number | undefined>(undefined);
  const [mode, setMode] = useState<"pending" | "native" | "fallback">("pending");
  const [state, setState] = useState<NativeTerminalState>({ connected: false, syncing: true, controller: false, exited: false, readOnly: true });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [retry, setRetry] = useState(0);
  const activeRef = useRef(active);
  const focusedRef = useRef(focused);
  const stateRef = useRef(state);
  const pendingFocus = useRef<boolean | undefined>(focused);
  const lastBounds = useRef<string | undefined>(undefined);
  const earlyStates = useRef(new Map<number, NativeTerminalState>());
  const earlyErrors = useRef(new Map<number, string>());
  const closedNativeIds = useRef(new Set<number>());
  const notifiedClosedIds = useRef(new Set<number>());
  const lastNativeError = useRef<string | undefined>(undefined);
  const boundsFrame = useRef<number | undefined>(undefined);
  activeRef.current = active;
  focusedRef.current = focused;
  stateRef.current = state;
  const statusMessage = state.exited
    ? t("会话已结束，只读", "Session ended, read only")
    : state.syncing
      ? t("正在连接终端", "Connecting terminal")
      : !state.connected
        ? t("终端已断开", "Terminal disconnected")
        : state.readOnly || !state.controller
          ? t("正在观察终端，只读", "Observing terminal, read only")
          : t("终端已连接", "Terminal connected");
  const notifyNativeIssue = useCallback((message: string, kind: "error" | "warning" = "error"): void => {
    if (!message.trim() || /^(?:busy|terminal busy|controller busy|lease busy|terminal_stream_busy|controller_busy|lease_busy|繁忙|终端繁忙)$/i.test(message.trim())) return;
    notify({ kind, title: t("本地终端", "Native terminal"), message, key: `native-terminal:${session.id}:${message}` });
  }, [session.id, t]);
  const notifyClosedNative = (id: number): void => {
    if (notifiedClosedIds.current.has(id)) return;
    notifiedClosedIds.current.add(id);
    if (notifiedClosedIds.current.size > 64) notifiedClosedIds.current.delete(notifiedClosedIds.current.values().next().value as number);
    notifyNativeIssue(lastNativeError.current ?? t("终端连接已断开。可以从会话操作菜单重新连接。", "The terminal connection closed. Reconnect from the session actions menu."));
  };

  useEffect(() => {
    if (!supportsNativeTerminal(session)) { setMode("fallback"); return; }
    if (!active || mode !== "pending") return;
    let cancelled = false;
    void window.prospero.nativeTerminal.available().then(result => {
      if (!cancelled) setMode(result.available ? "native" : "fallback");
    }).catch(() => { if (!cancelled) setMode("fallback"); });
    return () => { cancelled = true; };
  }, [active, mode, retry, session.id, session.kind, session.terminalMode]);

  useEffect(() => {
    if (mode === "native") onNativeAvailabilityChange(true);
    else if (mode === "fallback") onNativeAvailabilityChange(false);
  }, [mode, onNativeAvailabilityChange]);

  useEffect(() => {
    if (mode !== "native" || nativeId.current !== undefined) return;
    let cancelled = false;
    let opened: number | undefined;
    const unsubscribeState = window.prospero.nativeTerminal.subscribeState(event => {
      if (closedNativeIds.current.has(event.id)) return;
      if (event.id === nativeId.current) {
        setState(event.state);
        onNativeStateChange(event.state);
        if (event.state.connected && !event.state.syncing) lastNativeError.current = undefined;
      }
      else {
        earlyStates.current.set(event.id, event.state);
        if (earlyStates.current.size > 16) earlyStates.current.delete(earlyStates.current.keys().next().value as number);
      }
      if (!event.state.connected && !event.state.syncing && !event.state.exited) {
        closedNativeIds.current.add(event.id);
        if (closedNativeIds.current.size > 64) closedNativeIds.current.delete(closedNativeIds.current.values().next().value as number);
        if (nativeId.current === event.id) {
          earlyStates.current.delete(event.id);
          nativeId.current = undefined;
          setNativeIdValue(undefined);
          lastBounds.current = undefined;
          notifyClosedNative(event.id);
        }
      }
    });
    const unsubscribeError = window.prospero.nativeTerminal.subscribeError(event => {
      if (closedNativeIds.current.has(event.id)) return;
      if (event.id === nativeId.current) lastNativeError.current = event.message;
      else {
        earlyErrors.current.set(event.id, event.message);
        if (earlyErrors.current.size > 16) earlyErrors.current.delete(earlyErrors.current.keys().next().value as number);
      }
    });
    void window.prospero.nativeTerminal.open(session.id, fontSize, fontFamily).then(result => {
      opened = result.id;
      if (cancelled) { void window.prospero.nativeTerminal.close(result.id); return; }
      nativeId.current = result.id;
      setNativeIdValue(result.id);
      const initialState = earlyStates.current.get(result.id);
      if (initialState) {
        setState(initialState); onNativeStateChange(initialState); earlyStates.current.delete(result.id);
        if (initialState.connected && !initialState.syncing) lastNativeError.current = undefined;
      }
      const initialError = earlyErrors.current.get(result.id);
      if (initialError) { lastNativeError.current = initialError; earlyErrors.current.delete(result.id); }
      if (closedNativeIds.current.has(result.id)) {
        nativeId.current = undefined; setNativeIdValue(undefined);
        notifyClosedNative(result.id);
      }
      lastBounds.current = undefined;
      if (nativeId.current !== undefined) scheduleBounds();
    }).catch(reason => {
      if (!cancelled) {
        const disconnected = { connected: false, syncing: false, controller: false, exited: false, readOnly: true };
        setState(disconnected);
        onNativeStateChange(disconnected);
        notifyNativeIssue(displayError(reason));
      }
    });
    return () => {
      cancelled = true;
      unsubscribeState(); unsubscribeError();
      if (opened !== undefined) void window.prospero.nativeTerminal.close(opened);
      if (nativeId.current === opened) nativeId.current = undefined;
      lastBounds.current = undefined;
      if (nativeId.current === undefined) setNativeIdValue(undefined);
    };
    // scheduleBounds is stable and the open lifecycle is keyed by the native session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, session.id, fontSize, fontFamily, retry]);

  const pasteClipboardImage = useCallback(async (): Promise<void> => {
    if (session.agent !== "claude" && session.agent !== "codex") {
      notifyNativeIssue(t("此终端暂不支持图片粘贴，请保存图片后使用文件路径", "Image paste is unavailable in this terminal; save the image and use its file path"), "warning");
      return;
    }
    const current = stateRef.current;
    if (!activeRef.current || !focusedRef.current || !current.connected || !current.controller || current.readOnly || current.exited) {
      notifyNativeIssue(t("终端为只读，请请求控制后再粘贴图片", "The terminal is read-only; request control before pasting an image"), "warning");
      return;
    }
    try {
      const { path } = await window.prospero.saveTerminalClipboardImage(session.id);
      const reference = terminalAgentImageReference(session.agent, path);
      const latest = stateRef.current;
      if (!activeRef.current || !focusedRef.current || !latest.connected || !latest.controller || latest.readOnly || latest.exited) {
        notifyNativeIssue(t("图片已保存；回到此终端后可重新粘贴", "Image saved; return to this terminal and paste again"), "warning");
        return;
      }
      const id = nativeId.current;
      if (!id || !reference) return;
      await window.prospero.nativeTerminal.inputText(id, reference);
    } catch (reason) { notifyNativeIssue(displayError(reason)); }
  }, [notifyNativeIssue, session.agent, session.id]);

  const scheduleBounds = useCallback((): void => {
    if (boundsFrame.current !== undefined) return;
    boundsFrame.current = requestAnimationFrame(() => {
      boundsFrame.current = undefined;
      const id = nativeId.current;
      const element = host.current;
      if (id === undefined || !element?.isConnected) return;
      const rect = element.getBoundingClientRect();
      const visible = activeRef.current && document.visibilityState === "visible" && rect.width > 0 && rect.height > 0 && !overlayCovers(rect);
      const focus = pendingFocus.current;
      pendingFocus.current = undefined;
      const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height, visible, ...(focus !== undefined ? { focus: visible && focus } : !visible ? { focus: false } : {}) };
      const key = JSON.stringify(bounds);
      if (lastBounds.current === key) return;
      lastBounds.current = key;
      void window.prospero.nativeTerminal.update(id, bounds)
        .catch(reason => {
          const message = displayError(reason);
          if (nativeId.current === id && !closedNativeIds.current.has(id) && !message.toLowerCase().includes("no longer open")) lastNativeError.current = message;
        });
    });
  }, []);

  useEffect(() => {
    if (mode !== "native") return;
    const element = host.current;
    if (!element) return;
    const resizeObserver = new ResizeObserver(scheduleBounds);
    resizeObserver.observe(element);
    const mutationObserver = new MutationObserver(scheduleBounds);
    mutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "open", "data-state", "aria-hidden"] });
    window.addEventListener("resize", scheduleBounds);
    window.addEventListener("scroll", scheduleBounds, true);
    document.addEventListener("visibilitychange", scheduleBounds);
    scheduleBounds();
    return () => {
      resizeObserver.disconnect(); mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleBounds);
      window.removeEventListener("scroll", scheduleBounds, true);
      document.removeEventListener("visibilitychange", scheduleBounds);
      if (boundsFrame.current !== undefined) cancelAnimationFrame(boundsFrame.current);
      boundsFrame.current = undefined;
    };
  }, [mode, active, focused, scheduleBounds]);

  useEffect(() => {
    pendingFocus.current = focused;
    scheduleBounds();
  }, [focused, scheduleBounds]);

  useEffect(() => {
    if (mode !== "native" || nativeIdValue === undefined) return;
    return window.prospero.nativeTerminal.subscribeFocus(event => {
      if (event.id !== nativeIdValue) return;
      if (event.focused) {
        pendingFocus.current = undefined;
        lastBounds.current = undefined;
        scheduleBounds();
        onNativeFocus(session.id);
      } else {
        pendingFocus.current = undefined;
      }
    });
  }, [mode, nativeIdValue, onNativeFocus, scheduleBounds, session.id]);

  useEffect(() => {
    if (mode !== "native" || nativeId.current === undefined) return;
    const id = nativeId.current;
    return window.prospero.nativeTerminal.subscribeShortcut(event => {
      if (event.id !== id) return;
      if (event.action === "toggle-focus") onToggleFocus();
      else if (event.action === "project-search") window.dispatchEvent(new CustomEvent("prospero:project-tools", { detail: { root: session.cwd, mode: "search" } }));
      else if (event.action === "terminal-search") {
        setSearchOpen(true);
        pendingFocus.current = false;
        scheduleBounds();
        requestAnimationFrame(() => searchInput.current?.focus());
      } else if (event.action === "paste-image") void pasteClipboardImage();
    });
  }, [mode, nativeIdValue, onToggleFocus, pasteClipboardImage, scheduleBounds, session.cwd]);

  const control = useCallback(async (action: "acquire" | "takeover" | "release"): Promise<void> => {
    if (nativeId.current === undefined) return;
    try { await window.prospero.nativeTerminal.action(nativeId.current, action); }
    catch (reason) { notifyNativeIssue(displayError(reason), "warning"); }
  }, [notifyNativeIssue]);
  const closeSearch = (): void => {
    setSearchOpen(false);
    setSearchText("");
    if (nativeId.current !== undefined) void window.prospero.nativeTerminal.searchStep(nativeId.current, "end").catch(() => undefined);
    pendingFocus.current = true;
    scheduleBounds();
  };
  const reconnect = useCallback((): void => {
    const syncing = { ...stateRef.current, connected: false, syncing: true };
    setState(syncing);
    stateRef.current = syncing;
    onNativeStateChange(syncing);
    setMode("pending");
    setRetry(value => value + 1);
  }, [onNativeStateChange]);

  useEffect(() => {
    const action = (raw: Event): void => {
      const detail = (raw as CustomEvent<{ sessionId?: string; action?: string }>).detail;
      if (detail?.sessionId !== session.id) return;
      if (detail.action === "acquire" || detail.action === "takeover" || detail.action === "release") void control(detail.action);
      else if (detail.action === "reconnect") reconnect();
    };
    window.addEventListener("prospero:native-terminal-action", action);
    return () => window.removeEventListener("prospero:native-terminal-action", action);
  }, [control, reconnect, session.id]);

  if (mode === "fallback") return <Suspense fallback={<div className="dock-empty" role="status">{t("正在加载终端…", "Loading terminal…")}</div>}><TerminalPane session={session} fontFamily={fontFamily} fontSize={fontSize} active={active} focused={focused} localSelection={localSelection} {...(onMissingSession ? { onMissingSession } : {})} /></Suspense>;
  return <section className="terminal-shell native-terminal-shell" aria-label={t("本地终端", "Native terminal")}>
    <span className="sr-only" role="status" aria-live="polite">{statusMessage}</span>
    <div className="native-terminal-find" hidden={!searchOpen}>
      <input ref={searchInput} value={searchText} aria-label={t("在终端中查找", "Find in terminal")} placeholder={t("查找终端内容", "Find in terminal")} onChange={event => {
        const value = event.target.value;
        setSearchText(value);
        if (nativeId.current !== undefined) void window.prospero.nativeTerminal.search(nativeId.current, value).catch(() => undefined);
      }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
        if (event.key === "Enter" && searchText && nativeId.current !== undefined) { event.preventDefault(); void window.prospero.nativeTerminal.searchStep(nativeId.current, event.shiftKey ? "previous" : "next").catch(() => undefined); }
      }} />
      <button type="button" disabled={!searchText} aria-label={t("上一个", "Previous")} onClick={() => searchText && nativeId.current !== undefined && void window.prospero.nativeTerminal.searchStep(nativeId.current, "previous").catch(() => undefined)}>↑</button>
      <button type="button" disabled={!searchText} aria-label={t("下一个", "Next")} onClick={() => searchText && nativeId.current !== undefined && void window.prospero.nativeTerminal.searchStep(nativeId.current, "next").catch(() => undefined)}>↓</button>
      <button type="button" aria-label={t("关闭查找", "Close find")} onClick={closeSearch}>×</button>
    </div>
    <div ref={host} className="native-terminal-host" data-native-id={nativeIdValue} data-native-state={state.connected ? "connected" : state.syncing ? "syncing" : state.exited ? "exited" : "disconnected"} tabIndex={-1} onPointerDownCapture={() => { pendingFocus.current = true; scheduleBounds(); }} />
  </section>;
}
