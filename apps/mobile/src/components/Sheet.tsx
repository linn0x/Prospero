import { useEffect, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "@/components/Icon";
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
  const [mounted, setMounted] = useState(visible);
  const [backdropOpacity] = useState(() => new Animated.Value(visible ? 1 : 0));
  const [sheetProgress] = useState(() => new Animated.Value(visible ? 1 : 0));

  useEffect(() => {
    if (!visible || mounted) return;
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, [mounted, visible]);

  useEffect(() => {
    if (!mounted) return;
    const animation = Animated.parallel([
      Animated.timing(backdropOpacity, {
        toValue: visible ? 1 : 0,
        duration: visible ? 160 : 130,
        easing: visible ? Easing.out(Easing.quad) : Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(sheetProgress, {
        toValue: visible ? 1 : 0,
        duration: visible ? 230 : 180,
        easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [backdropOpacity, mounted, sheetProgress, visible]);

  if (!mounted) return null;

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      hardwareAccelerated
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        {/* 遮罩只原地淡入，不再和面板一起从屏幕底部滑上来。 */}
        <Animated.View style={[styles.backdropLayer, { opacity: backdropOpacity }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭弹层"
            style={styles.backdrop}
            onPress={onClose}
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + space.lg },
            {
              opacity: sheetProgress,
              transform: [{
                translateY: sheetProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [28, 0],
                }),
              }],
            },
          ]}
        >
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
        </Animated.View>
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

/** 底部面板里的明确动作；可带补充说明，避免只靠按钮名猜作用范围。 */
export function SheetAction({
  label,
  detail,
  symbol,
  destructive = false,
  onPress,
}: {
  label: string;
  detail?: string;
  symbol: IconName;
  destructive?: boolean;
  onPress: () => void;
}) {
  const tint = destructive ? color.danger : color.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      style={({ pressed }) => [styles.sheetAction, pressed && styles.sheetActionPressed]}
      onPress={onPress}
    >
      <View style={[styles.sheetActionIcon, { backgroundColor: destructive ? color.dangerBg : color.accentBg }]}>
        <Icon name={symbol} size={18} color={tint} />
      </View>
      <View style={styles.sheetActionCopy}>
        <Text style={[styles.sheetActionLabel, destructive && { color: tint }]}>{label}</Text>
        {detail ? <Text style={styles.sheetActionDetail}>{detail}</Text> : null}
      </View>
      <Icon name="chevron.right" size={14} color={color.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdropLayer: { position: "absolute", inset: 0 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
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
  sheetAction: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  sheetActionPressed: { backgroundColor: color.pressed },
  sheetActionIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetActionCopy: { flex: 1, gap: 3 },
  sheetActionLabel: { color: color.text, fontSize: 15, fontWeight: "600" },
  sheetActionDetail: { ...font.meta, color: color.textDim, lineHeight: 16 },
});
