import { useEffect, useRef, useState } from "react";
import * as RN from "react-native";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "@/components/Icon";
import { ResizeHandle } from "./ResizeHandle";
import { radius, space, createThemedStyles, useMobileTheme, fontForPalette } from "@/lib/theme";

/**
 * 底部弹层。
 *
 * 用来取代那些"把几行文本塞进 Alert"的地方 —— Alert 是给需要决策的问题用的,
 * 拿它展示信息既没有排版能力,又强迫用户点一下"好"才能继续。
 */
function getAnimated(): typeof RN.Animated | undefined {
  return "Animated" in RN ? RN.Animated : undefined;
}

export function Sheet({
  visible,
  title,
  onClose,
  onDismiss,
  presentation = "bottom",
  contentKey,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  /** Navigation must wait until the iOS presenter has released its native modal. */
  onDismiss?: () => void;
  /** Opt-in side panel for wide landscape workflows. */
  presentation?: "bottom" | "side";
  /** Reset scroll position when a sheet switches between nested lists. */
  contentKey?: string;
  children: React.ReactNode;
}) {
  const styles = useStyles();
  const { palette: color } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const floatingBottom = presentation !== "side" && width >= 600;
  const [sideFraction, setSideFraction] = useState<number | null>(null);
  const sideMin = Math.min(280, width / 2);
  const sideMax = Math.max(sideMin, width - 280);
  const sideWidth = Math.max(sideMin, Math.min(sideMax, sideFraction === null ? Math.min(480, Math.max(340, width * 0.48)) : width * sideFraction));
  const [entrance] = useState<RN.Animated.Value | null>(() => {
    const api = getAnimated();
    return typeof api?.Value === "function" ? new api.Value(0) : null;
  });
  const dragOrigin = useRef<{ y: number; lastY: number; lastTime: number } | null>(null);
  useEffect(() => {
    const api = getAnimated();
    if (!entrance || typeof api?.spring !== "function") return;
    entrance.stopAnimation();
    if (!visible) {
      entrance.setValue(0);
      return;
    }
    entrance.setValue(presentation === "side" ? -28 : 44);
    const anim = api.spring(entrance, {
      toValue: 0,
      damping: 28,
      stiffness: 380,
      mass: 0.72,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [entrance, presentation, visible]);
  const snapBack = (): void => {
    const api = getAnimated();
    if (!entrance || typeof api?.spring !== "function") return;
    api.spring(entrance, {
      toValue: 0,
      damping: 28,
      stiffness: 380,
      mass: 0.72,
      useNativeDriver: true,
    }).start();
  };
  const dragHandleProps = presentation === "side" ? undefined : {
    onMoveShouldSetResponder: (event: RN.GestureResponderEvent) => {
      const pageY = event.nativeEvent.pageY;
      if (dragOrigin.current === null) {
        dragOrigin.current = { y: pageY, lastY: pageY, lastTime: Date.now() };
        return false;
      }
      return Math.abs(pageY - dragOrigin.current.y) > 6;
    },
    onTouchStart: (event: RN.GestureResponderEvent) => {
      const pageY = event.nativeEvent.pageY;
      dragOrigin.current = { y: pageY, lastY: pageY, lastTime: Date.now() };
    },
    onResponderGrant: (event: RN.GestureResponderEvent) => {
      const pageY = event.nativeEvent.pageY;
      dragOrigin.current = { y: pageY, lastY: pageY, lastTime: Date.now() };
      entrance?.stopAnimation();
    },
    onResponderMove: (event: RN.GestureResponderEvent) => {
      const state = dragOrigin.current;
      if (!state || !entrance) return;
      const pageY = event.nativeEvent.pageY;
      state.lastY = pageY;
      state.lastTime = Date.now();
      const dy = pageY - state.y;
      entrance.setValue(dy >= 0 ? dy : dy * 0.18);
    },
    onResponderRelease: (event: RN.GestureResponderEvent) => {
      const state = dragOrigin.current;
      dragOrigin.current = null;
      if (!state) return;
      const pageY = event.nativeEvent.pageY;
      const dy = pageY - state.y;
      const dt = Math.max(1, Date.now() - state.lastTime);
      const velocity = (pageY - state.lastY) / dt;
      if (dy > 76 || (dy > 24 && velocity > 0.7)) {
        onClose();
        return;
      }
      snapBack();
    },
    onResponderTerminate: () => {
      dragOrigin.current = null;
      snapBack();
    },
  };
  const wasVisible = useRef(visible);
  const dismissCallback = useRef(onDismiss);
  useEffect(() => {
    dismissCallback.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const closed = wasVisible.current && !visible;
    wasVisible.current = visible;
    // RN exposes native onDismiss on iOS only. Elsewhere the invisible modal is
    // removed in this commit, so a later frame can safely perform the action.
    if (!closed || Platform.OS === "ios") return;
    const frame = requestAnimationFrame(() => dismissCallback.current?.());
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  const sheetCardStyle: RN.StyleProp<RN.ViewStyle> = [
    styles.sheet,
    floatingBottom && styles.floatingSheet,
    presentation === "side" && styles.sideSheet,
    presentation === "side" && { width: sideWidth },
    {
      paddingBottom: floatingBottom ? space.lg : insets.bottom + space.lg,
      ...(floatingBottom ? { marginBottom: Math.max(insets.bottom, space.md) } : {}),
      ...(presentation === "side" ? { paddingTop: insets.top } : {}),
    },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      hardwareAccelerated
      statusBarTranslucent
      onRequestClose={onClose}
      onDismiss={() => { if (!visible) onDismiss?.(); }}
    >
      <View style={[styles.modalRoot, presentation === "side" && styles.sideRoot]}>
        {/* Native visibility owns dismissal, including interrupted/background transitions. */}
        <View style={styles.backdropLayer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭弹层"
            style={styles.backdrop}
            onPress={onClose}
          />
        </View>
        <SheetMotion
          entrance={entrance}
          axis={presentation === "side" ? "x" : "y"}
          style={sheetCardStyle}
        >
          <View {...dragHandleProps}>
            {presentation !== "side" && <View style={styles.grabber} />}
            <View style={styles.head}>
              <Text style={styles.titleText} numberOfLines={1}>{title}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭"
                onPress={onClose}
                hitSlop={10}
                style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
              >
                <Icon name="xmark" size={14} color={color.textDim} weight="semibold" />
              </Pressable>
            </View>
          </View>
          <ScrollView key={contentKey} style={[styles.body, presentation === "side" && styles.sideBody]} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {presentation === "side" && <View style={styles.sideDivider}>
            <ResizeHandle label="调整模型选择面板宽度" value={sideWidth} min={sideMin} max={sideMax}
              onChange={(next) => setSideFraction(next / width)} />
          </View>}
        </SheetMotion>
      </View>
    </Modal>
  );
}

function SheetMotion({
  entrance,
  axis,
  style,
  children,
}: {
  entrance: RN.Animated.Value | null;
  axis: "x" | "y";
  style: RN.StyleProp<RN.ViewStyle>;
  children: React.ReactNode;
}) {
  const AnimatedView = getAnimated()?.View;
  if (!entrance || !AnimatedView) return <View style={style}>{children}</View>;
  return (
    <AnimatedView
      style={[
        style,
        {
          transform: [axis === "x" ? { translateX: entrance } : { translateY: entrance }],
        },
      ]}
    >
      {children}
    </AnimatedView>
  );
}

/** 进度条。百分比用长度表达,比一串数字快得多 */
export function Meter({ value, tint }: { value: number; tint: string }) {
  const styles = useStyles();
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
  const styles = useStyles();
  const { palette: color } = useMobileTheme();
  const font = fontForPalette(color);
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
  disabled = false,
  onPress,
}: {
  label: string;
  detail?: string;
  symbol: IconName;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const { palette: color } = useMobileTheme();
  const tint = destructive ? color.danger : color.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      disabled={disabled}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.sheetAction, disabled && { opacity: 0.45 }, pressed && styles.sheetActionPressed]}
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

const useStyles = createThemedStyles((color) => {
  const font = fontForPalette(color);
  return StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  sideRoot: { alignItems: "flex-start", justifyContent: "flex-start" },
  backdropLayer: { position: "absolute", inset: 0 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.44)" },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.lg,
    maxHeight: "82%",
  },
  floatingSheet: {
    width: "100%",
    maxWidth: 540,
    alignSelf: "center",
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  sideSheet: { height: "100%", maxHeight: "100%",
    borderTopLeftRadius: 0, borderBottomRightRadius: radius.lg },
  sideDivider: { position: "absolute", top: 0, bottom: 0, right: -12 },
  sideBody: { flex: 1 },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.border,
    alignSelf: "center",
    marginTop: 10,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  titleText: { ...font.title, fontSize: 17, flex: 1 },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surfaceRaised,
  },
  closeBtnPressed: { backgroundColor: color.pressed },
  body: { marginBottom: space.xs },
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
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: 10,
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  },
  sheetActionPressed: { backgroundColor: color.pressed },
  sheetActionIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetActionCopy: { flex: 1, gap: 2 },
  sheetActionLabel: { color: color.text, fontSize: 15, fontWeight: "600" },
  sheetActionDetail: { ...font.meta, color: color.textDim, lineHeight: 16 },
});
});
