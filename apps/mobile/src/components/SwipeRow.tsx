import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import * as Haptics from "expo-haptics";
import { Icon, type IconName } from "@/components/Icon";
import { Sheet, SheetAction } from "@/components/Sheet";
import { color, font } from "@/lib/theme";

export interface SwipeAction {
  /** Stable custom accessibility-action name, unique within this row. */
  id: string;
  label: string;
  /** SF Symbol;Icon 组件自带非 iOS 回落 */
  symbol: IconName;
  color: string;
  /** Action foreground; use theme onAccent when the background is the accent token. */
  foregroundColor?: string;
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
  clipRadius,
}: {
  children: React.ReactNode;
  actions: SwipeAction[];
  /** 操作层与内容按同一圆角裁切，适用于独立卡片行。 */
  clipRadius?: number;
}): React.ReactElement {
  const ref = useRef<SwipeableMethods>(null);
  const [pending, setPending] = useState<SwipeAction | null>(null);

  const run = (action: SwipeAction): void => {
    ref.current?.close();
    if (!action.confirm) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      action.onPress();
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setPending(action);
  };

  const swipeable = (
    <ReanimatedSwipeable
        ref={ref}
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
                accessibilityHint={action.confirm ? "需要确认" : undefined}
                style={({ pressed }) => [
                  styles.action,
                  { backgroundColor: action.color },
                  pressed && styles.actionPressed,
                ]}
                onPress={() => run(action)}
              >
                <Icon name={action.symbol} size={18} color={action.foregroundColor ?? color.onAccent} />
                <Text style={[styles.actionLabel, { color: action.foregroundColor ?? color.onAccent }]}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      >
        {children}
      </ReanimatedSwipeable>
  );
  return (
    <>
      {clipRadius === undefined ? swipeable : (
        <View style={[styles.clipped, { borderRadius: clipRadius }]}>{swipeable}</View>
      )}
      <Sheet
        visible={pending !== null}
        title={pending?.confirm?.title ?? "确认操作"}
        onClose={() => setPending(null)}
      >
        <Text style={styles.confirmMessage}>{pending?.confirm?.message}</Text>
        <SheetAction
          label={pending?.confirm?.confirmLabel ?? "确认"}
          detail="此操作无法自动撤销"
          symbol={pending?.symbol ?? "trash"}
          destructive
          onPress={() => {
            const action = pending;
            setPending(null);
            action?.onPress();
          }}
        />
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  clipped: { overflow: "hidden" },
  actions: { flexDirection: "row", alignItems: "stretch" },
  action: {
    // 窄一点:一行三个操作时,行内容还得留得下标题
    width: 68,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  actionPressed: { opacity: 0.75 },
  actionLabel: { fontSize: 11, fontWeight: "600" },
  confirmMessage: { ...font.sub, color: color.textDim, lineHeight: 20 },
});
