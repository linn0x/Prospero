import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { FsEntry } from "@prospero/protocol";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import type { HostConnection } from "@/lib/connection";
import { color, font, radius, space } from "@/lib/theme";

type Selection = { path: string; cwd: string };

function initialWindowsLocation(cwd: string): { root: string; path: string } | null {
  const match = /^([A-Za-z]:)[\\/](.*)$/.exec(cwd.trim());
  if (!match) return null;
  return { root: match[1]!.toUpperCase(), path: match[2]!.replace(/\\/g, "/") };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function detailFor(entry: FsEntry): string {
  if (entry.kind === "dir") return "文件夹";
  if (entry.kind === "file") return humanSize(entry.size);
  if (entry.kind === "symlink") return "符号链接";
  return "其他项目";
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/workspace\.list|invalid discriminator|unrecognized|bad_message/i.test(message)) {
    return "电脑端服务版本较旧，暂时无法预览目录。关闭后仍可手动输入完整路径。";
  }
  return message;
}

/**
 * 新建会话前的工作目录选择器。
 *
 * 它只浏览 daemon 用户的 home，文件只作上下文预览、不可误选；需要 home
 * 之外的目录时，创建表单仍保留完整路径输入框。
 */
export function WorkspacePicker({
  visible,
  conn,
  initialPath,
  initialCwd = "",
  onClose,
  onManualInput,
  onSelect,
}: {
  visible: boolean;
  conn: HostConnection;
  initialPath: string;
  initialCwd?: string;
  onClose: () => void;
  onManualInput?: () => void;
  onSelect: (selection: Selection) => void;
}) {
  const insets = useSafeAreaInsets();
  const requestId = useRef(0);
  const [path, setPath] = useState("");
  const [root, setRoot] = useState("home");
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");

  const load = useCallback(
    async (nextPath: string, nextRoot: string) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const listing = await conn.workspaceList(nextPath, nextRoot);
        if (requestId.current !== id) return;
        setPath(listing.path);
        setRoot(listing.root ?? nextRoot);
        setCwd(listing.cwd);
        setEntries(listing.entries);
      } catch (e) {
        if (requestId.current !== id) return;
        setError(errorText(e));
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    },
    [conn],
  );

  // Modal.onShow 在部分原生呈现/快速重开路径上不会再次触发。可见性才是数据
  // 生命周期的真实来源：先发请求再做入场动画，目录行不会永远卡在 disabled。
  useEffect(() => {
    if (!visible) {
      requestId.current += 1;
      return;
    }
    const initial = conn.supportsWorkspaceRoots
      ? initialWindowsLocation(initialCwd) ?? { root: "computer", path: "" }
      : { root: "home", path: initialPath };
    const timer = setTimeout(() => void load(initial.path, initial.root), 0);
    return () => {
      clearTimeout(timer);
      requestId.current += 1;
    };
  }, [visible, initialPath, initialCwd, conn.supportsWorkspaceRoots, load]);

  const close = (): void => {
    requestId.current += 1;
    onClose();
  };

  const goUp = (): void => {
    if (path !== "") {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      void load(parent, root);
      return;
    }
    if (root !== "home" && root !== "computer") void load("", "computer");
  };

  const openFolder = (entry: FsEntry): void => {
    if (entry.kind !== "dir") return;
    if (root === "computer") {
      void load("", entry.name);
      return;
    }
    void load(path === "" ? entry.name : `${path}/${entry.name}`, root);
  };

  const createFolder = async (name: string): Promise<void> => {
    if (root === "computer" || cwd === "") return;
    setCreateOpen(false);
    setCreateName("");
    setLoading(true);
    setError(null);
    try {
      await conn.workspaceMkdir(path, root, name.trim());
      await load(path === "" ? name.trim() : `${path}/${name.trim()}`, root);
    } catch (failure) {
      setLoading(false);
      setError(errorText(failure));
    }
  };

  const choose = (): void => {
    if (loading || error !== null || cwd === "") return;
    requestId.current += 1;
    onSelect({ path, cwd });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      onRequestClose={close}
    >
      <View style={styles.screen}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top, space.md) }]}>
          <Pressable onPress={close} hitSlop={10} style={styles.headerSide}>
            <Text style={styles.headerAction}>取消</Text>
          </Pressable>
          <Text style={styles.title}>选择工作目录</Text>
          <View style={[styles.headerSide, styles.headerRight]}>
            {conn.supportsWorkspaceRoots && root !== "computer" && cwd !== "" && (
              <Pressable
                onPress={() => setCreateOpen(true)}
                hitSlop={10}
                accessibilityLabel="新建文件夹"
                style={styles.headerIcon}
              >
                <Icon name="plus" size={18} color={color.accent} />
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.locationCard}>
          <View style={styles.locationIcon}>
            <Icon name="folder.fill" size={18} color={color.accent} weight="semibold" />
          </View>
          <View style={styles.locationCopy}>
            <Text style={styles.locationLabel}>当前位置</Text>
            <Text style={styles.locationPath} numberOfLines={2}>
              {root === "computer"
                ? "此电脑"
                : root === "home"
                  ? (path === "" ? "~" : `~/${path}`)
                  : `${root}\\${path.replace(/\//g, "\\")}`}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}
            onPress={() => void load("", conn.supportsWorkspaceRoots ? "computer" : "home")}
            disabled={loading || (conn.supportsWorkspaceRoots ? root === "computer" : path === "")}
            accessibilityLabel={conn.supportsWorkspaceRoots ? "返回此电脑" : "返回主目录"}
          >
            <Icon
              name="house.fill"
              size={17}
              color={(conn.supportsWorkspaceRoots ? root === "computer" : path === "") ? color.textFaint : color.textDim}
            />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}
            onPress={goUp}
            disabled={loading || (path === "" && (root === "home" || root === "computer"))}
            accessibilityLabel="上一级目录"
          >
            <Icon
              name="arrow.up"
              size={17}
              color={path === "" && (root === "home" || root === "computer") ? color.textFaint : color.textDim}
            />
          </Pressable>
        </View>

        <View style={styles.listCard}>
          <FlatList
            data={entries}
            keyExtractor={(item) => item.name}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={entries.length === 0 ? styles.emptyList : undefined}
            refreshControl={
              <RefreshControl
                refreshing={loading}
                onRefresh={() => void load(path, root)}
                tintColor={color.accent}
              />
            }
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              loading ? (
                <View style={styles.emptyState}>
                  <ActivityIndicator color={color.accent} />
                  <Text style={styles.emptyDetail}>正在读取电脑上的目录…</Text>
                </View>
              ) : error !== null ? (
                <View style={styles.emptyState}>
                  <Icon name="exclamationmark.triangle.fill" size={26} color={color.warn} />
                  <Text style={styles.errorText}>{error}</Text>
                  <Pressable style={styles.retryButton} onPress={() => void load(path, root)}>
                    <Text style={styles.retryText}>重新加载</Text>
                  </Pressable>
                  {onManualInput && (
                    <Pressable style={styles.manualButton} onPress={onManualInput}>
                      <Text style={styles.manualText}>手动输入完整路径</Text>
                    </Pressable>
                  )}
                </View>
              ) : (
                <View style={styles.emptyState}>
                  <Icon name="folder.fill" size={26} color={color.textFaint} />
                  <Text style={styles.emptyDetail}>这个目录是空的</Text>
                </View>
              )
            }
            renderItem={({ item }) => {
              const isFolder = item.kind === "dir";
              return (
                <Pressable
                  disabled={!isFolder || loading}
                  onPress={() => openFolder(item)}
                  accessibilityRole={isFolder ? "button" : undefined}
                  accessibilityHint={isFolder ? "打开这个文件夹" : "文件仅供预览"}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <View style={[styles.itemIcon, !isFolder && styles.fileIcon]}>
                    <Icon
                      name={isFolder ? "folder.fill" : "doc.fill"}
                      size={19}
                      color={isFolder ? color.accent : color.textDim}
                    />
                  </View>
                  <View style={styles.itemCopy}>
                    <Text style={[styles.itemName, !isFolder && styles.fileName]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.itemDetail}>{detailFor(item)}</Text>
                  </View>
                  {isFolder && (
                    <Icon name="chevron.right" size={13} color={color.textFaint} weight="semibold" />
                  )}
                </Pressable>
              );
            }}
          />
        </View>

        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
          <Text style={styles.footerHint} numberOfLines={1}>
            {cwd || "文件仅作预览，只有文件夹可选择"}
          </Text>
          <Pressable
            onPress={choose}
            disabled={loading || error !== null || cwd === "" || root === "computer"}
            style={({ pressed }) => [
              styles.chooseButton,
              (loading || error !== null || cwd === "" || root === "computer") && styles.chooseDisabled,
              pressed && styles.choosePressed,
            ]}
          >
            <Text style={styles.chooseText}>选择当前文件夹</Text>
          </Pressable>
        </View>
        <PromptDialog
          visible={createOpen}
          title="新建文件夹"
          message={cwd}
          value={createName}
          confirmLabel="创建并进入"
          onChangeText={setCreateName}
          onCancel={() => { setCreateOpen(false); setCreateName(""); }}
          onSubmit={createFolder}
          validate={(value) => {
            const trimmed = value.trim();
            if (!trimmed) return "请输入文件夹名称";
            if (trimmed === "." || trimmed === ".." || /[<>:"/\\|?*\0]/.test(trimmed)) {
              return "文件夹名称包含 Windows 不允许的字符";
            }
            if (trimmed.length > 255) return "文件夹名称过长";
            return null;
          }}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  header: {
    minHeight: 58,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  headerSide: { width: 64 },
  headerRight: { alignItems: "flex-end" },
  headerIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerAction: { color: color.accent, fontSize: 15 },
  title: { ...font.body, flex: 1, textAlign: "center", fontWeight: "700" },
  locationCard: {
    marginHorizontal: space.lg,
    marginTop: space.lg,
    marginBottom: space.md,
    padding: space.md,
    minHeight: 68,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  locationIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: color.accentBg,
  },
  locationCopy: { flex: 1, gap: 2 },
  locationLabel: { ...font.meta, color: color.textDim },
  locationPath: { ...font.body, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  navButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
    backgroundColor: color.surfaceRaised,
  },
  pressed: { backgroundColor: color.pressed },
  listCard: {
    flex: 1,
    marginHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    overflow: "hidden",
  },
  emptyList: { flexGrow: 1 },
  emptyState: {
    flex: 1,
    minHeight: 220,
    padding: space.xl,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
  },
  emptyDetail: { ...font.sub, textAlign: "center" },
  errorText: { ...font.sub, color: color.warn, textAlign: "center", lineHeight: 19 },
  retryButton: {
    paddingHorizontal: space.lg,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: color.surfaceRaised,
  },
  retryText: { color: color.accent, fontSize: 13, fontWeight: "600" },
  manualButton: { minHeight: 42, paddingHorizontal: space.lg, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: color.surfaceRaised },
  manualText: { color: color.text, fontSize: 13, fontWeight: "600" },
  row: {
    minHeight: 62,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  rowPressed: { backgroundColor: color.pressed },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: color.border, marginLeft: 62 },
  itemIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: color.accentBg,
  },
  fileIcon: { backgroundColor: color.surfaceRaised },
  itemCopy: { flex: 1, gap: 2 },
  itemName: { ...font.body },
  fileName: { color: color.textDim },
  itemDetail: font.meta,
  footer: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm },
  footerHint: { ...font.meta, textAlign: "center" },
  chooseButton: {
    minHeight: 50,
    borderRadius: radius.md,
    backgroundColor: color.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  chooseDisabled: { opacity: 0.4 },
  choosePressed: { opacity: 0.82 },
  chooseText: { color: "#0A0A0C", fontSize: 15, fontWeight: "700" },
});
