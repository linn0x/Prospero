import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams } from "expo-router";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import type { FsEntry } from "@prospero/protocol";
import { Icon } from "@/components/Icon";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { useHostConnection } from "@/lib/use-host-connection";

/** 一次传 256KB;协议单块上限是 1MB,留足编码膨胀余量 */
const CHUNK = 256 * 1024;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 目录图标之外,给常见类型一点区分度 */
function iconFor(entry: FsEntry): "doc.on.doc" | "terminal" | "desktopcomputer" {
  if (entry.kind === "dir") return "desktopcomputer";
  return entry.name.endsWith(".sh") || entry.name.endsWith(".zsh") ? "terminal" : "doc.on.doc";
}

export default function FilesScreen(): React.ReactElement {
  const { hostId, sid } = useLocalSearchParams<{ hostId: string; sid: string }>();
  const { conn } = useHostConnection(hostId);
  const insets = useSafeAreaInsets();

  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 编辑态:null = 没在编辑
  const [editing, setEditing] = useState<{
    path: string;
    text: string;
    original: string;
    truncated: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      if (!conn) return;
      setLoading(true);
      setError(null);
      try {
        const listing = await conn.fsList(sid, path);
        setEntries(listing.entries);
        setDir(path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [conn, sid],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const openEntry = async (entry: FsEntry): Promise<void> => {
    const next = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.kind === "dir") {
      void load(next);
      return;
    }
    if (!conn) return;
    setBusy(entry.name);
    try {
      const content = await conn.fsRead(sid, next);
      if (content.binary) {
        Alert.alert("二进制文件", "无法作为文本编辑,可以用「下载」保存到手机。");
        return;
      }
      // RN 没有 Buffer;atob 处理 base64 足够,再按 UTF-8 解码
      const text = decodeUtf8(content.contentB64);
      setEditing({ path: next, text, original: text, truncated: content.truncated });
    } catch (e) {
      Alert.alert("打开失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!conn || !editing) return;
    if (editing.truncated) {
      Alert.alert("无法保存", "文件过大只读取了前 1MB,保存会截断原文件。");
      return;
    }
    setSaving(true);
    try {
      await conn.fsWrite(sid, editing.path, encodeUtf8(editing.text));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditing({ ...editing, original: editing.text });
    } catch (e) {
      Alert.alert("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const download = async (entry: FsEntry): Promise<void> => {
    if (!conn) return;
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    setBusy(entry.name);
    try {
      const parts: string[] = [];
      let offset = 0;
      for (;;) {
        const chunk = await conn.fsGetChunk(sid, rel, offset, CHUNK);
        parts.push(chunk.dataB64);
        offset += base64Bytes(chunk.dataB64);
        if (chunk.eof) break;
      }
      // 新版 expo-file-system 用 File/Paths 类,不再是模块级函数
      const local = new File(Paths.cache, entry.name);
      if (local.exists) local.delete();
      local.create();
      local.write(parts.join(""), { encoding: "base64" });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(local.uri);
      } else {
        Alert.alert("已下载", `保存在 ${local.uri}`);
      }
    } catch (e) {
      Alert.alert("下载失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (): Promise<void> => {
    if (!conn) return;
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0];
    if (!asset) return;

    setBusy(asset.name);
    try {
      const local = new File(asset.uri);
      const b64 = await local.base64();
      const total = base64Bytes(b64);
      // 按解码后的字节切块,再逐块转回 base64
      const bytes = decodeBase64ToBytes(b64);
      const target = dir === "" ? asset.name : `${dir}/${asset.name}`;
      for (let offset = 0; offset < Math.max(total, 1); offset += CHUNK) {
        const slice = bytes.subarray(offset, Math.min(offset + CHUNK, total));
        const final = offset + CHUNK >= total;
        await conn.fsPutChunk(sid, target, offset, encodeBase64(slice), final);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void load(dir);
    } catch (e) {
      Alert.alert("上传失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const goUp = (): void => {
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    void load(parent);
  };

  // ---------------------------------------------------------------- 编辑视图

  if (editing) {
    const dirty = editing.text !== editing.original;
    return (
      <View style={styles.screen}>
        <Stack.Screen
          options={{
            title: editing.path.split("/").pop() ?? editing.path,
            headerRight: () => (
              <Pressable onPress={() => void save()} disabled={!dirty || saving}>
                {saving ? (
                  <ActivityIndicator size="small" color="#7aa2f7" />
                ) : (
                  <Text style={[styles.headerAction, !dirty && styles.headerActionOff]}>保存</Text>
                )}
              </Pressable>
            ),
            headerLeft: () => (
              <Pressable
                onPress={() => {
                  if (!dirty) {
                    setEditing(null);
                    return;
                  }
                  Alert.alert("放弃修改?", "未保存的改动会丢失。", [
                    { text: "继续编辑", style: "cancel" },
                    { text: "放弃", style: "destructive", onPress: () => setEditing(null) },
                  ]);
                }}
              >
                <Text style={styles.headerAction}>返回</Text>
              </Pressable>
            ),
          }}
        />
        {editing.truncated && (
          <Text style={styles.warnBar}>文件超过 1MB,只显示前 1MB —— 只读,保存已禁用</Text>
        )}
        <TextInput
          style={styles.editor}
          value={editing.text}
          onChangeText={(text) => setEditing({ ...editing, text })}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={!editing.truncated}
        />
      </View>
    );
  }

  // ---------------------------------------------------------------- 浏览视图

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: "文件",
          // 必须显式给回 headerLeft:导航选项是合并而非重置的,
          // 编辑态设过的那个会残留下来,点了只调用 setEditing(null) —— 看起来就是"返回失效"。
          // 顺便让它在子目录里表现为"上一级",这也更符合层级浏览的直觉。
          headerLeft:
            dir === ""
              ? undefined
              : () => (
                  <Pressable onPress={goUp} hitSlop={8}>
                    <Text style={styles.headerAction}>上一级</Text>
                  </Pressable>
                ),
          headerRight: () => (
            <Pressable onPress={() => void upload()} hitSlop={8}>
              <Icon name="plus" size={20} color="#7aa2f7" />
            </Pressable>
          ),
        }}
      />

      <View style={styles.pathBar}>
        <Pressable onPress={goUp} disabled={dir === ""} hitSlop={8}>
          <Text style={[styles.up, dir === "" && styles.upOff]}>← 上级</Text>
        </Pressable>
        <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
          {dir === "" ? "/" : `/${dir}`}
        </Text>
      </View>

      {error !== null && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={entries}
        keyExtractor={(e) => e.name}
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void load(dir)} tintColor="#7aa2f7" />
        }
        ListEmptyComponent={
          loading ? null : <Text style={styles.empty}>这个目录是空的</Text>
        }
        renderItem={({ item }) => {
          // 目录没什么可下载的,只有文件给左滑操作
          const actions: SwipeAction[] =
            item.kind === "file"
              ? [
                  {
                    label: "下载",
                    symbol: "arrow.up",
                    color: "#3a6ea5",
                    onPress: () => void download(item),
                  },
                ]
              : [];
          const row = (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => void openEntry(item)}
            >
              <Icon
                name={iconFor(item)}
                size={17}
                color={item.kind === "dir" ? "#7aa2f7" : "#8a8a96"}
              />
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
                {item.kind === "dir" ? "/" : ""}
              </Text>
              {busy === item.name ? (
                <ActivityIndicator size="small" color="#7aa2f7" />
              ) : (
                item.kind === "file" && <Text style={styles.size}>{humanSize(item.size)}</Text>
              )}
            </Pressable>
          );
          return actions.length > 0 ? <SwipeRow actions={actions}>{row}</SwipeRow> : row;
        }}
      />
      <Text style={styles.hint}>左滑文件下载 · 右上角 ＋ 上传到当前目录</Text>
    </View>
  );
}

// ---------------------------------------------------------------- base64 / utf8
// RN 没有 Buffer;这些是围绕 atob/btoa 的最小封装。

function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return globalThis.btoa(bin);
}

function base64Bytes(b64: string): number {
  return b64.length === 0 ? 0 : decodeBase64ToBytes(b64).length;
}

function decodeUtf8(b64: string): string {
  return new TextDecoder().decode(decodeBase64ToBytes(b64));
}

function encodeUtf8(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b0b0e" },
  pathBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#26262e",
  },
  up: { color: "#7aa2f7", fontSize: 14 },
  upOff: { color: "#3a3a44" },
  path: { color: "#8a8a96", fontSize: 13, flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1c1c22",
  },
  rowPressed: { backgroundColor: "#16161c" },
  name: { color: "#e8e8ee", fontSize: 15, flex: 1 },
  size: { color: "#5a5a66", fontSize: 12 },
  empty: { color: "#5a5a66", textAlign: "center", marginTop: 40 },
  error: { color: "#e5534b", paddingHorizontal: 16, paddingVertical: 10, fontSize: 13 },
  hint: {
    color: "#5a5a66",
    fontSize: 11,
    textAlign: "center",
    paddingVertical: 8,
  },
  editor: {
    flex: 1,
    color: "#e8e8ee",
    fontFamily: "Menlo",
    fontSize: 13,
    padding: 14,
    textAlignVertical: "top",
  },
  warnBar: {
    backgroundColor: "#3a2f14",
    color: "#d9a441",
    fontSize: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  headerAction: { color: "#7aa2f7", fontSize: 16 },
  headerActionOff: { color: "#3a3a44" },
});
