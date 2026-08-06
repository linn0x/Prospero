import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";

/**
 * 一句话的短提示。
 *
 * 用于"做成了但屏幕上看不出来"的动作 —— 复制就是典型:触感反馈在静音或
 * 关掉触感的手机上等于没有,用户无从判断到底复制上没有。
 * Alert 太重(要点确认),所以自己做一个会自动消失的。
 */
let emit: ((message: string) => void) | null = null;

/** 任何地方都能调,不需要 context;同一时刻只显示最后一条 */
export function toast(message: string): void {
  emit?.(message);
}

export function ToastHost(): React.ReactElement | null {
  const [message, setMessage] = useState<string | null>(null);
  const [opacity] = useState(() => new Animated.Value(0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    emit = (next) => {
      setMessage(next);
      if (timer.current) clearTimeout(timer.current);
      opacity.setValue(0);
      Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(
          () => setMessage(null),
        );
      }, 1400);
    };
    return () => {
      emit = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [opacity]);

  if (message === null) return null;
  return (
    // pointerEvents none:提示不该挡住下面的操作
    <Animated.View style={[styles.wrap, { opacity }]} pointerEvents="none">
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    bottom: 90,
    alignSelf: "center",
    backgroundColor: "#2a2a33",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 18,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  text: { color: "#e8e8ee", fontSize: 13 },
});
