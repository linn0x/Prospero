import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/Toast";
import { color, MONOSPACE_FONT } from "@/lib/theme";
import { useHostConnection } from "@/lib/use-host-connection";

interface PreviewResult {
  contentB64: string;
  text: string | null;
  size: number;
  truncated: boolean;
  binary: boolean;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

function decodeUtf8(b64: string): string {
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function imageMime(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return null;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilePreviewScreen(): React.ReactElement {
  const { hostId, sid, path: filePath, line: rawLine, column: rawColumn } =
    useLocalSearchParams<{
      hostId: string;
      sid: string;
      path: string;
      line?: string;
      column?: string;
    }>();
  const { conn } = useHostConnection(hostId);
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const line = positiveInt(rawLine);
  const column = positiveInt(rawColumn);

  const load = useCallback((): void => {
    if (!conn || !sid || !filePath) return;
    setLoading(true);
    setError(null);
    void conn
      .fsRead(sid, filePath)
      .then((response) => {
        setResult({
          contentB64: response.contentB64,
          text: response.binary ? null : decodeUtf8(response.contentB64),
          size: response.size,
          truncated: response.truncated,
          binary: response.binary,
        });
      })
      .catch((reason: unknown) => {
        setResult(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
  }, [conn, sid, filePath]);

  useEffect(() => {
    // 延后一拍启动，避免在 effect 主体同步触发多次状态更新。
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const previewText = result?.text;
  const referencedLine = useMemo(() => {
    if (!previewText || line === undefined) return null;
    return previewText.split("\n")[line - 1] ?? null;
  }, [previewText, line]);
  const mime = imageMime(filePath ?? "");
  const fileName = filePath?.split("/").pop() ?? "文件预览";

  const copy = (): void => {
    if (!result?.text) return;
    void Clipboard.setStringAsync(result.text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast("已复制文件内容");
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: fileName,
          headerBackTitle: "对话",
          headerRight: () =>
            result?.text ? (
              <Pressable onPress={copy} hitSlop={8} accessibilityRole="button">
                <Text style={styles.headerAction}>复制</Text>
              </Pressable>
            ) : null,
        }}
      />

      <View style={styles.pathBar}>
        <Icon name="doc.fill" size={14} color={color.accent} />
        <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">
          {filePath}
        </Text>
        {result ? <Text style={styles.size}>{humanSize(result.size)}</Text> : null}
      </View>

      {referencedLine !== null && (
        <View style={styles.referenceLine}>
          <Text style={styles.referenceLabel}>
            L{String(line)}{column !== undefined ? `:${String(column)}` : ""}
          </Text>
          <Text style={styles.referenceCode} numberOfLines={3} selectable>
            {referencedLine || " "}
          </Text>
        </View>
      )}

      {result?.truncated === true && (
        <Text style={styles.warn}>文件超过 1 MB，只预览前 1 MB。</Text>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.accent} />
          <Text style={styles.dim}>正在从电脑读取…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Icon name="exclamationmark.triangle.fill" size={25} color={color.warn} />
          <Text style={styles.error}>{error}</Text>
          <Pressable style={styles.retry} onPress={load} accessibilityRole="button">
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : result?.text !== null && result ? (
        <TextInput
          style={[styles.code, { paddingBottom: insets.bottom + 16 }]}
          value={result.text}
          editable={false}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      ) : result && mime && !result.truncated ? (
        <Image
          style={styles.image}
          source={{ uri: `data:${mime};base64,${result.contentB64}` }}
          resizeMode="contain"
        />
      ) : (
        <View style={styles.center}>
          <Icon name="doc.fill" size={30} color={color.textFaint} />
          <Text style={styles.dim}>这是二进制文件，暂不支持内嵌预览。</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  headerAction: { color: color.accent, fontSize: 16, fontWeight: "500" },
  pathBar: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
    backgroundColor: color.surface,
  },
  path: { flex: 1, color: color.textDim, fontSize: 12, fontFamily: MONOSPACE_FONT },
  size: { color: color.textFaint, fontSize: 10 },
  referenceLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: color.accentBg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2C3A62",
  },
  referenceLabel: { color: color.accent, fontSize: 11, fontWeight: "700", fontFamily: MONOSPACE_FONT },
  referenceCode: { flex: 1, color: color.text, fontSize: 11, lineHeight: 16, fontFamily: MONOSPACE_FONT },
  warn: { color: color.warn, backgroundColor: color.warnBg, fontSize: 11, paddingHorizontal: 14, paddingVertical: 7 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 28 },
  dim: { color: color.textDim, fontSize: 13, textAlign: "center" },
  error: { color: color.warn, fontSize: 13, lineHeight: 19, textAlign: "center" },
  retry: { marginTop: 4, backgroundColor: color.accentDim, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 9 },
  retryText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  code: {
    flex: 1,
    color: color.text,
    backgroundColor: color.bg,
    fontFamily: MONOSPACE_FONT,
    fontSize: 12,
    lineHeight: 18,
    padding: 14,
    textAlignVertical: "top",
  },
  image: { flex: 1, margin: 14, backgroundColor: color.surface },
});
