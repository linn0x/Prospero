import { memo, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { InlineSpan } from "@/lib/markdown";
import { mathMl } from "@/lib/math";

type TextVariant = "body" | "heading" | "headingSmall" | "quote" | "table" | "tableHeader";

const variants: Record<
  TextVariant,
  { color: string; fontSize: number; lineHeight: number; weight: number }
> = {
  body: { color: "#e8e8ee", fontSize: 15, lineHeight: 22, weight: 400 },
  heading: { color: "#ffffff", fontSize: 17, lineHeight: 24, weight: 700 },
  headingSmall: { color: "#ffffff", fontSize: 15, lineHeight: 22, weight: 700 },
  quote: { color: "#a8a8b4", fontSize: 14, lineHeight: 21, weight: 400 },
  table: { color: "#d8d8e1", fontSize: 12.5, lineHeight: 18, weight: 400 },
  tableHeader: { color: "#f3f3f8", fontSize: 12.5, lineHeight: 18, weight: 700 },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formulaMarkup(expression: string, display: boolean): string {
  if (expression.trim() === "") return `<code>${display ? "\\[" : "$"}</code>`;
  try {
    return mathMl(expression, display);
  } catch {
    // 错误文本必须转义；KaTeX 的异常会包含原始表达式，不能原样塞进 HTML。
    return `<code>${escapeHtml(display ? `\\[${expression}\\]` : `$${expression}$`)}</code>`;
  }
}

function spansMarkup(spans: InlineSpan[]): string {
  return spans
    .map((span) => {
      if (span.math === true) return formulaMarkup(span.text, false);
      const classes = [
        span.code === true ? "code" : "",
        span.bold === true ? "bold" : "",
        span.italic === true ? "italic" : "",
        span.href !== undefined ? "link" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<span${classes ? ` class="${classes}"` : ""}>${escapeHtml(span.text)}</span>`;
    })
    .join("");
}

const RESIZE_SCRIPT = `
  (function () {
    var last = 0;
    function report() {
      var root = document.getElementById("root");
      var height = Math.ceil(Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        root ? root.getBoundingClientRect().height : 0
      ));
      if (height !== last) {
        last = height;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "size", height: height }));
      }
    }
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(report).observe(document.body);
    requestAnimationFrame(report);
    setTimeout(report, 80);
  })();
  true;
`;

function documentHtml(
  markup: string,
  options: { display: boolean; variant: TextVariant },
): string {
  const style = variants[options.variant];
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <style>
    :root { color-scheme: dark; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      background: transparent;
      overflow: hidden;
      -webkit-user-select: text;
      user-select: text;
    }
    body {
      color: ${style.color};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: ${String(style.fontSize)}px;
      font-weight: ${String(style.weight)};
      line-height: ${String(style.lineHeight)}px;
    }
    #root {
      box-sizing: border-box;
      width: 100%;
      min-height: ${String(style.lineHeight)}px;
      padding: ${options.display ? "8px 2px" : "0"};
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      ${options.display ? "display: flex; justify-content: center; overflow-x: auto;" : ""}
    }
    math { color: inherit; font-size: 1.08em; font-family: serif; }
    code, .code {
      color: #9ad0a5;
      background: #1a1f1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.88em;
    }
    .bold { font-weight: 700; }
    .italic { font-style: italic; }
    .link { color: #8eb2ff; text-decoration: underline; }
  </style>
</head>
<body><div id="root">${markup}</div></body>
</html>`;
}

function AutoHeightMath({
  markup,
  display,
  variant,
  fallback,
}: {
  markup: string;
  display: boolean;
  variant: TextVariant;
  fallback: string;
}) {
  const lineHeight = variants[variant].lineHeight;
  const [height, setHeight] = useState(display ? 52 : lineHeight + 2);
  const [failed, setFailed] = useState(false);
  const html = useMemo(() => documentHtml(markup, { display, variant }), [markup, display, variant]);
  // WebView 会把 source 对象身份变化视为新文档；高度回报触发重渲染时不能反复重载。
  const source = useMemo(() => ({ html }), [html]);

  if (failed) {
    return <Text style={[styles.fallback, display && styles.displayFallback]}>{fallback}</Text>;
  }

  return (
    <View style={[styles.container, { height }]}>
      <WebView
        source={source}
        style={styles.webView}
        containerStyle={styles.webView}
        originWhitelist={["about:blank", "data:text/html*"]}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" || request.url.startsWith("data:text/html")
        }
        injectedJavaScript={RESIZE_SCRIPT}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data) as { type?: string; height?: number };
            if (data.type !== "size" || typeof data.height !== "number") return;
            setHeight(Math.max(display ? 44 : lineHeight, Math.min(data.height, 480)));
          } catch {
            // 来自本地文档的非尺寸消息无需处理。
          }
        }}
        onError={() => setFailed(true)}
        javaScriptEnabled
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        mixedContentMode="never"
        scrollEnabled={display}
        textInteractionEnabled
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

export const MathFormula = memo(function MathFormula({ expression }: { expression: string }) {
  const markup = useMemo(() => formulaMarkup(expression, true), [expression]);
  return (
    <AutoHeightMath
      markup={markup}
      display
      variant="body"
      fallback={`\\[${expression}\\]`}
    />
  );
});

export const MathSpans = memo(function MathSpans({
  spans,
  variant = "body",
}: {
  spans: InlineSpan[];
  variant?: TextVariant;
}) {
  const markup = useMemo(() => spansMarkup(spans), [spans]);
  return (
    <AutoHeightMath
      markup={markup}
      display={false}
      variant={variant}
      fallback={spans.map((span) => (span.math ? `$${span.text}$` : span.text)).join("")}
    />
  );
});

const styles = StyleSheet.create({
  container: { width: "100%", overflow: "hidden", backgroundColor: "transparent" },
  webView: { flex: 1, backgroundColor: "transparent" },
  fallback: { color: "#e8e8ee", fontSize: 15, lineHeight: 22 },
  displayFallback: {
    fontFamily: "monospace",
    color: "#d8d8e1",
    backgroundColor: "#15151b",
    padding: 8,
  },
});
