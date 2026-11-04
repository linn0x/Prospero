/**
 * 终端视图:WebView 加载 daemon 托管的 term.html(xterm.js),
 * WS 保持在 RN 侧单连接,WebView 只做渲染与输入采集。
 * attach 流程:page ready → 上报 fit 尺寸 → resize → attach(带 lastSeq 续传)。
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { findNodeHandle, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import type { HostConnection } from "@/lib/connection";
import { toast } from "@/components/Toast";
import { deliveryFailureText, type DeliveryResult } from "@/lib/outbound-queue";
import { subscribeFocusedTerminal } from "@/lib/focused-session-stream";
import { useFocusedSessionEffect } from "@/lib/use-focused-session-effect";
import { TERMINAL_HTML, TERMINAL_FONT_FAMILY } from "./terminal-html";
import ProsperoGhosttyModule from "../../modules/prospero-ghostty/src/ProsperoGhosttyModule";
import ProsperoGhosttyView from "../../modules/prospero-ghostty/src/ProsperoGhosttyView";
import type { ProsperoGhosttyEvent } from "../../modules/prospero-ghostty/src/ProsperoGhostty.types";

// source 对象保持稳定,避免会话状态刷新时让原生 WebView 误判为需要重新加载。
const TERMINAL_SOURCE = { html: TERMINAL_HTML } as const;
const TAIL_ATTACH_EVENTS = 160;

interface Props {
  conn: HostConnection;
  sid: string;
  /** 由原生层控制；WebView 就绪和后续变化都会收到 font 消息。 */
  fontSize: number;
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
  disconnectedMessage?: string;
  onRetryConnection?: () => void;
}

export interface TerminalHandle {
  scrollToBottom(): void;
  /** 收起键盘 */
  blur(): void;
  copyAll(): void;
  search(text: string, previous?: boolean, incremental?: boolean): void;
  paste(text: string): Promise<DeliveryResult>;
}

interface BridgeUp {
  kind: "ready" | "resized" | "input" | "pasteInput" | "clipboardCopy" | "clipboardPaste" | "perf" | "fontSize";
  requestId?: number;
  renderer?: string;
  cols?: number;
  rows?: number;
  data?: string;
  text?: string;
  fps?: number;
  kb?: number;
  size?: number;
}

