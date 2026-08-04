import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

const KEYS: { label: string; seq: string }[] = [
  { label: "esc", seq: "\x1b" },
  { label: "tab", seq: "\t" },
  { label: "^C", seq: "\x03" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "⏎", seq: "\r" },
  { label: "/", seq: "/" },
  { label: "^D", seq: "\x04" },
  { label: "^Z", seq: "\x1a" },
  { label: "^L", seq: "\x0c" },
];

export function KeyBar({ onKey }: { onKey: (seq: string) => void }) {
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
      contentContainerStyle={styles.content}
    >
      {KEYS.map((k) => (
        <Pressable
          key={k.label}
          onPress={() => onKey(k.seq)}
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
        >
          <Text style={styles.keyText}>{k.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { flexGrow: 0, backgroundColor: "#141419" },
  content: { paddingHorizontal: 8, paddingVertical: 6, gap: 6 },
  key: {
    backgroundColor: "#26262e",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 40,
    alignItems: "center",
  },
  keyPressed: { backgroundColor: "#3a3a46" },
  keyText: { color: "#e8e8ee", fontSize: 14, fontVariant: ["tabular-nums"] },
});
