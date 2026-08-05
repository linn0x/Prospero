import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, font, radius, space } from "@/lib/theme";

/**
 * 底部弹层。
 *
 * 用来取代那些"把几行文本塞进 Alert"的地方 —— Alert 是给需要决策的问题用的,
 * 拿它展示信息既没有排版能力,又强迫用户点一下"好"才能继续。
 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* 点背景关闭 —— 比只给一个按钮更符合手势直觉 */}
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.grabber} />
        <View style={styles.head}>
          <Text style={font.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.close}>关闭</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** 进度条。百分比用长度表达,比一串数字快得多 */
export function Meter({ value, tint }: { value: number; tint: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View style={styles.meterTrack}>
      <View
        style={[styles.meterFill, { width: `${pct}%` as const, backgroundColor: tint }]}
      />
    </View>
  );
}

/** 键值行 */
export function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={font.sub}>{label}</Text>
      <Text style={[font.body, styles.rowValue]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.lg,
    maxHeight: "78%",
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.border,
    alignSelf: "center",
    marginTop: space.sm,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.lg,
  },
  close: { color: color.accent, fontSize: 15 },
  body: { marginBottom: space.sm },
  meterTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: color.surfaceRaised,
    overflow: "hidden",
  },
  meterFill: { height: "100%", borderRadius: 3 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowValue: { fontVariant: ["tabular-nums"] },
});
