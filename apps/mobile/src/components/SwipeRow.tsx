import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import * as Haptics from "expo-haptics";
import { Icon, type IconName } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import {
  findAccessibilityAction,
  toAccessibilityActions,
} from "@/lib/swipe-actions";

export interface SwipeAction {
  /** Stable custom accessibility-action name, unique within this row. */
  id: string;
  label: string;
  /** SF Symbol;Icon 组件自带非 iOS 回落 */
  symbol: IconName;
  color: string;
  onPress: () => void;
  /** 需要二次确认(不可逆动作) */
  confirm?: { title: string; message: string; confirmLabel: string };
}

/**
 * 左滑露出操作的列表行。
 *
 * iOS 用户对列表的第一直觉就是左滑,没有的话会以为不支持删除 ——
 * 长按菜单藏得太深。破坏性操作走 Alert 二次确认,因为误滑很常见。
 */
export function SwipeRow({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions: SwipeAction[];
}): React.ReactElement {
  const ref = useRef<SwipeableMethods>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const accessibilityActions = toAccessibilityActions(actions);

  const run = (action: SwipeAction): void => {
    setMoreOpen(false);
    ref.current?.close();
    if (!action.confirm) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      action.onPress();
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(action.confirm.title, action.confirm.message, [
      { text: "取消", style: "cancel" },
      {
        text: action.confirm.confirmLabel,
        style: "destructive",
        onPress: () => action.onPress(),
      },
    ]);
  };

  return (
    <>
      <View style={styles.row}>
        <ReanimatedSwipeable
          ref={ref}
          containerStyle={styles.swipeable}
          childrenContainerStyle={styles.swipeableChildren}
          friction={2}
          rightThreshold={40}
          overshootRight={false}
          renderRightActions={() => (
            <View style={styles.actions}>
              {actions.map((action) => (
                <Pressable
                  key={action.id}
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  style={({ pressed }) => [
                    styles.action,
                    { backgroundColor: action.color },
                    pressed && styles.actionPressed,
                  ]}
                  onPress={() => run(action)}
                >
                  <Icon name={action.symbol} size={18} color="#fff" />
                  <Text style={styles.actionLabel}>{action.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
        >
          {children}
        </ReanimatedSwipeable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="更多操作"
          accessibilityHint="双击查看操作，或从读屏操作中直接选择"
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={(event) => {
            const action = findAccessibilityAction(actions, event.nativeEvent.actionName);
            if (action) run(action);
          }}
          style={({ pressed }) => [styles.more, pressed && styles.morePressed]}
          onPress={() => setMoreOpen(true)}
        >
          <Icon name="ellipsis.circle" size={19} color="#7aa2f7" />
          <Text style={styles.moreLabel}>更多</Text>
        </Pressable>
      </View>
      <Sheet visible={moreOpen} title="更多操作" onClose={() => setMoreOpen(false)}>
        <View style={styles.menuActions}>
          {actions.map((action) => (
            <Pressable
              key={action.id}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              accessibilityHint={action.confirm ? "需要确认" : undefined}
              style={({ pressed }) => [styles.menuAction, pressed && styles.menuActionPressed]}
              onPress={() => run(action)}
            >
              <Icon name={action.symbol} size={20} color={action.color} />
              <Text style={[styles.menuActionLabel, action.confirm && styles.menuActionDanger]}>
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "stretch" },
  swipeable: { flex: 1, minWidth: 0 },
  swipeableChildren: { flex: 1 },
  actions: { flexDirection: "row", alignItems: "stretch" },
  action: {
    // 窄一点:一行三个操作时,行内容还得留得下标题
    width: 68,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  actionPressed: { opacity: 0.75 },
  actionLabel: { color: "#fff", fontSize: 11, fontWeight: "600" },
  more: {
    width: 56,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: "#26262e",
    backgroundColor: "#111118",
  },
  morePressed: { backgroundColor: "#1c1c26" },
  moreLabel: { color: "#7aa2f7", fontSize: 11, fontWeight: "600" },
  menuActions: { gap: 6, paddingBottom: 4 },
  menuAction: {
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 10,
    backgroundColor: "#24242d",
  },
  menuActionPressed: { opacity: 0.72 },
  menuActionLabel: { color: "#e8e8ee", fontSize: 16, fontWeight: "600" },
  menuActionDanger: { color: "#f08a84" },
});
