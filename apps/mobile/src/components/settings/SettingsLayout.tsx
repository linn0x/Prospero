import { useMemo, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../Icon";
import { radius, useMobileTheme, type ThemePalette } from "@/lib/theme";

export function useSettingsStyle() {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  return { palette, styles };
}

export function SettingsPage({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  const { styles } = useSettingsStyle();
  const insets = useSafeAreaInsets();
  return <View style={styles.screen}>
    <Stack.Screen options={{ title, headerBackButtonDisplayMode: "minimal" }} />
    <ScrollView testID="settings-page" keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      {detail && <Text style={styles.intro}>{detail}</Text>}
      {children}
    </ScrollView>
  </View>;
}

export function SettingsGroup({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  const { styles } = useSettingsStyle();
  return <View style={styles.group}>
    {title && <Text style={styles.groupTitle}>{title}</Text>}
    <View style={styles.card}>{children}</View>
    {note && <Text style={styles.note}>{note}</Text>}
  </View>;
}

export function SettingsLink({ title, detail, icon, onPress, last = false }: {
  title: string; detail?: string; icon?: IconName; onPress: () => void; last?: boolean;
}) {
  const { palette, styles } = useSettingsStyle();
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={detail}
    onPress={onPress} style={({ pressed }) => [styles.row, last && styles.last, pressed && styles.pressed]}>
    {icon && <View style={styles.icon}><Icon name={icon} size={18} color={palette.accent} /></View>}
    <View style={styles.copy}>
      <Text style={styles.title}>{title}</Text>
      {detail && <Text style={styles.detail}>{detail}</Text>}
    </View>
    <Icon name="chevron.right" size={16} color={palette.textFaint} />
  </Pressable>;
}

export function SettingsRow({ title, detail, children, last = false }: {
  title: string; detail?: string; children: ReactNode; last?: boolean;
}) {
  const { styles } = useSettingsStyle();
  return <View style={[styles.row, last && styles.last]}>
    <View style={styles.copy}>
      <Text style={styles.title}>{title}</Text>
      {detail && <Text style={styles.detail}>{detail}</Text>}
    </View>
    {children}
  </View>;
}

export function SettingsOptions<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  const { styles } = useSettingsStyle();
  return <View style={styles.optionsBlock}>
    <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((option) => <Pressable key={String(option.value)} accessibilityRole="radio" accessibilityLabel={option.label}
        accessibilityState={{ selected: option.value === value }} onPress={() => onChange(option.value)}
        style={({ pressed }) => [styles.option, value === option.value && styles.optionSelected, pressed && styles.pressed]}>
        <Text style={[styles.optionText, value === option.value && styles.optionTextSelected]}>{option.label}</Text>
      </Pressable>)}
    </View>
  </View>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.bg },
    content: { width: "100%", maxWidth: 720, alignSelf: "center", paddingHorizontal: 16, paddingTop: 20, gap: 22 },
    intro: { color: palette.textDim, fontSize: 12, lineHeight: 19, paddingHorizontal: 2 },
    group: { gap: 9 }, groupTitle: { color: palette.textDim, fontSize: 12, fontWeight: "600", paddingHorizontal: 3 },
    card: { backgroundColor: palette.surface, borderRadius: radius.md, overflow: "hidden" },
    row: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
    last: { borderBottomWidth: 0 }, pressed: { backgroundColor: palette.pressed },
    icon: { width: 34, height: 34, borderRadius: 10, backgroundColor: palette.accentBg, alignItems: "center", justifyContent: "center" },
    copy: { flex: 1, minWidth: 0, gap: 4 }, title: { color: palette.text, fontSize: 14, fontWeight: "600" },
    detail: { color: palette.textFaint, fontSize: 11, lineHeight: 16 },
    note: { color: palette.textFaint, fontSize: 11, lineHeight: 17, paddingHorizontal: 3 },
    optionsBlock: { padding: 12 }, options: { flexDirection: "row", gap: 5, padding: 3, borderRadius: 10, backgroundColor: palette.bg },
    option: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", paddingVertical: 10, borderRadius: 8 },
    optionSelected: { backgroundColor: palette.accentDim }, optionText: { color: palette.textDim, fontSize: 13, fontWeight: "600" },
    optionTextSelected: { color: palette.text },
  });
}
