import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Icon } from "@/components/Icon";
import { radius, space, useMobileTheme, type ThemePalette } from "@/lib/theme";

export function AddDeviceCard({
  width,
  height,
  active,
  onPairDevice,
}: {
  width: number;
  height: number;
  active: boolean;
  onPairDevice: (mode: "scan" | "manual") => void;
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const compact = height < 360;
  return (
    <View
      style={[styles.card, { width, height }, active && styles.active]}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      testID="add-device-detail-card"
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        testID="add-device-detail-scroll"
      >
      <View style={[styles.introduction, compact && styles.introductionCompact]}>
        <View style={[styles.symbol, compact && styles.symbolCompact]}>
          <Icon name="plus" size={compact ? 26 : 34} color={palette.accent} />
        </View>
        <Text style={styles.title}>新增设备</Text>
        <Text style={styles.description}>把另一台电脑加入 Prospero</Text>
      </View>
      <View style={styles.methods}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="扫码配对新设备"
          onPress={() => onPairDevice("scan")}
          style={({ pressed }) => [styles.method, styles.scanMethod, pressed && styles.pressed]}
        >
          <Icon name="qrcode.viewfinder" size={25} color={palette.accent} />
          <View style={styles.methodCopy}>
            <Text style={[styles.methodTitle, styles.scanTitle]}>扫码配对</Text>
            <Text style={styles.methodHint}>扫描电脑上显示的二维码</Text>
          </View>
          <Icon name="chevron.right" size={16} color={palette.accent} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="使用 IP 和配对码添加新设备"
          onPress={() => onPairDevice("manual")}
          style={({ pressed }) => [styles.method, pressed && styles.pressed]}
        >
          <Icon name="network" size={25} color={palette.textDim} />
          <View style={styles.methodCopy}>
            <Text style={styles.methodTitle}>IP + 配对码</Text>
            <Text style={styles.methodHint}>手动输入设备地址和配对码</Text>
          </View>
          <Icon name="chevron.right" size={16} color={palette.textFaint} />
        </Pressable>
      </View>
      <Text style={styles.footer}>配对后，设备会出现在切换列表中</Text>
      </ScrollView>
    </View>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    card: {
      flexShrink: 0,
      padding: space.lg,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.28,
      shadowRadius: 26,
      elevation: 22,
    },
    scroll: { flex: 1 },
    content: { flexGrow: 1, justifyContent: "center", paddingVertical: 6 },
    active: { borderColor: palette.accent },
    introduction: { alignItems: "center", marginBottom: 26 },
    introductionCompact: { marginBottom: 14 },
    symbol: {
      width: 68,
      height: 68,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 22,
      backgroundColor: palette.accentBg,
      marginBottom: 16,
    },
    symbolCompact: { width: 48, height: 48, borderRadius: 16, marginBottom: 10 },
    title: { color: palette.text, fontSize: 22, fontWeight: "700" },
    description: { color: palette.textDim, fontSize: 12, marginTop: 7 },
    methods: { gap: 10 },
    method: {
      minHeight: 70,
      paddingHorizontal: 14,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: radius.md,
      backgroundColor: palette.surfaceRaised,
    },
    scanMethod: { backgroundColor: palette.accentBg },
    methodCopy: { flex: 1, minWidth: 0, gap: 4 },
    methodTitle: { color: palette.text, fontSize: 14, fontWeight: "600" },
    scanTitle: { color: palette.accent },
    methodHint: { color: palette.textDim, fontSize: 10.5 },
    footer: { color: palette.textFaint, fontSize: 10, textAlign: "center", marginTop: 22 },
    pressed: { opacity: 0.65 },
  });
}
