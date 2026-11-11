import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { isReadOnlyTerminalStatus } from "../../shared/session-state";
import type { NativeTerminalState, SessionInfo } from "../../shared/types";
import { useLocale } from "./locale";
import { notify } from "./notifications/notifications";
import { displayError } from "./state";
import { supportsTerminalImagePaste, terminalAgentImageReference } from "./terminal-agent-input";
import {
  canPasteIntoTerminal,
  deriveTerminalViewPhase,
  isNativeDisconnectedBannerVisible,
  terminalViewHostStateAttr,
} from "./terminal-view-state";
const TerminalPane = lazy(() => import("./TerminalPane").then(module => ({ default: module.TerminalPane })));

export function supportsNativeTerminal(session: SessionInfo): boolean {
  return window.prospero.platform === "darwin" && session.kind === "pty" && session.terminalMode === "events" && !isReadOnlyTerminalStatus(session.status);
}

export const OVERLAY_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-slot="sheet-overlay"]',
  '[data-slot="dialog-overlay"]',
  '[data-slot="alert-dialog-overlay"]',
  '[data-slot="popover-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="select-content"]',
  '[data-slot="combobox-content"]',
  '[data-slot="menubar-content"]',
  '[data-slot="hover-card-content"]',
  '[data-slot="tooltip-content"]',
  '[data-slot="sheet-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-base-ui-portal] [role="dialog"]',
  '[data-base-ui-portal] [role="alertdialog"]',
  '[data-base-ui-portal] [role="menu"]',
  '[data-base-ui-portal] [role="listbox"]',
  '[data-base-ui-portal] [role="tooltip"]',
  '[data-radix-popper-content-wrapper]',
  '.desktop-toast',
].join(",");

const CLOSING_OR_HIDDEN_OVERLAY_SELECTOR = '[data-closed], [data-ending-style], [data-state="closed"], [aria-hidden="true"], [hidden], [inert]';
const TOOLTIP_OVERLAY_SELECTOR = '[data-slot="tooltip-content"], [role="tooltip"]';

function nodeIntersectsOverlay(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches(OVERLAY_SELECTORS) || Boolean(node.closest(OVERLAY_SELECTORS) || node.querySelector(OVERLAY_SELECTORS));
}

function isTooltipOverlay(element: HTMLElement): boolean {
  return element.matches(TOOLTIP_OVERLAY_SELECTOR) || Boolean(element.closest(TOOLTIP_OVERLAY_SELECTOR));
}

export function overlayCovers(rect: DOMRect, hostElement?: HTMLElement | null): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  for (const element of document.querySelectorAll<HTMLElement>(OVERLAY_SELECTORS)) {
    if (!element.isConnected) continue;
    if (hostElement && (element === hostElement || hostElement.contains(element))) continue;
    if (element.matches(CLOSING_OR_HIDDEN_OVERLAY_SELECTOR) || element.closest(CLOSING_OR_HIDDEN_OVERLAY_SELECTOR)) continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || box.left >= rect.right || box.right <= rect.left || box.top >= rect.bottom || box.bottom <= rect.top) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const opacity = Number.parseFloat(style.opacity);
    if (style.opacity === "0" || (Number.isFinite(opacity) && opacity <= 0)) continue;
    if (style.pointerEvents === "none" && !isTooltipOverlay(element)) continue;
    return true;
  }
  return false;
}

type TerminalLayoutSubscriber = {
  getElement: () => HTMLElement | null;
  onFlush: () => void;
};

const layoutSubscribers = new Set<TerminalLayoutSubscriber>();
let sharedMutationObserver: MutationObserver | undefined;
let sharedFlushFrame: number | undefined;
let sharedDirtyAll = false;
const sharedDirtyTargets = new Set<Node>();

function runSharedFlush(): void {
  sharedFlushFrame = undefined;
  const dirtyAll = sharedDirtyAll;
  sharedDirtyAll = false;
  const targets = dirtyAll ? [] : [...sharedDirtyTargets];
  sharedDirtyTargets.clear();
  for (const subscriber of layoutSubscribers) {
    const element = subscriber.getElement();
    if (!element?.isConnected) continue;
    if (dirtyAll || targets.some(target => target.contains(element))) {
      subscriber.onFlush();
    }
  }
}

