import { useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CodeHighlight } from "./CodeHighlight";
import { MarkdownFile } from "./MarkdownFile";
import { DismissKey } from "./DismissKey";
import { codeLanguage, isMarkdownFile, MAX_HIGHLIGHT_CHARS } from "@/lib/code-highlight";
import { MONOSPACE_FONT, useMobileTheme } from "@/lib/theme";
import type { HostConnection } from "@/lib/connection";

type ViewMode = "preview" | "source" | "edit";

/** View modes share the exact same draft; switching never writes or resets the file. */
export function FileContentView({ text, filePath, onChangeText, editable = true, bottomInset = 0,
  hostId, sid, projectRoot, conn }: {
  text: string; filePath: string; onChangeText?: (text: string) => void; editable?: boolean; bottomInset?: number;
  hostId: string; sid: string; projectRoot?: string; conn: HostConnection | null;
}) {
  const { palette } = useMobileTheme();
  const markdown = isMarkdownFile(filePath);
  const language = codeLanguage(filePath);
  const large = text.length > MAX_HIGHLIGHT_CHARS;
  const [mode, setMode] = useState<ViewMode>(markdown && !large ? "preview" : language || !onChangeText ? "source" : "edit");
  const [rainbow, setRainbow] = useState(true);
  const [focused, setFocused] = useState(false);
  const canEdit = Boolean(onChangeText) && editable;
  const current = (mode === "edit" && !canEdit) || (mode === "preview" && large) ? "source" : mode;
  const choose = (next: ViewMode) => { Keyboard.dismiss(); setFocused(false); setMode(next); };
  const options: { mode: ViewMode; label: string; disabled?: boolean }[] = [
    ...(markdown ? [{ mode: "preview" as const, label: "预览", disabled: large }] : []),
    { mode: "source", label: markdown ? "源码" : language ? "代码" : "原文" },
    ...(canEdit ? [{ mode: "edit" as const, label: "编辑" }] : []),
  ];
  return <View style={styles.root}>
    <View style={[styles.toolbar, { borderBottomColor: palette.border }]}>
      <View style={[styles.modes, { backgroundColor: palette.surfaceRaised }]}>
        {options.map((option) => <Pressable key={option.mode} disabled={option.disabled}
          accessibilityRole="tab" accessibilityLabel={option.label}
          accessibilityState={{ selected: current === option.mode, disabled: option.disabled === true }}
          onPress={() => choose(option.mode)} style={[styles.mode, current === option.mode && { backgroundColor: palette.accentBg }, option.disabled && styles.disabled]}>
          <Text style={[styles.label, { color: current === option.mode ? palette.accent : palette.textDim }]}>{option.label}</Text>
        </Pressable>)}
      </View>
      {language && !markdown && current === "source" && !large && <Pressable accessibilityRole="switch"
        accessibilityLabel="彩虹色代码高亮" accessibilityState={{ checked: rainbow }} onPress={() => setRainbow((value) => !value)}
        style={[styles.rainbow, { backgroundColor: rainbow ? palette.accentBg : palette.surfaceRaised }]}>
        <Text style={[styles.label, { color: rainbow ? palette.accent : palette.textDim }]}>彩虹色{rainbow ? " · 开" : " · 关"}</Text>
      </Pressable>}
    </View>
    {large && <Text style={[styles.notice, { color: palette.textDim }]}>文件较大，已使用原文模式以保持流畅。</Text>}
    {current === "preview" && !large ? <ScrollView testID="markdown-file-preview" contentContainerStyle={[styles.document, { paddingBottom: bottomInset + 24 }]}>
      <MarkdownFile source={text} filePath={filePath} projectRoot={projectRoot} hostId={hostId} sid={sid} conn={conn} />
    </ScrollView> : current === "source" && language && !markdown && rainbow && !large ? (
      <ScrollView testID="code-file-preview" contentContainerStyle={{ paddingBottom: bottomInset + 16 }}>
        <ScrollView horizontal contentContainerStyle={styles.document}>
          <Text selectable style={[styles.codeText, { color: palette.text }]}><CodeHighlight code={text} language={language} /></Text>
        </ScrollView>
      </ScrollView>
    ) : <>
      <DismissKey visible={focused} floating />
      <TextInput testID={current === "edit" ? "file-editor" : "file-source"}
        accessibilityLabel={current === "edit" ? "编辑文件内容" : "文件源码"}
        style={[styles.editor, { color: palette.text, paddingBottom: bottomInset + 16 }]}
        value={text} onChangeText={onChangeText} editable={current === "edit" && canEdit}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} multiline autoCapitalize="none" autoCorrect={false} spellCheck={false} />
    </>}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, toolbar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8,
    paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  modes: { flexDirection: "row", padding: 3, borderRadius: 10 }, mode: { minHeight: 38, minWidth: 54, paddingHorizontal: 10,
    alignItems: "center", justifyContent: "center", borderRadius: 8 },
  label: { fontSize: 12, fontWeight: "600" }, rainbow: { minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: 20 },
  disabled: { opacity: 0.4 }, notice: { paddingHorizontal: 14, paddingVertical: 8, fontSize: 11 },
  document: { padding: 16 }, codeText: { fontFamily: MONOSPACE_FONT, fontSize: 13, lineHeight: 20 },
  editor: { flex: 1, fontFamily: MONOSPACE_FONT, fontSize: 13, lineHeight: 20, padding: 14, textAlignVertical: "top" },
});