const TerminalInner = forwardRef<TerminalHandle, Props>(function Terminal(
  {
    conn,
    sid,
    fontSize,
    onFontSize,
    layoutKey,
    onPerf,
    inputEnabled = true,
    sessionEnded = false,
    endedActions,
    onInputB64,
    onPasteB64,
    disconnectedMessage = "主机未连接；终端输入已冻结。",
    onRetryConnection,
  },
  ref,
) {
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
  const fontSizeRef = useRef(fontSize);
  const pasteIdRef = useRef(0);
  const focusEpochRef = useRef(0);
  const pastesRef = useRef(new Map<number, { resolve: (result: DeliveryResult) => void; timer: ReturnType<typeof setTimeout> }>());
  const cancelPastes = useCallback(() => {
    focusEpochRef.current++;
    for (const pending of pastesRef.current.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, reason: "offline" });
    }
    pastesRef.current.clear();
  }, []);
  useEffect(() => { if (!inputEnabled) cancelPastes(); }, [inputEnabled, cancelPastes]);
  useEffect(() => cancelPastes, [cancelPastes]);
  useEffect(() => conn.events.on("disconnected", cancelPastes), [conn, cancelPastes]);

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

  const tryAttach = useCallback(() => {
    if (!activeRef.current || !readyRef.current || !conn.isConnected || !sizeRef.current) return;
    if (!sessionEnded) conn.resize(sid, sizeRef.current.cols, sizeRef.current.rows);
    const lastSeq = lastSeqRef.current > 0 ? lastSeqRef.current : undefined;
    conn.attach(sid, lastSeq, lastSeq === undefined && conn.supportsTerminalTailAttach ? { tailEvents: TAIL_ATTACH_EVENTS } : undefined);
    attachedRef.current = true;
  }, [conn, sid, sessionEnded]);

  // font 不走 shell 输入通道，也不影响 attach；WebView 自己在收到 font 后 fit，
  // 这样首次 resized/attach 已经使用正确字号。系统 Dynamic Type 变更则由受控 prop
  // 触发同一条桥接消息，不重建 WebView 或 shell 会话。
  useEffect(() => {
    fontSizeRef.current = fontSize;
    if (readyRef.current) rx({ kind: "font", size: fontSize, family: TERMINAL_FONT_FAMILY });
  }, [fontSize, rx]);

  useEffect(() => {
    metricsRef.current = onPerf !== undefined;
    if (readyRef.current) rx({ kind: "activity", active: activeRef.current, metrics: metricsRef.current });
  }, [onPerf, rx]);

  useFocusedSessionEffect(useCallback(() => {
    activeRef.current = true;
    if (readyRef.current) rx({ kind: "activity", active: true, metrics: metricsRef.current });
    const cleanup = subscribeFocusedTerminal({
      conn, sid, cursor: lastSeqRef,
      snapshot: (message) => rx({ kind: "snapshot", ansi: message.ansi, dataB64: message.dataB64, cols: message.cols, rows: message.rows }),
      output: (message) => rx(message.events ? { kind: "events", events: message.events, replay: message.replay } : { kind: "output", dataB64: message.dataB64 }),
      flush,
      attach: tryAttach,
    });
    return () => {
      activeRef.current = false;
      cancelPastes();
      cleanup();
      attachedRef.current = false;
      if (readyRef.current) {
        rx({ kind: "blur" });
        rx({ kind: "activity", active: false, metrics: false });
        flush();
      }
    };
  }, [conn, sid, flush, rx, tryAttach, cancelPastes]));

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
          // 页面(重新)加载:内容为空,必须全量快照
          cancelPastes();
          readyRef.current = true;
          attachedRef.current = false;
          lastSeqRef.current = 0;
          rx({ kind: "activity", active: activeRef.current, metrics: metricsRef.current });
          // term.html 在收到 font 后才允许首次 fit，因此它产生的 resized/attach
          // 必然反映这一受控字号。字体消息排在重放输出之前，避免初始帧闪回默认值。
          rx({ kind: "font", size: fontSizeRef.current, family: TERMINAL_FONT_FAMILY });
          // 之前这里直接清空队列 —— 页面就绪前到达的消息被丢掉了。
          // 现在补发,后续的全量快照会覆盖它们,但丢弃从来不是对的默认。
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
            tryAttach();
          } else if (!sessionEnded) conn.resize(sid, msg.cols, msg.rows);
          break;
        case "input":
          if (activeRef.current && typeof msg.data === "string" && inputEnabled) {
            const result = onInputB64 ? onInputB64(msg.data) : conn.inputB64(sid, msg.data);
            if (!result.accepted) toast(deliveryFailureText(result));
          }
          break;
        case "clipboardCopy":
          if (activeRef.current && typeof msg.text === "string" && msg.text.length > 0) {
            void Clipboard.setStringAsync(msg.text).then(() => toast("已复制终端内容"), () => toast("无法复制终端内容"));
          }
          break;
        case "clipboardPaste":
          // A hardware keyboard shortcut uses the same checked paste path as the toolbar.
          if (activeRef.current && inputEnabled) {
            const epoch = focusEpochRef.current;
            void Clipboard.getStringAsync().then((text) => {
              if (focusEpochRef.current !== epoch) return;
              if (!text) { toast("剪贴板是空的"); return; }
              void requestPaste(text).then((result) => { if (!result.accepted) toast(deliveryFailureText(result)); });
            }, () => toast("无法读取剪贴板"));
          }
          break;
        case "pasteInput": {
          if (typeof msg.requestId !== "number") break;
          const pending = pastesRef.current.get(msg.requestId);
          if (!pending) break;
          pastesRef.current.delete(msg.requestId);
          clearTimeout(pending.timer);
          const result = activeRef.current && inputEnabled && conn.isConnected && typeof msg.data === "string" && msg.data.length > 0
            ? (onPasteB64 ? onPasteB64(msg.data) : conn.inputB64(sid, msg.data))
            : { accepted: false as const, reason: "offline" as const };
          pending.resolve(result);
          break;
        }
        case "fontSize":
          if (activeRef.current && typeof msg.size === "number") onFontSize?.(msg.size);
          break;
        case "perf":
          // Release 构建里 console.log 被剥掉,验收要看数就必须走 UI
          if (activeRef.current && typeof msg.fps === "number" && typeof msg.kb === "number") {
            onPerf?.({ fps: msg.fps, kb: msg.kb, renderer: msg.renderer ?? "?" });
          }
          break;
      }
    },
    [conn, sid, tryAttach, rx, onFontSize, onPerf, inputEnabled, onInputB64, onPasteB64, cancelPastes, sessionEnded, requestPaste],
  );

  // 转屏/折叠后，快照里逐行定位的历史没有自动换行标记,xterm 只能截断、不能重排。
  // 服务端的终端模型会按新宽度重排，所以等新尺寸报上去之后重新要一份完整快照。
  useEffect(() => {
    if (!readyRef.current) return;
    resnapshotRef.current = true;
    rx({ kind: "fit" });
  }, [layoutKey, rx]);

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => rx({ kind: "scrollBottom" }),
    blur: () => rx({ kind: "blur" }),
    copyAll: () => rx({ kind: "copyAll" }),
    search: (text, previous = false, incremental = false) => rx({ kind: "search", text, previous, incremental }),
    paste: requestPaste,
  }), [rx, requestPaste]);

  return (
    <View style={styles.wrap}>
      <WebView
        ref={webRef}
        source={TERMINAL_SOURCE}
        onMessage={onMessage}
        style={styles.web}
        keyboardDisplayRequiresUserAction={false}
        // 不要 hideKeyboardAccessoryView:那条系统辅助栏上有「完成」和听写入口,
        // 隐藏它省下的一点高度,代价是键盘收不起来、也没法语音输入
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        webviewDebuggingEnabled={__DEV__}
        // 不要 androidLayerType="hardware":WebView 本身已走 GPU 合成,再套一层
        // 离屏 layer 在折叠屏展开这类大幅尺寸跳变后不会及时重建,新露出的
        // 区域直接显示成白块。
        originWhitelist={["*"]}
        bounces={false}
        overScrollMode="never"
        automaticallyAdjustContentInsets={false}
      />
      {!inputEnabled && (
        <View style={[styles.inputFrozen, sessionEnded && styles.endedNotice]} pointerEvents={sessionEnded ? "box-none" : "auto"}>
          <View
            style={styles.inputFrozenCard}
            accessible={!sessionEnded}
            accessibilityLiveRegion="polite"
            accessibilityLabel={disconnectedMessage}
          >
            <Text style={styles.inputFrozenText}>{disconnectedMessage}</Text>
            {sessionEnded && endedActions}
            {onRetryConnection && (
              <Pressable
                style={({ pressed }) => [styles.inputFrozenRetry, pressed && styles.inputFrozenRetryPressed]}
                onPress={onRetryConnection}
                accessibilityRole="button"
                accessibilityLabel="重新连接主机后继续终端输入"
              >
                <Text style={styles.inputFrozenRetryText}>重试连接</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
});

const NativeGhosttyTerminalInner = forwardRef<TerminalHandle, Props>(function NativeGhosttyTerminal(
  {
    conn,
    sid,
    fontSize,
    onFontSize,
    layoutKey,
    onPerf,
    inputEnabled = true,
    sessionEnded = false,
    endedActions,
    onInputB64,
    onPasteB64,
    disconnectedMessage = "主机未连接；终端输入已冻结。",
    onRetryConnection,
  },
  ref,
) {
  const nativeRef = useRef<View>(null);
  const activeRef = useRef(false);
  const readyRef = useRef(false);
  const attachedRef = useRef(false);
  const lastSeqRef = useRef(0);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resnapshotRef = useRef(false);
  const focusEpochRef = useRef(0);
  const tag = useCallback(() => {
    const handle = findNodeHandle(nativeRef.current);
    return typeof handle === "number" ? handle : null;
  }, []);

  useEffect(() => () => conn.detach(sid), [conn, sid]);

  const cancelPastes = useCallback(() => {
    focusEpochRef.current++;
  }, []);
  useEffect(() => { if (!inputEnabled) cancelPastes(); }, [inputEnabled, cancelPastes]);
  useEffect(() => conn.events.on("disconnected", cancelPastes), [conn, cancelPastes]);

  const tryAttach = useCallback(() => {
    if (!activeRef.current || !readyRef.current || !conn.isConnected || !sizeRef.current) return;
    if (!sessionEnded) conn.resize(sid, sizeRef.current.cols, sizeRef.current.rows);
    const lastSeq = lastSeqRef.current > 0 ? lastSeqRef.current : undefined;
    conn.attach(sid, lastSeq, lastSeq === undefined && conn.supportsTerminalTailAttach ? { tailEvents: TAIL_ATTACH_EVENTS } : undefined);
    attachedRef.current = true;
  }, [conn, sid, sessionEnded]);

  useFocusedSessionEffect(useCallback(() => {
    activeRef.current = true;
    const cleanup = subscribeFocusedTerminal({
      conn,
      sid,
      cursor: lastSeqRef,
      snapshot: (message) => {
        const viewTag = tag();
        if (viewTag !== null) ProsperoGhosttyModule?.snapshot(viewTag, message.dataB64 ?? null, message.ansi ?? null, message.cols, message.rows);
      },
      output: (message) => {
        const viewTag = tag();
        if (viewTag === null) return;
        if (message.events) ProsperoGhosttyModule?.events(viewTag, JSON.stringify({ events: message.events, replay: message.replay === true }));
        else ProsperoGhosttyModule?.write(viewTag, message.dataB64);
      },
      flush: () => undefined,
      attach: tryAttach,
    });
    return () => {
      activeRef.current = false;
      cancelPastes();
      cleanup();
      attachedRef.current = false;
      const viewTag = tag();
      if (viewTag !== null) ProsperoGhosttyModule?.blur(viewTag);
    };
  }, [conn, sid, tag, tryAttach, cancelPastes]));

  const onReady = useCallback((event: { nativeEvent: ProsperoGhosttyEvent }) => {
    readyRef.current = true;
    attachedRef.current = false;
    lastSeqRef.current = 0;
    const cols = event.nativeEvent.cols;
    const rows = event.nativeEvent.rows;
    if (typeof cols === "number" && typeof rows === "number") sizeRef.current = { cols, rows };
    tryAttach();
  }, [tryAttach]);

  const onResize = useCallback((event: { nativeEvent: ProsperoGhosttyEvent }) => {
    const cols = event.nativeEvent.cols;
    const rows = event.nativeEvent.rows;
    if (typeof cols !== "number" || typeof rows !== "number") return;
    sizeRef.current = { cols, rows };
    if (!activeRef.current) return;
    if (!attachedRef.current) tryAttach();
    else if (resnapshotRef.current && !sessionEnded) {
      resnapshotRef.current = false;
      lastSeqRef.current = 0;
      tryAttach();
    } else if (!sessionEnded) conn.resize(sid, cols, rows);
  }, [conn, sid, tryAttach, sessionEnded]);

  const onInput = useCallback((event: { nativeEvent: ProsperoGhosttyEvent }) => {
    const data = event.nativeEvent.data;
    if (!activeRef.current || typeof data !== "string" || !inputEnabled) return;
    const result = onInputB64 ? onInputB64(data) : conn.inputB64(sid, data);
    if (!result.accepted) toast(deliveryFailureText(result));
  }, [conn, sid, inputEnabled, onInputB64]);

  const onClipboardCopy = useCallback((event: { nativeEvent: ProsperoGhosttyEvent }) => {
    const text = event.nativeEvent.text;
    if (activeRef.current && typeof text === "string" && text.length > 0) {
      void Clipboard.setStringAsync(text).then(() => toast("已复制终端内容"), () => toast("无法复制终端内容"));
    }
  }, []);

  const onClipboardPaste = useCallback(() => {
    if (!activeRef.current || !inputEnabled) return;
    const epoch = focusEpochRef.current;
    void Clipboard.getStringAsync().then((text) => {
      if (focusEpochRef.current !== epoch) return;
      if (!text) { toast("剪贴板是空的"); return; }
      const viewTag = tag();
      if (viewTag !== null) ProsperoGhosttyModule?.paste(viewTag, text);
    }, () => toast("无法读取剪贴板"));
  }, [inputEnabled, tag]);

  const onNativeFontSize = useCallback((event: { nativeEvent: ProsperoGhosttyEvent }) => {
    const size = event.nativeEvent.size;
    if (activeRef.current && typeof size === "number") onFontSize?.(size);
  }, [onFontSize]);

  const onNativePerf = useCallback((event: { nativeEvent: ProsperoGhosttyEvent }) => {
    const { fps, kb, renderer } = event.nativeEvent;
    if (activeRef.current && typeof fps === "number" && typeof kb === "number") {
      onPerf?.({ fps, kb, renderer: renderer ?? "ghostty" });
    }
  }, [onPerf]);

  const onUnavailable = useCallback((event: { nativeEvent: ProsperoGhosttyEvent }) => {
    const reason = event.nativeEvent.reason;
    if (typeof reason === "string" && reason) toast(reason);
  }, []);

  useEffect(() => {
    if (!readyRef.current) return;
    resnapshotRef.current = true;
    const viewTag = tag();
    if (viewTag !== null) ProsperoGhosttyModule?.scrollToBottom(viewTag);
  }, [layoutKey, tag]);

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      const viewTag = tag();
      if (viewTag !== null) ProsperoGhosttyModule?.scrollToBottom(viewTag);
    },
    blur: () => {
      const viewTag = tag();
      if (viewTag !== null) ProsperoGhosttyModule?.blur(viewTag);
    },
    copyAll: () => {
      const viewTag = tag();
      if (viewTag !== null) ProsperoGhosttyModule?.copyAll(viewTag);
    },
    search: (text, previous = false, incremental = false) => {
      const viewTag = tag();
      if (viewTag !== null) ProsperoGhosttyModule?.search(viewTag, text, previous, incremental);
    },
    paste: (text) => {
      const viewTag = tag();
      if (viewTag === null) return Promise.resolve({ accepted: false, reason: "offline" });
      ProsperoGhosttyModule?.paste(viewTag, text);
      return Promise.resolve(inputEnabled ? { accepted: true, disposition: "sent" } : { accepted: false, reason: "offline" });
    },
  }), [tag, inputEnabled]);

  if (!ProsperoGhosttyView) return null;

  return (
    <View style={styles.wrap}>
      <ProsperoGhosttyView
        ref={nativeRef}
        style={styles.native}
        active={activeRef.current}
        fontSize={fontSize}
        inputEnabled={inputEnabled}
        onReady={onReady}
        onUnavailable={onUnavailable}
        onResize={onResize}
        onInput={onInput}
        onClipboardCopy={onClipboardCopy}
        onClipboardPaste={onClipboardPaste}
        onFontSize={onNativeFontSize}
        onPerf={onNativePerf}
      />
      {!inputEnabled && (
        <View style={[styles.inputFrozen, sessionEnded && styles.endedNotice]} pointerEvents={sessionEnded ? "box-none" : "auto"}>
          <View
            style={styles.inputFrozenCard}
            accessible={!sessionEnded}
            accessibilityLiveRegion="polite"
            accessibilityLabel={disconnectedMessage}
          >
            <Text style={styles.inputFrozenText}>{disconnectedMessage}</Text>
            {sessionEnded && endedActions}
            {onRetryConnection && (
              <Pressable
                style={({ pressed }) => [styles.inputFrozenRetry, pressed && styles.inputFrozenRetryPressed]}
                onPress={onRetryConnection}
                accessibilityRole="button"
                accessibilityLabel="重新连接主机后继续终端输入"
              >
                <Text style={styles.inputFrozenRetryText}>重试连接</Text>
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
export const Terminal = memo(forwardRef<TerminalHandle, Props>(function Terminal(props, ref) {
  const [nativeGhostty, setNativeGhostty] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android" || !ProsperoGhosttyModule || !ProsperoGhosttyView) {
      setNativeGhostty(false);
      return;
    }
    const availability = ProsperoGhosttyModule.availability();
    setNativeGhostty(availability.available === true);
  }, []);
  const key = `${props.conn.host.id}\u0000${props.sid}`;
  return nativeGhostty
    ? <NativeGhosttyTerminalInner key={key} {...props} ref={ref} />
    : <TerminalInner key={key} {...props} ref={ref} />;
}));

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#16171a" },
  web: { flex: 1, backgroundColor: "#16171a" },
  native: { flex: 1, backgroundColor: "#16171a" },
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
