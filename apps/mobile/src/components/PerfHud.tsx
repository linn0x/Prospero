/**
 * 终端性能读数浮层。默认关闭,从会话菜单打开。
 *
 * 只在终端有输出的秒窗里更新,静止时保留最后一次读数。
 */
import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { fpsTone, rendererTone, type TerminalPerf } from "@/lib/perf-hud";
import { MONOSPACE_FONT, color, radius } from "@/lib/theme";

const TONE: Record<"good" | "warn" | "bad", string> = {
  good: color.success,
  warn: color.warn,
  bad: color.danger,
};

export const PerfHud = memo(function PerfHud({ perf }: { perf: TerminalPerf | null }) {
  return (
    <View style={styles.root} pointerEvents="none" accessibilityLabel="终端性能读数">
      {perf === null ? (
        <Text style={styles.waiting}>等待终端输出…</Text>
      ) : (
        <>
          <Text style={[styles.value, { color: TONE[fpsTone(perf.fps)] }]}>
            {perf.fps} fps
          </Text>
          <Text style={styles.value}>{perf.kb} KB/s</Text>
          <Text style={[styles.value, { color: TONE[rendererTone(perf.renderer)] }]}>
            {perf.renderer}
          </Text>
        </>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 8,
    right: 8,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: "#000000B3",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  value: {
    fontFamily: MONOSPACE_FONT,
    fontSize: 11,
    color: color.text,
  },
  waiting: {
    fontFamily: MONOSPACE_FONT,
    fontSize: 11,
    color: color.textDim,
  },
});
