import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { AgentApiCatalogModel, CodeAgentKind, ModelSource } from "@prospero/protocol";
import { agentForSourceRoute, availableSourceRoutes, modelSourcePresentation, sourceCatalogTarget, sourceRouteMatchesAgent, type SourceModelChoice } from "@/lib/session-model-sources";
import { useMobileTheme } from "@/lib/theme";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

export function SessionModelSourceSelect({ agent, sources, loading, error, disabled, onRetry, onLoadModels, onSelect }: {
  agent: CodeAgentKind;
  sources: ModelSource[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onRetry(): void;
  onLoadModels(source: ModelSource): Promise<AgentApiCatalogModel[]>;
  onSelect(source: ModelSource, choice: SourceModelChoice): Promise<void>;
}) {
  const { palette } = useMobileTheme();
  const { width, height } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyRouteId, setBusyRouteId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<AgentApiCatalogModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);
  const available = useMemo(() => sources.filter((source) => source.enabled).map((source) => ({ source, routes: availableSourceRoutes(source, agent), target: sourceCatalogTarget(source, agent) })).filter((entry) => entry.routes.length > 0 || entry.target !== null), [sources, agent]);
  const selected = available.find((entry) => entry.source.id === sourceId);
  const search = query.trim().toLocaleLowerCase();
  const matches = selected?.routes.filter((route) => `${route.name} ${route.model}`.toLocaleLowerCase().includes(search)) ?? [];
  const target = selected?.target ?? null;
  const catalogOnly = selected && target ? catalog.filter((model) => model.modelCapabilities?.tools !== false && !selected.source.routes.some((route) => route.model === model.id && sourceRouteMatchesAgent(route, agent)) && `${model.label ?? ""} ${model.id}`.toLocaleLowerCase().includes(search)) : [];
  useEffect(() => {
    if (!open || !selected || !target) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setCatalogLoading(true); setCatalogError(null); setCatalog([]);
      void onLoadModels(selected.source).then((models) => { if (!cancelled) setCatalog(models); }, (failure: unknown) => {
        if (!cancelled) setCatalogError(failure instanceof Error ? failure.message : "无法读取模型目录。");
      }).finally(() => { if (!cancelled) setCatalogLoading(false); });
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, selected, target, onLoadModels, catalogReload]);
  const choose = (choice: SourceModelChoice, id: string): void => {
    if (!selected || busyRef.current) return;
    busyRef.current = true; setBusy(true); setBusyRouteId(id); setSelectionError(null);
    void onSelect(selected.source, choice).then(() => setOpen(false), (failure: unknown) => setSelectionError(failure instanceof Error ? failure.message : "无法选择模型，请重试。"))
      .finally(() => { busyRef.current = false; setBusy(false); setBusyRouteId(null); });
  };
  return <View style={styles.section}>
    <Pressable accessibilityRole="button" accessibilityLabel="从模型源选择模型" disabled={disabled || loading}
      onPress={() => { setSourceId(null); setQuery(""); setSelectionError(null); setOpen(true); }}
      style={[styles.selector, { backgroundColor: palette.surfaceRaised }, (disabled || loading) && { opacity: 0.55 }]}>
      <View style={styles.copy}><Text style={{ color: palette.text, fontWeight: "600" }}>从模型源选择模型</Text>
        <Text style={{ color: palette.textDim, fontSize: 12 }}>{loading ? "正在读取模型源…" : `${available.length} 个可用模型源 · 自动匹配 Agent`}</Text></View>
      {loading ? <ActivityIndicator color={palette.accent} /> : <Icon name="chevron.right" size={16} color={palette.accent} />}
    </Pressable>
    {error && <View style={styles.errorRow}><Text accessibilityRole="alert" style={[styles.copy, { color: palette.warn }]}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新读取模型源" onPress={onRetry} disabled={disabled}><Text style={{ color: palette.accent }}>重试</Text></Pressable></View>}
    <Sheet visible={open} title={selected ? selected.source.name : "选择模型源"} contentKey={selected?.source.id ?? "sources"} presentation={modelSourcePresentation(width, height)} onClose={() => { if (!busyRef.current) setOpen(false); }}>
      {selected ? <>
        <Pressable accessibilityRole="button" accessibilityLabel="返回模型源列表" disabled={busy} onPress={() => { setSourceId(null); setQuery(""); setSelectionError(null); }} style={styles.back}><Text style={{ color: palette.accent }}>‹ 模型源</Text></Pressable>
        <TextInput accessibilityLabel="搜索模型源中的模型" value={query} onChangeText={setQuery} placeholder="搜索模型名称或 ID" placeholderTextColor={palette.textFaint} autoCorrect={false} autoCapitalize="none" editable={!busy}
          style={[styles.search, { color: palette.text, borderColor: palette.border }]} />
        <Text style={{ color: palette.textDim, marginVertical: 10 }}>已启用 {matches.length} 个 · 目录新增 {catalogOnly.length} 个{catalogLoading ? " · 正在读取目录…" : ""}</Text>
        {catalogError && <View style={styles.errorRow}><Text style={[styles.copy, { color: palette.warn }]}>目录读取失败，仍可选择已启用模型：{catalogError}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="重新读取模型目录" disabled={busy} onPress={() => setCatalogReload((value) => value + 1)}><Text style={{ color: palette.accent }}>重试</Text></Pressable></View>}
        {selectionError && <Text accessibilityRole="alert" style={{ color: palette.warn, marginBottom: 10 }}>{selectionError}</Text>}
        {matches.map((route) => <Pressable key={route.id} accessibilityRole="button" accessibilityLabel={`选择模型 ${route.name}，${route.model}`} disabled={busy}
          onPress={() => choose({ kind: "route", route }, route.id)}
          style={[styles.row, { backgroundColor: palette.surfaceRaised }, busy && { opacity: 0.55 }]}>
          <View style={styles.copy}><Text style={{ color: palette.text, fontWeight: "600" }}>{route.name}</Text><Text style={{ color: palette.textDim, fontSize: 12 }}>{route.model} · {agentForSourceRoute(route, agent)} · {selected.source.credentials.find((credential) => credential.id === route.credentialId)?.name ?? "凭据"}</Text></View>
          {busyRouteId === route.id ? <ActivityIndicator color={palette.accent} /> : <Icon name="chevron.right" size={16} color={palette.accent} />}
        </Pressable>)}
        {target && catalogOnly.map((model) => <Pressable key={model.id} accessibilityRole="button" accessibilityLabel={`选择并启用模型 ${model.label?.trim() || model.id}，${model.id}`} disabled={busy}
          onPress={() => choose({ kind: "catalog", model, ...target }, model.id)} style={[styles.row, { backgroundColor: palette.surfaceRaised }, busy && { opacity: 0.55 }]}>
          <View style={styles.copy}><Text style={{ color: palette.text, fontWeight: "600" }}>{model.label?.trim() || model.id}</Text>
            <Text style={{ color: palette.textDim, fontSize: 12 }}>{model.id} · 选择后启用</Text></View>
          {busyRouteId === model.id ? <ActivityIndicator color={palette.accent} /> : <Icon name="chevron.right" size={16} color={palette.accent} />}
        </Pressable>)}
        {!catalogLoading && !matches.length && !catalogOnly.length && <Text style={{ color: palette.textDim, paddingVertical: 16 }}>没有匹配的可用模型。</Text>}
      </> : <>
        <Text style={{ color: palette.textDim, marginBottom: 10 }}>选择模型源，再选择模型；目录中的新模型会在选择后启用。</Text>
        {available.map(({ source, routes, target }) => <Pressable key={source.id} accessibilityRole="button" accessibilityLabel={`模型源 ${source.name}，${routes.length} 个已启用模型`}
          onPress={() => { setSourceId(source.id); setQuery(""); }} style={[styles.row, { backgroundColor: palette.surfaceRaised }]}>
          <View style={styles.copy}><Text style={{ color: palette.text, fontWeight: "600" }}>{source.name}</Text><Text style={{ color: palette.textDim, fontSize: 12 }}>{routes.length} 个已启用{target ? " · 可读取目录" : ""}</Text></View>
          <Icon name="chevron.right" size={16} color={palette.accent} />
        </Pressable>)}
        {!available.length && <Text style={{ color: palette.textDim, paddingVertical: 16 }}>暂无已启用模型的模型源。</Text>}
      </>}
    </Sheet>
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 8, marginTop: 8 },
  selector: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12 },
  copy: { flex: 1, minWidth: 0, gap: 5 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  back: { minHeight: 44, justifyContent: "center" },
  search: { minHeight: 48, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 },
  row: { minHeight: 64, padding: 12, borderRadius: 10, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 12 },
});
