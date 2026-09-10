import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { SettingsGroup, SettingsPage, useSettingsStyle } from "@/components/settings/SettingsLayout";
import { toast } from "@/components/Toast";
import { useSettingsPreferences } from "@/lib/use-settings-preferences";
import { DEFAULT_QUICK_REPLIES, parseQuickReplyLines, quickReplyValidationError } from "@/lib/quick-replies";

export default function QuickReplySettingsScreen() {
  const { settings, updateSettings } = useSettingsPreferences();
  const { palette, styles } = useSettingsStyle();
  const savedIdle = settings.quickReplies.idle.join("\n");
  const savedBusy = settings.quickReplies.busy.join("\n");
  const [idle, setIdle] = useState(savedIdle);
  const [busy, setBusy] = useState(savedBusy);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) { setIdle(savedIdle); setBusy(savedBusy); }
  }, [savedBusy, savedIdle]);
  const changed = (): void => { edited.current = true; setDirty(true); };
  const save = async (): Promise<void> => {
    if (saving) return;
    const quickReplies = { idle: parseQuickReplyLines(idle), busy: parseQuickReplyLines(busy) };
    const error = quickReplyValidationError(quickReplies.idle) ?? quickReplyValidationError(quickReplies.busy);
    if (error) { toast(error); return; }
    setSaving(true);
    try {
      await updateSettings({ quickReplies }, true);
      setIdle(quickReplies.idle.join("\n")); setBusy(quickReplies.busy.join("\n"));
      edited.current = false; setDirty(false);
      toast("快捷指令已保存");
    } catch { toast("保存失败，请重试；编辑内容已保留。"); }
    finally { setSaving(false); }
  };
  return <SettingsPage title="快捷指令" detail="每行一条，按填写顺序显示。每组最多 24 条，每条最多 500 个字符；留空可隐藏该组。点击快捷指令会直接发送。">
    {([{ key: "idle", title: "空闲时", value: idle, set: setIdle }, { key: "busy", title: "运行中", value: busy, set: setBusy }] as const).map((group) =>
      <SettingsGroup key={group.key} title={group.title}>
        <TextInput multiline editable={!saving} value={group.value} onChangeText={(value) => { changed(); group.set(value); }}
          accessibilityLabel={`${group.title}的快捷指令，每行一条`} placeholder="每行填写一条快捷指令"
          placeholderTextColor={palette.textFaint} textAlignVertical="top" autoCorrect={false}
          style={{ color: palette.text, padding: 16, minHeight: group.key === "idle" ? 220 : 140, fontSize: 15, lineHeight: 25 }} />
      </SettingsGroup>)}
    <View style={{ gap: 10 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="保存快捷指令" disabled={saving || !dirty}
        onPress={() => void save()} style={[styles.row, { minHeight: 48, justifyContent: "center", borderRadius: 10,
          backgroundColor: palette.accentBg, opacity: saving || !dirty ? 0.5 : 1 }]}>
        <Text style={[styles.title, { color: palette.accent }]}>{saving ? "正在保存…" : "保存"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="恢复默认快捷指令" disabled={saving}
        onPress={() => { changed(); setIdle(DEFAULT_QUICK_REPLIES.idle.join("\n")); setBusy(DEFAULT_QUICK_REPLIES.busy.join("\n")); }}
        style={[styles.row, styles.last, { minHeight: 48, justifyContent: "center" }]}>
        <Text style={styles.detail}>恢复默认（保存后生效）</Text>
      </Pressable>
    </View>
  </SettingsPage>;
}
