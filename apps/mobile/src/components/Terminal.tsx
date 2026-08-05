/**
 * 终端视图:WebView 加载 daemon 托管的 term.html(xterm.js),
 * WS 保持在 RN 侧单连接,WebView 只做渲染与输入采集。
 * attach 流程:page ready → 上报 fit 尺寸 → resize → attach(带 lastSeq 续传)。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { HostConnection } from "@/lib/connection";
import { TERMINAL_HTML } from "./terminal-html";

interface Props {
  conn: HostConnection;
  sid: string;
  /** 捏合缩放后回报,让 A+/A− 的基准与终端保持一致 */
  onFontSize?: (size: number) => void;
}

export interface TerminalHandle {
  setFontSize(size: number): void;
  scrollToBottom(): void;
  /** 收起键盘 */
  blur(): void;
}

interface BridgeUp {
  kind: "ready" | "resized" | "input" | "perf" | "fontSize";
  renderer?: string;
  cols?: number;
  rows?: number;
  data?: string;
  fps?: number;
  kb?: number;
  size?: number;
}

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal(
  { conn, sid, onFontSize },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const attachedRef = useRef(false);
  const lastSeqRef = useRef(0);
  const queueRef = useRef<object[]>([]);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (!readyRef.current || !conn.isConnected || !sizeRef.current) return;
    conn.resize(sid, sizeRef.current.cols, sizeRef.current.rows);
    conn.attach(sid, lastSeqRef.current > 0 ? lastSeqRef.current : undefined);
    attachedRef.current = true;
  }, [conn, sid]);

  useEffect(() => {
    const offSnap = conn.events.on("snapshot", (m) => {
      if (m.sid !== sid) return;
      lastSeqRef.current = m.seq;
      rx({ kind: "snapshot", ansi: m.ansi, cols: m.cols, rows: m.rows });
    });
    const offOut = conn.events.on("output", (m) => {
      if (m.sid !== sid) return;
      lastSeqRef.current = m.seq;
      rx({ kind: "output", dataB64: m.dataB64 });
      if (!ackTimerRef.current) {
        ackTimerRef.current = setTimeout(() => {
          ackTimerRef.current = null;
          conn.ack(sid, lastSeqRef.current);
        }, 500);
      }
    });
    // 重连成功 → 带 lastSeq 重新 attach(增量续传或快照,由服务端裁决)
    const offConn = conn.events.on("connected", () => tryAttach());
    return () => {
      offSnap();
      offOut();
      offConn();
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      if (flushRef.current) clearTimeout(flushRef.current);
    };
  }, [conn, sid, rx, tryAttach]);

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
          readyRef.current = true;
          attachedRef.current = false;
          lastSeqRef.current = 0;
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
          if (!attachedRef.current) tryAttach();
          else conn.resize(sid, msg.cols, msg.rows);
          break;
        case "input":
          if (typeof msg.data === "string") conn.inputB64(sid, msg.data);
          break;
        case "fontSize":
          if (typeof msg.size === "number") onFontSize?.(msg.size);
          break;
        case "perf":
          // W4 spike:Metro 控制台可直接观测洪峰时的渲染帧率与吞吐
          console.log(
            `[term-perf] sid=${sid.slice(0, 8)} renderer=${msg.renderer} fps=${msg.fps} throughput=${msg.kb}KB/s`,
          );
          break;
      }
    },
    [conn, sid, tryAttach, rx, onFontSize],
  );

  useImperativeHandle(ref, () => ({
    setFontSize: (size: number) => rx({ kind: "font", size }),
    scrollToBottom: () => rx({ kind: "scrollBottom" }),
    blur: () => rx({ kind: "blur" }),
  }), [rx]);

  return (
    <View style={styles.wrap}>
      <WebView
        ref={webRef}
        source={{ html: TERMINAL_HTML }}
        onMessage={onMessage}
        style={styles.web}
        keyboardDisplayRequiresUserAction={false}
        // 不要 hideKeyboardAccessoryView:那条系统辅助栏上有「完成」和听写入口,
        // 隐藏它省下的一点高度,代价是键盘收不起来、也没法语音输入
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        webviewDebuggingEnabled
        originWhitelist={["*"]}
        bounces={false}
        overScrollMode="never"
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#0b0b0e" },
  web: { flex: 1, backgroundColor: "#0b0b0e" },
});
