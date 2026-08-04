/**
 * 终端视图:WebView 加载 daemon 托管的 term.html(xterm.js),
 * WS 保持在 RN 侧单连接,WebView 只做渲染与输入采集。
 * attach 流程:page ready → 上报 fit 尺寸 → resize → attach(带 lastSeq 续传)。
 */
import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { HostConnection } from "@/lib/connection";

interface Props {
  conn: HostConnection;
  sid: string;
}

interface BridgeUp {
  kind: "ready" | "resized" | "input";
  renderer?: string;
  cols?: number;
  rows?: number;
  data?: string;
}

export function Terminal({ conn, sid }: Props) {
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const attachedRef = useRef(false);
  const lastSeqRef = useRef(0);
  const queueRef = useRef<object[]>([]);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rx = useCallback((obj: object) => {
    if (!readyRef.current) {
      queueRef.current.push(obj);
      return;
    }
    webRef.current?.injectJavaScript(
      `window.__rx(${JSON.stringify(JSON.stringify(obj))});true;`,
    );
  }, []);

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
          queueRef.current = [];
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
      }
    },
    [conn, sid, tryAttach],
  );

  const addr = conn.activeAddr ?? conn.host.addrs[0] ?? "127.0.0.1";
  const uri = `http://${addr}:${conn.host.port}/term.html`;

  return (
    <View style={styles.wrap}>
      <WebView
        key={uri}
        ref={webRef}
        source={{ uri }}
        onMessage={onMessage}
        style={styles.web}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        webviewDebuggingEnabled
        originWhitelist={["*"]}
        bounces={false}
        overScrollMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#0b0b0e" },
  web: { flex: 1, backgroundColor: "#0b0b0e" },
});
