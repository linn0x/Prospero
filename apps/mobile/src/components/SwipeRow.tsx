import { useRef } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import * as Haptics from "expo-haptics";
import { Icon, type IconName } from "@/components/Icon";

export interface SwipeAction {
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

  const run = (action: SwipeAction): void => {
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
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={() => (
        <View style={styles.actions}>
          {actions.map((action) => (
            <Pressable
              key={action.label}
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
  );
}

const styles = StyleSheet.create({
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
});
