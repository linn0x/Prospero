import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { ConversationFontControl } from "@/components/ConversationFontControl";
import { DeviceConnectionRow } from "@/components/settings/DeviceConnectionRow";
import {
  SettingsGroup,
  SettingsLink,
  SettingsOptions,
  SettingsPage,
  SettingsRow,
  useSettingsStyle,
} from "@/components/settings/SettingsLayout";
import { toast } from "@/components/Toast";
import { HOME_RECENT_SESSION_LIMITS, type HomeThemeMode } from "@/lib/home-preferences";
import {
  DEFAULT_QUICK_REPLIES,
  parseQuickReplyLines,
  quickReplyValidationError,
} from "@/lib/quick-replies";
import { radius, type ThemePalette } from "@/lib/theme";
import { useSettingsDevices } from "@/lib/use-settings-devices";
import { useSettingsPreferences } from "@/lib/use-settings-preferences";

const THEME_OPTIONS: readonly { value: HomeThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export default function SettingsScreen() {
  const { settings, updateSettings } = useSettingsPreferences();
  const { hosts, runtimes } = useSettingsDevices();
  const { palette, styles } = useSettingsStyle();
  const localStyles = useMemo(() => createLocalStyles(palette), [palette]);

  const savedIdle = settings.quickReplies.idle.join("\n");
  const savedBusy = settings.quickReplies.busy.join("\n");
  const [idle, setIdle] = useState(savedIdle);
  const [busy, setBusy] = useState(savedBusy);
  const [savingReplies, setSavingReplies] = useState(false);
  const [dirtyReplies, setDirtyReplies] = useState(false);
  const editedReplies = useRef(false);

  useEffect(() => {
    if (!editedReplies.current) {
      setIdle(savedIdle);
      setBusy(savedBusy);
    }
  }, [savedBusy, savedIdle]);

  const markRepliesDirty = (): void => {
    editedReplies.current = true;
    setDirtyReplies(true);
  };

  const saveQuickReplies = async (): Promise<void> => {
    if (savingReplies) return;
    const quickReplies = {
      idle: parseQuickReplyLines(idle),
      busy: parseQuickReplyLines(busy),
    };
    const error =
      quickReplyValidationError(quickReplies.idle) ??
      quickReplyValidationError(quickReplies.busy);
    if (error) {
      toast(error);
      return;
    }
    setSavingReplies(true);
    try {
      await updateSettings({ quickReplies }, true);
      setIdle(quickReplies.idle.join("\n"));
      setBusy(quickReplies.busy.join("\n"));
      editedReplies.current = false;
      setDirtyReplies(false);
      toast("快捷指令已保存");
    } catch {
      toast("保存失败，请重试；编辑内容已保留。");
    } finally {
      setSavingReplies(false);
    }
  };

  const resetQuickReplies = (): void => {
    markRepliesDirty();
    setIdle(DEFAULT_QUICK_REPLIES.idle.join("\n"));
    setBusy(DEFAULT_QUICK_REPLIES.busy.join("\n"));
  };

  return (
    <SettingsPage title="设置" detail="外观、阅读字号、常用设备与快捷指令统一在此配置。">
      <SettingsGroup title={`设备管理 · ${hosts.length}`} note="点击已配对设备可编辑直连地址、端口与 Relay。">
        <SettingsLink
          title="添加设备"
          detail="扫码或输入 IP 与配对码连接一台电脑"
          icon="plus"
          onPress={() => router.push("/pair")}
          last={hosts.length === 0}
        />
        {hosts.map((host, index) => (
          <DeviceConnectionRow
            key={host.id}
            host={host}
            runtime={runtimes[host.id]}
            last={index === hosts.length - 1}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="外观" note="立即应用到整个应用；跟随系统会自动切换浅色与深色。">
        <SettingsOptions
          label="主题模式"
          value={settings.themeMode}
          options={THEME_OPTIONS}
          onChange={(themeMode) => { updateSettings({ themeMode }); }}
        />
      </SettingsGroup>

      <SettingsGroup title="对话阅读" note="正文、代码、公式和输入文字同步调整；终端保留独立字号。">
        <ConversationFontControl
          value={settings.conversationFontSize}
          onChange={(conversationFontSize) => updateSettings({ conversationFontSize })}
        />
      </SettingsGroup>

      <SettingsGroup title="首页近期对话数量" note="仅控制最近记录展示条数，不会删除历史会话。">
        <SettingsOptions
          label="首页近期对话数量"
          value={settings.recentSessionLimit}
          options={HOME_RECENT_SESSION_LIMITS.map((value) => ({ value, label: String(value) }))}
          onChange={(recentSessionLimit) => updateSettings({ recentSessionLimit })}
        />
      </SettingsGroup>

      <SettingsGroup title="操作反馈">
        <SettingsRow title="设备切换震动" detail="长按进入快速切换、滑过设备时提供轻微反馈" last>
          <Switch
            accessibilityLabel="设备切换震动"
            value={settings.deviceSwitcherHapticsEnabled}
            onValueChange={(deviceSwitcherHapticsEnabled) => updateSettings({ deviceSwitcherHapticsEnabled })}
            trackColor={{ false: palette.border, true: palette.accentDim }}
            thumbColor={settings.deviceSwitcherHapticsEnabled ? palette.accent : palette.textDim}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="快捷指令"
        note="每行一条，留空可隐藏该组；最多 24 条、每条最多 500 字，点击会直接发送。"
      >
        {(
          [
            { key: "idle", title: "空闲时", value: idle, set: setIdle, last: false },
            { key: "busy", title: "运行中", value: busy, set: setBusy, last: true },
          ] as const
        ).map((group) => (
          <View key={group.key} style={[localStyles.replySection, !group.last && localStyles.replySectionBorder]}>
            <Text style={localStyles.replyLabel}>{group.title}</Text>
            <TextInput
              multiline
              editable={!savingReplies}
              value={group.value}
              onChangeText={(value) => {
                markRepliesDirty();
                group.set(value);
              }}
              accessibilityLabel={`${group.title}的快捷指令，每行一条`}
              placeholder="每行填写一条快捷指令"
              placeholderTextColor={palette.textFaint}
              textAlignVertical="top"
              autoCorrect={false}
              style={localStyles.replyInput}
            />
          </View>
        ))}
        <View style={localStyles.replyActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="保存快捷指令"
            disabled={savingReplies || !dirtyReplies}
            onPress={() => void saveQuickReplies()}
            style={({ pressed }) => [
              localStyles.replySaveBtn,
              (savingReplies || !dirtyReplies) && localStyles.replyBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={localStyles.replySaveText}>{savingReplies ? "正在保存…" : "保存"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="恢复默认快捷指令"
            disabled={savingReplies}
            onPress={resetQuickReplies}
            style={({ pressed }) => [localStyles.replyResetBtn, pressed && styles.pressed]}
          >
            <Text style={localStyles.replyResetText}>恢复默认</Text>
          </Pressable>
        </View>
      </SettingsGroup>
    </SettingsPage>
  );
}

function createLocalStyles(palette: ThemePalette) {
  return StyleSheet.create({
    replySection: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 6,
    },
    replySectionBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    replyLabel: {
      color: palette.textDim,
      fontSize: 12,
      fontWeight: "600",
    },
    replyInput: {
      color: palette.text,
      minHeight: 88,
      fontSize: 14,
      lineHeight: 22,
      paddingVertical: 4,
    },
    replyActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    replySaveBtn: {
      flex: 1,
      minHeight: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.sm,
      backgroundColor: palette.accentBg,
    },
    replyBtnDisabled: {
      opacity: 0.45,
    },
    replySaveText: {
      color: palette.accent,
      fontSize: 13,
      fontWeight: "600",
    },
    replyResetBtn: {
      minHeight: 40,
      paddingHorizontal: 14,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.sm,
    },
    replyResetText: {
      color: palette.textDim,
      fontSize: 13,
    },
  });
}
