import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, PanResponder, ScrollView, StyleSheet, Text, useAnimatedValue, useWindowDimensions, View } from "react-native";
import { useFocusEffect } from "expo-router";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { Icon } from "./Icon";
import type { StoredHost } from "@/lib/hosts";
import type { HostRuntime } from "@/lib/store";
import { deviceDragIndex, deviceDragScrollSpeed, moveDevice } from "@/lib/device-order";
import { radius, useMobileTheme, type ThemePalette } from "@/lib/theme";

type Drag = { id: string; baseTop: number; pointerStart: number; pointerY: number; scrollStart: number; order: string[] };
type OrderStyles = ReturnType<typeof createStyles>;

function OrderRow({ host, runtime, index, count, stride, dragging, dragPosition, enabled, styles, palette, onBegin, onMove, onFinish, onAccessibleMove }: {
  host: StoredHost; runtime?: HostRuntime; index: number; count: number; stride: number; dragging: boolean;
  dragPosition: Animated.Value; enabled: boolean; styles: OrderStyles; palette: ThemePalette;
  onBegin: (id: string, pageY: number) => void; onMove: (pageY: number) => void;
  onFinish: (commit: boolean) => void; onAccessibleMove: (id: string, direction: number) => void;
}) {
  const position = useAnimatedValue(index * stride);
  const callbacks = useRef({ enabled, onBegin, onMove, onFinish, hostId: host.id });
  useLayoutEffect(() => { callbacks.current = { enabled, onBegin, onMove, onFinish, hostId: host.id }; }, [enabled, onBegin, onMove, onFinish, host.id]);
  // PanResponder registers these callbacks; it does not execute them during render.
  /* eslint-disable react-hooks/refs */
  const [responder] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => callbacks.current.enabled,
    onPanResponderGrant: (event) => callbacks.current.onBegin(callbacks.current.hostId, event.nativeEvent.pageY),
    onPanResponderMove: (event) => callbacks.current.onMove(event.nativeEvent.pageY),
    onPanResponderRelease: () => callbacks.current.onFinish(true),
    onPanResponderTerminate: () => callbacks.current.onFinish(false),
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }));
  /* eslint-enable react-hooks/refs */
  useEffect(() => {
    const animation = Animated.timing(position, { toValue: index * stride, duration: 130, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [index, position, stride]);
  const platform = runtime?.hostInfo?.platform?.toLowerCase() ?? "";
  const brand = platform === "win32" || platform.includes("windows") ? "windows"
    : platform === "darwin" || platform.includes("mac") ? "apple" : platform.includes("linux") ? "linux" : null;
  const os = brand === "windows" ? "Windows" : brand === "apple" ? "macOS" : brand === "linux" ? "Linux" : "系统信息未读取";
  return <Animated.View testID={`device-order-row-${host.id}`} style={[styles.row, { height: stride - 8,
    transform: [{ translateY: dragging ? dragPosition : position }], zIndex: dragging ? 2 : 0 }, dragging && styles.rowDragging]}>
    <View style={styles.osIcon} accessible accessibilityLabel={os}>
      {brand ? <FontAwesome6 name={brand} size={20} color={palette.accent} /> : <Icon name="desktopcomputer" size={20} color={palette.textDim} />}
    </View>
    <Text style={styles.name} numberOfLines={1}>{host.name}</Text>
    <View {...responder.panHandlers} testID={`device-order-handle-${host.id}`} collapsable={false}
      accessible accessibilityRole="adjustable" accessibilityLabel={`调整 ${host.name} 的顺序`}
      accessibilityHint={enabled ? "上下拖动调整顺序；也可使用辅助功能上移或下移" : "至少需要两台设备才能排序"}
      accessibilityState={{ disabled: !enabled }} accessibilityValue={{ min: 1, max: count, now: index + 1, text: `第 ${index + 1} 台，共 ${count} 台` }}
      accessibilityActions={enabled ? [{ name: "decrement", label: "上移" }, { name: "increment", label: "下移" }] : []}
      onAccessibilityAction={({ nativeEvent }) => {
        if (enabled && (nativeEvent.actionName === "increment" || nativeEvent.actionName === "decrement")) {
          onAccessibleMove(host.id, nativeEvent.actionName === "increment" ? 1 : -1);
        }
      }} style={[styles.handle, !enabled && styles.disabled]}>
      <FontAwesome6 name="grip-lines" size={18} color={dragging ? palette.accent : palette.textFaint} />
    </View>
  </Animated.View>;
}

export function DeviceOrderList({ hosts, runtimes, enabled = true, onReorder }: {
  hosts: StoredHost[]; runtimes: Record<string, HostRuntime>; enabled?: boolean; onReorder: (ids: string[]) => void;
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const { fontScale } = useWindowDimensions();
  const stride = Math.max(72, Math.ceil(36 * fontScale) + 36);
  const ids = useMemo(() => hosts.map((host) => host.id), [hosts]);
  const membership = JSON.stringify(ids);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const dragPosition = useAnimatedValue(0);
  const scroll = useRef<ScrollView>(null);
  const viewportView = useRef<View>(null);
  const drag = useRef<Drag | null>(null);
  const offset = useRef(0);
  const viewport = useRef({ top: 0, height: 0 });
  const frame = useRef<number | null>(null);
  const focused = useRef(false);
  const foreground = useRef(!AppState.currentState || AppState.currentState === "active");
  const latest = useRef({ ids, stride, onReorder, enabled });
  useLayoutEffect(() => { latest.current = { ids, stride, onReorder, enabled }; }, [ids, stride, onReorder, enabled]);

  const finish = useCallback((commit: boolean) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const session = drag.current;
    drag.current = null;
    setDraggedId(null);
    setPreview(null);
    dragPosition.stopAnimation();
    if (session && commit && session.order.join("\u0000") !== latest.current.ids.join("\u0000")) latest.current.onReorder(session.order);
  }, [dragPosition]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => { focused.current = false; finish(false); };
  }, [finish]));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      foreground.current = state === "active";
      if (!foreground.current) finish(false);
    });
    return () => subscription.remove();
  }, [finish]);
  useEffect(() => () => finish(false), [membership, stride, enabled, finish]);

  const update = useCallback(() => {
    const session = drag.current;
    if (!session) return;
    const { stride: rowStride, ids: currentIds } = latest.current;
    const top = Math.max(0, Math.min((currentIds.length - 1) * rowStride,
      session.baseTop + session.pointerY - session.pointerStart + offset.current - session.scrollStart));
    dragPosition.setValue(top);
    const target = deviceDragIndex(top, rowStride, currentIds.length);
    if (session.order.indexOf(session.id) !== target) {
      session.order = moveDevice(session.order, session.id, target);
      setPreview(session.order);
    }
  }, [dragPosition]);
  const begin = useCallback((id: string, pageY: number) => {
    if (!focused.current || !foreground.current || !latest.current.enabled || latest.current.ids.length < 2) return;
    finish(false);
    const index = latest.current.ids.indexOf(id);
    if (index < 0) return;
    const baseTop = index * latest.current.stride;
    drag.current = { id, baseTop, pointerStart: pageY, pointerY: pageY, scrollStart: offset.current, order: [...latest.current.ids] };
    dragPosition.setValue(baseTop);
    setDraggedId(id);
    setPreview(latest.current.ids);
    let previousTime: number | undefined;
    const tick = (time: number) => {
      const session = drag.current;
      if (!session) return;
      const seconds = previousTime === undefined ? 0 : Math.min(32, time - previousTime) / 1000;
      previousTime = time;
      const speed = deviceDragScrollSpeed(session.pointerY, viewport.current.top, viewport.current.height);
      const maximum = Math.max(0, latest.current.ids.length * latest.current.stride - viewport.current.height);
      const nextOffset = Math.max(0, Math.min(maximum, offset.current + speed * seconds));
      if (nextOffset !== offset.current) {
        offset.current = nextOffset;
        scroll.current?.scrollTo({ y: nextOffset, animated: false });
        update();
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [dragPosition, finish, update]);
  const move = useCallback((pageY: number) => {
    if (drag.current) { drag.current.pointerY = pageY; update(); }
  }, [update]);
  const accessibleMove = useCallback((id: string, direction: number) => {
    const current = latest.current;
    if (!focused.current || !foreground.current || !current.enabled) return;
    const next = moveDevice(current.ids, id, current.ids.indexOf(id) + direction);
    if (next.join("\u0000") !== current.ids.join("\u0000")) current.onReorder(next);
  }, []);
  const order = preview ?? ids;
  return <View ref={viewportView} style={styles.list} onLayout={() => {
    viewportView.current?.measureInWindow((_x, y, _width, height) => { viewport.current = { top: y, height }; });
  }}><ScrollView ref={scroll} style={styles.list} contentContainerStyle={styles.content}
    testID="device-order-list" scrollEnabled={draggedId === null} scrollEventThrottle={16}
    onScroll={({ nativeEvent }) => { if (!drag.current) offset.current = nativeEvent.contentOffset.y; }}>
    <View style={{ height: hosts.length * stride }}>
      {hosts.map((host) => <OrderRow key={host.id} host={host} runtime={runtimes[host.id]}
        index={order.indexOf(host.id)} count={hosts.length} stride={stride} dragging={host.id === draggedId}
        dragPosition={dragPosition} enabled={enabled && hosts.length > 1} styles={styles} palette={palette}
        onBegin={begin} onMove={move} onFinish={finish} onAccessibleMove={accessibleMove} />)}
    </View>
  </ScrollView></View>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    list: { flex: 1 }, content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
    row: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", gap: 12,
      paddingLeft: 14, paddingRight: 6, borderRadius: radius.md, backgroundColor: palette.surface,
      borderWidth: 1, borderColor: "transparent" },
    rowDragging: { backgroundColor: palette.surfaceRaised, borderColor: palette.accent,
      shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
    osIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", backgroundColor: palette.accentBg, borderRadius: 10 },
    name: { flex: 1, minWidth: 0, color: palette.text, fontSize: 15, fontWeight: "600" },
    handle: { width: 48, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
    disabled: { opacity: 0.3 },
  });
}