function requestSharedFlush(dirtyAll: boolean): void {
  if (dirtyAll) {
    sharedDirtyAll = true;
    sharedDirtyTargets.clear();
  }
  if (sharedFlushFrame !== undefined) return;
  sharedFlushFrame = requestAnimationFrame(runSharedFlush);
}

function handleGlobalLayoutEvent(): void {
  requestSharedFlush(true);
}

function subscribeTerminalLayoutChanges(subscriber: TerminalLayoutSubscriber): () => void {
  if (layoutSubscribers.size === 0 && typeof document !== "undefined") {
    sharedMutationObserver = new MutationObserver(records => {
      if (sharedDirtyAll) return;
      let affectsAny = false;
      for (const record of records) {
        const target = record.target;
        if (
          target === document.body ||
          target === document.documentElement ||
          (target instanceof Element && target.parentElement === document.body) ||
          nodeIntersectsOverlay(target)
        ) {
          requestSharedFlush(true);
          return;
        }
        for (const added of record.addedNodes) {
          if (nodeIntersectsOverlay(added)) {
            requestSharedFlush(true);
            return;
          }
        }
        for (const removed of record.removedNodes) {
          if (nodeIntersectsOverlay(removed)) {
            requestSharedFlush(true);
            return;
          }
        }
        sharedDirtyTargets.add(target);
        affectsAny = true;
      }
      if (affectsAny) requestSharedFlush(false);
    });
    sharedMutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "open",
        "data-state",
        "data-open",
        "data-closed",
        "data-starting-style",
        "data-ending-style",
        "aria-hidden",
        "hidden",
        "inert",
      ],
    });
    window.addEventListener("resize", handleGlobalLayoutEvent);
    window.addEventListener("scroll", handleGlobalLayoutEvent, true);
    document.addEventListener("visibilitychange", handleGlobalLayoutEvent);
    document.documentElement.addEventListener("transitionend", handleGlobalLayoutEvent, true);
    document.documentElement.addEventListener("animationend", handleGlobalLayoutEvent, true);
  }
  layoutSubscribers.add(subscriber);
  return () => {
    layoutSubscribers.delete(subscriber);
    if (layoutSubscribers.size === 0) {
      sharedMutationObserver?.disconnect();
      sharedMutationObserver = undefined;
      if (sharedFlushFrame !== undefined) {
        cancelAnimationFrame(sharedFlushFrame);
        sharedFlushFrame = undefined;
      }
      sharedDirtyAll = false;
      sharedDirtyTargets.clear();
      if (typeof document !== "undefined") {
        window.removeEventListener("resize", handleGlobalLayoutEvent);
        window.removeEventListener("scroll", handleGlobalLayoutEvent, true);
        document.removeEventListener("visibilitychange", handleGlobalLayoutEvent);
        document.documentElement.removeEventListener("transitionend", handleGlobalLayoutEvent, true);
        document.documentElement.removeEventListener("animationend", handleGlobalLayoutEvent, true);
      }
    }
  };
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
  const [occluded, setOccluded] = useState(false);
  const occludedRef = useRef(false);
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
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const autoRetryCount = useRef(0);
  const autoRetryTimer = useRef<number | undefined>(undefined);
  activeRef.current = active;
  focusedRef.current = focused;
  stateRef.current = state;
  const viewPhase = deriveTerminalViewPhase({
    mode,
    sessionStatus: session.status,
    state,
  });
  const statusMessage =
    viewPhase === "exited"
      ? t("会话已结束，只读", "Session ended, read only")
      : viewPhase === "probing" || viewPhase === "connecting"
        ? t("正在连接终端", "Connecting terminal")
        : viewPhase === "disconnected"
          ? t("终端已断开", "Terminal disconnected")
          : viewPhase === "observing"
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
    if (!supportsNativeTerminal(session) && nativeId.current === undefined) { setMode("fallback"); return; }
    if (!active || mode !== "pending") return;
    let cancelled = false;
    void window.prospero.nativeTerminal.available().then(result => {
      if (!cancelled) setMode(result.available ? "native" : "fallback");
    }).catch(() => { if (!cancelled) setMode("fallback"); });
    return () => { cancelled = true; };
  }, [active, mode, retry, session.id, session.kind, session.status, session.terminalMode]);

  useEffect(() => {
    if (mode === "native") onNativeAvailabilityChange(true);
    else if (mode === "fallback") onNativeAvailabilityChange(false);
  }, [mode, onNativeAvailabilityChange]);

  useEffect(() => {
    if (mode !== "native" || nativeId.current !== undefined) return;
    if (!supportsNativeTerminal(sessionRef.current)) {
      setMode("fallback");
      return;
    }
    let cancelled = false;
    let opened: number | undefined;
    const scheduleAutoReconnect = (): void => {
      if (cancelled) return;
      if (!supportsNativeTerminal(sessionRef.current)) {
        setMode("fallback");
        return;
      }
      if (autoRetryCount.current < 3) {
        autoRetryCount.current += 1;
        if (autoRetryTimer.current !== undefined) window.clearTimeout(autoRetryTimer.current);
        autoRetryTimer.current = window.setTimeout(() => {
          autoRetryTimer.current = undefined;
          if (cancelled) return;
          if (!supportsNativeTerminal(sessionRef.current)) {
            setMode("fallback");
            return;
          }
          const syncing = { ...stateRef.current, connected: false, syncing: true };
          setState(syncing);
          stateRef.current = syncing;
          onNativeStateChange(syncing);
          setMode("pending");
          setRetry(value => value + 1);
        }, 600 * autoRetryCount.current);
      }
    };
    const unsubscribeState = window.prospero.nativeTerminal.subscribeState(event => {
      if (closedNativeIds.current.has(event.id)) return;
      if (event.id === nativeId.current) {
        setState(event.state);
        onNativeStateChange(event.state);
        if (event.state.connected && !event.state.syncing) {
          lastNativeError.current = undefined;
          autoRetryCount.current = 0;
        }
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
          if (!supportsNativeTerminal(sessionRef.current)) {
            setMode("fallback");
            return;
          }
          if (autoRetryCount.current >= 3) notifyClosedNative(event.id);
          scheduleAutoReconnect();
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
        if (initialState.connected && !initialState.syncing) {
          lastNativeError.current = undefined;
          autoRetryCount.current = 0;
        }
      }
      const initialError = earlyErrors.current.get(result.id);
      if (initialError) { lastNativeError.current = initialError; earlyErrors.current.delete(result.id); }
      if (closedNativeIds.current.has(result.id)) {
        nativeId.current = undefined; setNativeIdValue(undefined);
        if (!supportsNativeTerminal(sessionRef.current)) {
          setMode("fallback");
          return;
        }
        if (autoRetryCount.current >= 3) notifyClosedNative(result.id);
        scheduleAutoReconnect();
      }
      lastBounds.current = undefined;
      if (nativeId.current !== undefined) scheduleBounds();
    }).catch(reason => {
      if (!cancelled) {
        const message = displayError(reason);
        if (!supportsNativeTerminal(sessionRef.current) || /does not support terminal streaming|not available|unavailable|not installed|could not be loaded/i.test(message)) {
          setMode("fallback");
          return;
        }
        const disconnected = { connected: false, syncing: false, controller: false, exited: false, readOnly: true };
        setState(disconnected);
        onNativeStateChange(disconnected);
        if (autoRetryCount.current >= 3) notifyNativeIssue(message);
        scheduleAutoReconnect();
      }
    });
    return () => {
      cancelled = true;
      if (autoRetryTimer.current !== undefined) {
        window.clearTimeout(autoRetryTimer.current);
        autoRetryTimer.current = undefined;
      }
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
    if (!supportsTerminalImagePaste(session.agent)) {
      notifyNativeIssue(t("此终端暂不支持图片粘贴，请保存图片后使用文件路径", "Image paste is unavailable in this terminal; save the image and use its file path"), "warning");
      return;
    }
    const currentPhase = deriveTerminalViewPhase({
      mode: "native",
      sessionStatus: sessionRef.current.status,
      state: stateRef.current,
    });
    if (!canPasteIntoTerminal({ active: activeRef.current, focused: focusedRef.current, phase: currentPhase })) {
      notifyNativeIssue(t("终端为只读，请请求控制后再粘贴图片", "The terminal is read-only; request control before pasting an image"), "warning");
      return;
    }
    try {
      const { path } = await window.prospero.saveTerminalClipboardImage(session.id);
      const reference = terminalAgentImageReference(session.agent, path);
      const latestPhase = deriveTerminalViewPhase({
        mode: "native",
        sessionStatus: sessionRef.current.status,
        state: stateRef.current,
      });
      if (!canPasteIntoTerminal({ active: activeRef.current, focused: focusedRef.current, phase: latestPhase })) {
        notifyNativeIssue(t("图片已保存；回到此终端后可重新粘贴", "Image saved; return to this terminal and paste again"), "warning");
        return;
      }
      const id = nativeId.current;
      if (!id || !reference) return;
      await window.prospero.nativeTerminal.inputText(id, reference);
    } catch (reason) { notifyNativeIssue(displayError(reason)); }
  }, [notifyNativeIssue, session.agent, session.id]);

  const flushBounds = useCallback((): void => {
    if (boundsFrame.current !== undefined) {
      cancelAnimationFrame(boundsFrame.current);
      boundsFrame.current = undefined;
    }
    const id = nativeId.current;
    const element = host.current;
    if (id === undefined || !element?.isConnected) return;
    const rect = element.getBoundingClientRect();
    const hasArea = activeRef.current && document.visibilityState === "visible" && rect.width > 0 && rect.height > 0;
    const isOccluded = hasArea && overlayCovers(rect, element);
    if (occludedRef.current !== isOccluded) {
      occludedRef.current = isOccluded;
      setOccluded(isOccluded);
    }
    const visible = hasArea && !isOccluded;
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
  }, []);

  const scheduleBounds = useCallback((): void => {
    if (boundsFrame.current !== undefined) return;
    boundsFrame.current = requestAnimationFrame(() => {
      boundsFrame.current = undefined;
      flushBounds();
    });
  }, [flushBounds]);

  useEffect(() => {
    if (mode !== "native") {
      if (occludedRef.current) {
        occludedRef.current = false;
        setOccluded(false);
      }
      return;
    }
    const element = host.current;
    if (!element) return;
    const resizeObserver = new ResizeObserver(scheduleBounds);
    resizeObserver.observe(element);
    const mainContainer = element.closest(".prospero-main");
    const stackContainer = element.closest(".workspace-session-stack");
    if (mainContainer) resizeObserver.observe(mainContainer);
    if (stackContainer && stackContainer !== mainContainer) resizeObserver.observe(stackContainer);
    const unsubscribeLayout = subscribeTerminalLayoutChanges({
      getElement: () => host.current,
      onFlush: flushBounds,
    });
    scheduleBounds();
    return () => {
      resizeObserver.disconnect();
      unsubscribeLayout();
      if (boundsFrame.current !== undefined) cancelAnimationFrame(boundsFrame.current);
      boundsFrame.current = undefined;
    };
  }, [mode, active, focused, flushBounds, scheduleBounds]);

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
    autoRetryCount.current = 0;
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
    {isNativeDisconnectedBannerVisible(viewPhase, nativeIdValue) && (
      <div className="native-terminal-disconnected-banner" role="status">
        <span>{lastNativeError.current ?? t("原生终端连接已断开", "Native terminal disconnected")}</span>
        <div className="native-terminal-disconnected-actions">
          <button type="button" onClick={reconnect}>{t("重新连接", "Reconnect")}</button>
          <button type="button" onClick={() => setMode("fallback")}>{t("切换内置视图", "Built-in view")}</button>
        </div>
      </div>
    )}
    <div
      ref={host}
      className="native-terminal-host"
      data-native-id={nativeIdValue}
      data-native-state={terminalViewHostStateAttr(viewPhase)}
      data-occluded={occluded || undefined}
      style={{ position: "relative" }}
      tabIndex={-1}
      onPointerDownCapture={() => { pendingFocus.current = true; scheduleBounds(); }}
    >
      {occluded && (
        <div
          className="native-terminal-occluded-placeholder"
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            background: "var(--terminal-background, var(--card, #14161d))",
            color: "var(--terminal-foreground, var(--muted-foreground, #8b93b0))",
            fontFamily,
            fontSize: `${Math.max(11, Math.min(14, fontSize - 1))}px`,
            overflow: "hidden",
            userSelect: "none",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              padding: "8px 12px",
              borderBottom: "1px solid var(--border, rgba(128, 128, 128, 0.16))",
              opacity: 0.72,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {`${session.agent} · ${session.cwd}`}
            </span>
            <span style={{ flexShrink: 0, fontSize: "11px" }}>{statusMessage}</span>
          </div>
        </div>
      )}
    </div>
  </section>;
}
