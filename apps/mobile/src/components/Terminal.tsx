/**
 * 终端视图:WebView 加载内联的 term.html(xterm.js + WebGL2 + JetBrainsMono Nerd Font),
 * WS 保持在 RN 侧单连接,WebView 只做渲染与输入采集。
 * attach 流程:page ready → 上报 fit 尺寸 → resize → attach(带 lastSeq 续传)。
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import type { HostConnection } from "@/lib/connection";
import { toast } from "@/components/Toast";
import { deliveryFailureText, type DeliveryResult } from "@/lib/outbound-queue";
import { subscribeFocusedTerminal } from "@/lib/focused-session-stream";
import { useFocusedSessionEffect } from "@/lib/use-focused-session-effect";
import { useMobileTheme } from "@/lib/theme";
import { TERMINAL_HTML, TERMINAL_FONT_FAMILY } from "./terminal-html";

// source 对象保持稳定,避免会话状态刷新时让原生 WebView 误判为需要重新加载。
const TERMINAL_SOURCE = { html: TERMINAL_HTML } as const;

export interface TerminalExtractedText {
  viewport: string;
  full: string;
  urls: string[];
}

interface Props {
  conn: HostConnection;
  sid: string;
  /** 由原生层控制；WebView 就绪和后续变化都会收到 font 消息。 */
  fontSize: number;
  /** 宽屏列数保底（如 88 列），窄屏手机上自动收窄字号避免 TUI 边框折行错乱。 */
  wideCols?: number | null;
  /** 捏合缩放后回报,让 A+/A− 的基准与终端保持一致 */
  onFontSize?: (size: number) => void;
  /**
   * 折叠/展开、横竖屏切换的标识。变化时主动让页面重新 fit:ResizeObserver
   * 在显示屏切换时可能晚到，行列不变时 xterm 也不会重画。
   */
  layoutKey?: string;
  /** 洪峰时的渲染帧率与吞吐;Release 构建里 console 是哑的,只能走 UI */
  onPerf?: (p: { fps: number; kb: number; renderer: string }) => void;
  /** 断线后的 shell 字节不能安全补发，WebView 必须被冻结。 */
  inputEnabled?: boolean;
  sessionEnded?: boolean;
  endedActions?: ReactNode;
  onInputB64?: (data: string) => DeliveryResult;
  onPasteB64?: (data: string) => DeliveryResult;
  onCanvasTap?: (info: { mouseActive: boolean; yRatio: number }) => void;
  disconnectedMessage?: string;
  onRetryConnection?: () => void;
}

export interface TerminalHandle {
  scrollToBottom(): void;
  focus(): void;
  /** 收起键盘 */
  blur(): void;
  copyAll(): void;
  extractText(): Promise<TerminalExtractedText>;
  search(text: string, previous?: boolean, incremental?: boolean): void;
  paste(text: string): Promise<DeliveryResult>;
}

interface BridgeUp {
  kind:
    | "ready"
    | "resized"
    | "input"
    | "pasteInput"
    | "clipboardCopy"
    | "clipboardPaste"
    | "perf"
    | "fontSize"
    | "extractedText"
    | "canvasTap";
  requestId?: number;
  renderer?: string;
  cols?: number;
  rows?: number;
  data?: string;
  text?: string;
  viewport?: string;
  full?: string;
  urls?: string[];
  mouseActive?: boolean;
  yRatio?: number;
  fps?: number;
  kb?: number;
  size?: number;
}

const EMPTY_EXTRACT: TerminalExtractedText = { viewport: "", full: "", urls: [] };

const TerminalInner = forwardRef<TerminalHandle, Props>(function Terminal(
  {
    conn,
    sid,
    fontSize,
    wideCols = null,
    onFontSize,
    layoutKey,
    onPerf,
    inputEnabled = true,
    sessionEnded = false,
    endedActions,
    onInputB64,
    onPasteB64,
    onCanvasTap,
    disconnectedMessage = "主机未连接；终端输入已冻结。",
    onRetryConnection,
  },
  ref,
) {
  const { scheme, palette } = useMobileTheme();
  const schemeRef = useRef(scheme);
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const activeRef = useRef(false);
  const metricsRef = useRef(onPerf !== undefined);
  const attachedRef = useRef(false);
  const lastSeqRef = useRef(0);
  const resnapshotRef = useRef(false);
  useEffect(() => () => conn.detach(sid), [conn, sid]);
  const queueRef = useRef<object[]>([]);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const fontSizeRef = useRef(fontSize);
  const wideColsRef = useRef(wideCols ?? 0);
  const pasteIdRef = useRef(0);
  const extractIdRef = useRef(0);
  const focusEpochRef = useRef(0);
  const pastesRef = useRef(
    new Map<number, { resolve: (result: DeliveryResult) => void; timer: ReturnType<typeof setTimeout> }>(),
  );
  const extractsRef = useRef(
    new Map<number, { resolve: (result: TerminalExtractedText) => void; timer: ReturnType<typeof setTimeout> }>(),
  );

  const cancelPendingRequests = useCallback(() => {
    focusEpochRef.current++;
    for (const pending of pastesRef.current.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, reason: "offline" });
    }
    pastesRef.current.clear();
    for (const pending of extractsRef.current.values()) {
      clearTimeout(pending.timer);
      pending.resolve(EMPTY_EXTRACT);
    }
    extractsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!inputEnabled) {
      focusEpochRef.current++;
      for (const pending of pastesRef.current.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ accepted: false, reason: "offline" });
      }
      pastesRef.current.clear();
    }
  }, [inputEnabled]);
  useEffect(() => cancelPendingRequests, [cancelPendingRequests]);
  useEffect(
    () =>
      conn.events.on("disconnected", () => {
        lastSentSizeRef.current = null;
        cancelPendingRequests();
      }),
    [conn, cancelPendingRequests],
  );

  const batchRef = useRef<object[]>([]);
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 把同一 tick 内到达的消息合并成一批再过桥。
   *
   * 每次跨桥的固定开销不小,洪峰下几十条/秒逐条过是纯浪费。用 setTimeout(0)
   * 而不是固定间隔,是因为【打字回显】不能被批处理拖慢 —— 单独一条消息
   * 会在当前 tick 结束就立刻发出,只有真正堆积时才会合并。
   */
  const flush = useCallback(() => {
    if (flushRef.current !== null) clearTimeout(flushRef.current);
    flushRef.current = null;
    const batch = batchRef.current;
    if (batch.length === 0) return;
    batchRef.current = [];
    webRef.current?.postMessage(JSON.stringify(batch));
  }, []);

  const rx = useCallback(
    (obj: object) => {
      if (!readyRef.current) {
        queueRef.current.push(obj);
        return;
      }
      batchRef.current.push(obj);
      if (flushRef.current === null) flushRef.current = setTimeout(flush, 0);
    },
    [flush],
  );

  const sendResizeIfChanged = useCallback(
    (cols: number, rows: number) => {
      if (sessionEnded) return;
      if (
        lastSentSizeRef.current?.cols === cols &&
        lastSentSizeRef.current?.rows === rows
      ) {
        return;
      }
      lastSentSizeRef.current = { cols, rows };
      conn.resize(sid, cols, rows);
    },
    [conn, sid, sessionEnded],
  );

  const tryAttach = useCallback(
    (force = false) => {
      if (!activeRef.current || !readyRef.current || !conn.isConnected || !sizeRef.current) return;
      sendResizeIfChanged(sizeRef.current.cols, sizeRef.current.rows);
      const lastSeq = lastSeqRef.current > 0 ? lastSeqRef.current : undefined;
      // 始终走完整快照恢复（avt::Vt::dump），确保历史滚动缓冲区与终端模式（?2004h / ?1000h / kitty keyboard）不丢失。
      if (force) conn.attach(sid, lastSeq, { force: true });
      else conn.attach(sid, lastSeq);
      attachedRef.current = true;
    },
    [conn, sid, sendResizeIfChanged],
  );

  useEffect(() => {
    schemeRef.current = scheme;
    if (readyRef.current) rx({ kind: "theme", scheme });
  }, [scheme, rx]);

  useEffect(() => {
    fontSizeRef.current = fontSize;
    if (readyRef.current) rx({ kind: "font", size: fontSize, family: TERMINAL_FONT_FAMILY });
  }, [fontSize, rx]);

  useEffect(() => {
    const normalized = wideCols && wideCols > 0 ? wideCols : 0;
    wideColsRef.current = normalized;
    if (readyRef.current) rx({ kind: "wideCols", cols: normalized });
  }, [wideCols, rx]);

  useEffect(() => {
    metricsRef.current = onPerf !== undefined;
    if (readyRef.current) rx({ kind: "activity", active: activeRef.current, metrics: metricsRef.current });
  }, [onPerf, rx]);

  useFocusedSessionEffect(useCallback(() => {
    activeRef.current = true;
    if (readyRef.current) rx({ kind: "activity", active: true, metrics: metricsRef.current });
    const cleanup = subscribeFocusedTerminal({
      conn,
      sid,
      cursor: lastSeqRef,
      snapshot: (message) =>
        rx({
          kind: "snapshot",
          ansi: message.ansi,
          dataB64: message.dataB64,
          cols: message.cols,
          rows: message.rows,
        }),
      output: (message) =>
        rx(
          message.events
            ? { kind: "events", events: message.events, replay: message.replay }
            : { kind: "output", dataB64: message.dataB64 },
        ),
      flush,
      attach: tryAttach,
    });
    return () => {
      activeRef.current = false;
      cancelPendingRequests();
      cleanup();
      attachedRef.current = false;
      lastSentSizeRef.current = null;
      if (readyRef.current) {
        rx({ kind: "blur" });
        rx({ kind: "activity", active: false, metrics: false });
        flush();
      }
    };
  }, [conn, sid, flush, rx, tryAttach, cancelPendingRequests]));

  const requestPaste = useCallback((text: string): Promise<DeliveryResult> => {
    if (!activeRef.current || !readyRef.current || !inputEnabled || !conn.isConnected) {
      return Promise.resolve({ accepted: false, reason: "offline" });
    }
    const requestId = ++pasteIdRef.current;
    return new Promise<DeliveryResult>((resolve) => {
      const timer = setTimeout(() => {
        pastesRef.current.delete(requestId);
        resolve({ accepted: false, reason: "transport_error" });
      }, 5000);
      pastesRef.current.set(requestId, { resolve, timer });
      rx({ kind: "encodePaste", requestId, text });
    });
  }, [conn, inputEnabled, rx]);

  const requestExtractText = useCallback((): Promise<TerminalExtractedText> => {
    if (!readyRef.current) return Promise.resolve(EMPTY_EXTRACT);
    const requestId = ++extractIdRef.current;
    return new Promise<TerminalExtractedText>((resolve) => {
      const timer = setTimeout(() => {
        extractsRef.current.delete(requestId);
        resolve(EMPTY_EXTRACT);
      }, 3000);
      extractsRef.current.set(requestId, { resolve, timer });
      rx({ kind: "extractText", requestId });
    });
  }, [rx]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: BridgeUp;
      try {
        msg = JSON.parse(e.nativeEvent.data) as BridgeUp;
      } catch {
        return;
      }
      switch (msg.kind) {
        case "ready":
          cancelPendingRequests();
          readyRef.current = true;
          attachedRef.current = false;
          lastSentSizeRef.current = null;
          lastSeqRef.current = 0;
          rx({ kind: "theme", scheme: schemeRef.current });
          rx({ kind: "activity", active: activeRef.current, metrics: metricsRef.current });
          rx({ kind: "wideCols", cols: wideColsRef.current });
          rx({ kind: "font", size: fontSizeRef.current, family: TERMINAL_FONT_FAMILY });
          if (queueRef.current.length > 0) {
            const pending = queueRef.current;
            queueRef.current = [];
            for (const obj of pending) rx(obj);
          }
          break;
        case "resized":
          if (typeof msg.cols !== "number" || typeof msg.rows !== "number") return;
          sizeRef.current = { cols: msg.cols, rows: msg.rows };
          if (!activeRef.current) break;
          if (!attachedRef.current) tryAttach();
          else if (resnapshotRef.current && !sessionEnded) {
            resnapshotRef.current = false;
            lastSeqRef.current = 0;
            tryAttach(true);
          } else sendResizeIfChanged(msg.cols, msg.rows);
          break;
        case "input":
          if (activeRef.current && typeof msg.data === "string" && inputEnabled) {
            const result = onInputB64 ? onInputB64(msg.data) : conn.inputB64(sid, msg.data);
            if (!result.accepted) toast(deliveryFailureText(result));
          }
          break;
        case "clipboardCopy":
          if (activeRef.current && typeof msg.text === "string" && msg.text.length > 0) {
            void Clipboard.setStringAsync(msg.text).then(
              () => toast("已复制终端内容"),
              () => toast("无法复制终端内容"),
            );
          }
          break;
        case "clipboardPaste":
          if (activeRef.current && inputEnabled) {
            const epoch = focusEpochRef.current;
            void Clipboard.getStringAsync().then(
              (text) => {
                if (focusEpochRef.current !== epoch) return;
                if (!text) {
                  toast("剪贴板是空的");
                  return;
                }
                void requestPaste(text).then((result) => {
                  if (!result.accepted) toast(deliveryFailureText(result));
                });
              },
              () => toast("无法读取剪贴板"),
            );
          }
          break;
        case "pasteInput": {
          if (typeof msg.requestId !== "number") break;
          const pending = pastesRef.current.get(msg.requestId);
          if (!pending) break;
          pastesRef.current.delete(msg.requestId);
          clearTimeout(pending.timer);
          const result =
            activeRef.current && inputEnabled && conn.isConnected && typeof msg.data === "string" && msg.data.length > 0
              ? (onPasteB64 ? onPasteB64(msg.data) : conn.inputB64(sid, msg.data))
              : { accepted: false as const, reason: "offline" as const };
          pending.resolve(result);
          break;
        }
        case "extractedText": {
          if (typeof msg.requestId !== "number") break;
          const pending = extractsRef.current.get(msg.requestId);
          if (!pending) break;
          extractsRef.current.delete(msg.requestId);
          clearTimeout(pending.timer);
          pending.resolve({
            viewport: typeof msg.viewport === "string" ? msg.viewport : "",
            full: typeof msg.full === "string" ? msg.full : "",
            urls: Array.isArray(msg.urls) ? msg.urls.filter((item): item is string => typeof item === "string") : [],
          });
          break;
        }
        case "fontSize":
          if (activeRef.current && typeof msg.size === "number") onFontSize?.(msg.size);
          break;
        case "canvasTap":
          if (activeRef.current && inputEnabled) {
            if (onCanvasTap) {
              onCanvasTap({
                mouseActive: msg.mouseActive === true,
                yRatio: typeof msg.yRatio === "number" ? msg.yRatio : 1,
              });
            } else {
              webRef.current?.requestFocus?.();
              rx({ kind: "focus" });
            }
          }
          break;
        case "perf":
          if (activeRef.current && typeof msg.fps === "number" && typeof msg.kb === "number") {
            onPerf?.({ fps: msg.fps, kb: msg.kb, renderer: msg.renderer ?? "?" });
          }
          break;
      }
    },
    [
      conn,
      sid,
      tryAttach,
      rx,
      onFontSize,
      onPerf,
      inputEnabled,
      onInputB64,
      onPasteB64,
      onCanvasTap,
      cancelPendingRequests,
      sessionEnded,
      sendResizeIfChanged,
      requestPaste,
    ],
  );

  useEffect(() => {
    if (!readyRef.current) return;
    resnapshotRef.current = true;
    rx({ kind: "fit" });
  }, [layoutKey, rx]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: () => rx({ kind: "scrollBottom" }),
      focus: () => {
        webRef.current?.requestFocus?.();
        rx({ kind: "focus" });
      },
      blur: () => rx({ kind: "blur" }),
      copyAll: () => rx({ kind: "copyAll" }),
      extractText: requestExtractText,
      search: (text, previous = false, incremental = false) =>
        rx({ kind: "search", text, previous, incremental }),
      paste: requestPaste,
    }),
    [rx, requestExtractText, requestPaste],
  );

  return (
    <View style={[styles.wrap, { backgroundColor: palette.surface }]}>
      <WebView
        ref={webRef}
        source={TERMINAL_SOURCE}
        onMessage={onMessage}
        style={[styles.web, { backgroundColor: palette.surface }]}
        keyboardDisplayRequiresUserAction={false}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        webviewDebuggingEnabled={__DEV__}
        originWhitelist={["*"]}
        bounces={false}
        overScrollMode="never"
        automaticallyAdjustContentInsets={false}
      />
      {!inputEnabled && (
        <View
          style={[
            styles.inputFrozen,
            !sessionEnded && {
              backgroundColor:
                scheme === "light" ? "rgba(242, 244, 247, 0.82)" : "rgba(11, 13, 18, 0.72)",
            },
            sessionEnded && styles.endedNotice,
          ]}
          pointerEvents={sessionEnded ? "box-none" : "auto"}
        >
          <View
            style={[
              styles.inputFrozenCard,
              { backgroundColor: palette.warnBg, borderColor: palette.border },
            ]}
            accessible={!sessionEnded}
            accessibilityLiveRegion="polite"
            accessibilityLabel={disconnectedMessage}
          >
            <Text style={[styles.inputFrozenText, { color: palette.warn }]}>
              {disconnectedMessage}
            </Text>
            {sessionEnded && endedActions}
            {onRetryConnection && (
              <Pressable
                style={({ pressed }) => [
                  styles.inputFrozenRetry,
                  { backgroundColor: palette.accent },
                  pressed && styles.inputFrozenRetryPressed,
                ]}
                onPress={onRetryConnection}
                accessibilityRole="button"
                accessibilityLabel="重新连接主机后继续终端输入"
              >
                <Text style={[styles.inputFrozenRetryText, { color: palette.onAccent }]}>
                  重试连接
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
});

/**
 * 顶部状态计时每秒都会更新;终端连接和 sid 没变时不应连带重渲染 WebView。
 * 这既避免无意义的原生属性同步,也守住正在进行的输入法组合态。
 */
export const Terminal = memo(
  forwardRef<TerminalHandle, Props>(function Terminal(props, ref) {
    const key = `${props.conn.host.id}\u0000${props.sid}`;
    return <TerminalInner key={key} {...props} ref={ref} />;
  }),
);

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#16171a" },
  web: { flex: 1, backgroundColor: "#16171a" },
  inputFrozen: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(15, 16, 19, 0.68)",
  },
  inputFrozenCard: {
    maxWidth: 340,
    gap: 12,
    padding: 16,
    borderRadius: 14,
    backgroundColor: "#1f1c16",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#5c4922",
  },
  endedNotice: { justifyContent: "flex-start", backgroundColor: "transparent", paddingTop: 12 },
  inputFrozenText: { color: "#F0D798", fontSize: 13, lineHeight: 19, textAlign: "center" },
  inputFrozenRetry: {
    alignSelf: "center",
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#3A5BA8",
  },
  inputFrozenRetryPressed: { opacity: 0.7 },
  inputFrozenRetryText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
