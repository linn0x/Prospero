import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { AgentAccount, AgentApiCatalogModel, CodeAgentKind, ModelSource } from "@prospero/protocol";
import { accountApiProtocolLabel } from "../lib/account-api-profile";
import {
  agentForSourceRoute,
  availableSourceRoutes,
  defaultModelSourceRoute,
  modelSourcePresentation,
  resolveBoundModelSource,
  sourceCatalogTarget,
  sourceRouteLabel,
  sourceRouteMatchesAgent,
  type SourceModelChoice,
} from "@/lib/session-model-sources";
import { useMobileTheme } from "@/lib/theme";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

export function SessionModelSourceSelect({
  agent,
  sources,
  selectedAccount,
  effort,
  onEffortChange,
  loading,
  error,
  disabled,
  onRetry,
  onLoadModels,
  onSelect,
}: {
  agent: CodeAgentKind;
  sources: ModelSource[];
  selectedAccount?: AgentAccount;
  effort?: string | null;
  onEffortChange?: (effort: string | null) => void;
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
  const [busyRouteId, setBusyRouteId] = useState(null as string | null);
  const busyRef = useRef(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<AgentApiCatalogModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);

  const available = useMemo(
    () =>
      sources
        .filter((source) => source.enabled)
        .map((source) => ({
          source,
          routes: availableSourceRoutes(source, agent),
          target: sourceCatalogTarget(source, agent),
        }))
        .filter((entry) => entry.routes.length > 0 || entry.target !== null),
    [sources, agent],
  );

  const boundSelection = useMemo(
    () => resolveBoundModelSource(sources, selectedAccount, agent),
    [agent, selectedAccount, sources],
  );
  const defaultSelection = useMemo(
    () => defaultModelSourceRoute(sources, agent),
    [agent, sources],
  );
  const activeSelection = boundSelection ?? defaultSelection;

  const selected = available.find((entry) => entry.source.id === sourceId);
  const search = query.trim().toLocaleLowerCase();
  const matches =
    selected?.routes.filter((route) =>
      `${route.name} ${route.model}`.toLocaleLowerCase().includes(search),
    ) ?? [];
  const target = selected?.target ?? null;
  const catalogOnly =
    selected && target
      ? catalog.filter(
          (model) =>
            model.modelCapabilities?.tools !== false &&
            !selected.source.routes.some(
              (route) => route.model === model.id && sourceRouteMatchesAgent(route, agent),
            ) &&
            `${model.label ?? ""} ${model.id}`.toLocaleLowerCase().includes(search),
        )
      : [];

  useEffect(() => {
    if (!open || !selected || !target) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setCatalogLoading(true);
      setCatalogError(null);
      setCatalog([]);
      void onLoadModels(selected.source)
        .then(
          (models) => {
            if (!cancelled) setCatalog(models);
          },
          (failure: unknown) => {
            if (!cancelled) {
              setCatalogError(failure instanceof Error ? failure.message : "无法读取模型目录。");
            }
          },
        )
        .finally(() => {
          if (!cancelled) setCatalogLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, selected, target, onLoadModels, catalogReload]);

  const choose = (source: ModelSource, choice: SourceModelChoice, id: string): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setBusyRouteId(id);
    setSelectionError(null);
    void onSelect(source, choice)
      .then(
        () => setOpen(false),
        (failure: unknown) =>
          setSelectionError(failure instanceof Error ? failure.message : "无法选择模型，请重试。"),
      )
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
        setBusyRouteId(null);
      });
  };

  const supportedEfforts =
    activeSelection && activeSelection.route.protocol !== "openai_chat_completions"
      ? (activeSelection.route.modelCapabilities?.supportedEfforts ?? [])
      : [];
  const activeEffort =
    effort && supportedEfforts.some((level) => level === effort)
      ? effort
      : activeSelection?.route.defaultEffort ?? null;
  const credentialName = activeSelection
    ? activeSelection.source.credentials.find(
        (item) => item.id === activeSelection.route.credentialId,
      )?.name ?? "默认凭据"
    : null;

  return (
    <View style={styles.section}>
      <View style={styles.labelRow}>
        <Text style={{ color: palette.textDim, fontSize: 12.5, fontWeight: "600" }}>
          API 模型源与已启用模型
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="刷新模型源"
          disabled={disabled || loading}
          onPress={onRetry}
          hitSlop={8}
        >
          <Text style={{ color: palette.accent, fontSize: 12.5, fontWeight: "600" }}>
            {loading ? "读取中…" : "↻ 刷新模型源"}
          </Text>
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="从模型源选择模型"
        disabled={disabled || loading}
        onPress={() => {
          setSourceId(null);
          setQuery("");
          setSelectionError(null);
          setOpen(true);
        }}
        style={[
          styles.selector,
          { backgroundColor: palette.surfaceRaised, borderColor: palette.border },
          (disabled || loading) && { opacity: 0.55 },
        ]}
      >
        <View style={styles.copy}>
          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={{ color: palette.text, fontWeight: "600", flexShrink: 1 }}>
              {activeSelection
                ? `${activeSelection.source.name} · ${sourceRouteLabel(activeSelection.route)}`
                : "从模型源选择模型"}
            </Text>
            {activeSelection && !activeSelection.bound && (
              <Text style={[styles.badge, { color: palette.accent, backgroundColor: palette.accentBg }]}>
                默认
              </Text>
            )}
          </View>
          <Text numberOfLines={1} style={{ color: palette.textDim, fontSize: 12 }}>
            {loading
              ? "正在读取 API 模型源…"
              : activeSelection
                ? `${activeSelection.route.model} · 点按切换模型源或从目录启用新模型`
                : `${available.length} 个可用模型源 · 自动匹配 Agent`}
          </Text>
        </View>
        {loading ? (
          <ActivityIndicator color={palette.accent} />
        ) : (
          <Icon name="chevron.down" size={15} color={palette.textDim} />
        )}
      </Pressable>

      {activeSelection && (
        <View style={[styles.statusBar, { backgroundColor: palette.surfaceRaised, borderColor: palette.border }]}>
          <Text style={{ color: palette.textDim, fontSize: 11.5, lineHeight: 17 }}>
            {[
              `协议：${accountApiProtocolLabel(activeSelection.route.protocol)}`,
              `模型：${activeSelection.route.model}`,
              activeSelection.route.modelCapabilities?.contextWindow
                ? `上下文：${activeSelection.route.modelCapabilities.contextWindow.toLocaleString()}`
                : null,
              credentialName ? `凭据：${credentialName}` : null,
              activeEffort ? `强度：${activeEffort}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      )}

      {boundSelection?.staleRevision && (
        <View style={[styles.staleBanner, { backgroundColor: palette.warnBg }]}>
          <Text style={{ color: palette.warn, fontSize: 12, flex: 1 }}>
            模型源已更新，请确认后使用新配置。
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={disabled || busy}
            onPress={() =>
              choose(
                boundSelection.source,
                { kind: "route", route: boundSelection.route },
                boundSelection.route.id,
              )
            }
          >
            <Text style={{ color: palette.accent, fontSize: 12, fontWeight: "700" }}>
              使用新配置
            </Text>
          </Pressable>
        </View>
      )}

      {activeSelection && supportedEfforts.length > 0 && onEffortChange && (
        <View style={styles.effortGroup}>
          <Text style={{ color: palette.textDim, fontSize: 12, fontWeight: "600" }}>推理强度</Text>
          <View style={styles.effortChips}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: !effort }}
              onPress={() => onEffortChange(null)}
              style={[
                styles.effortChip,
                {
                  backgroundColor: !effort ? palette.text : palette.surfaceRaised,
                  borderColor: !effort ? palette.text : palette.border,
                },
              ]}
            >
              <Text style={{ color: !effort ? palette.bg : palette.textDim, fontSize: 12, fontWeight: "600" }}>
                {activeSelection.route.defaultEffort
                  ? `路由默认 (${activeSelection.route.defaultEffort})`
                  : "模型默认"}
              </Text>
            </Pressable>
            {supportedEfforts.map((level) => {
              const checked = effort === level;
              return (
                <Pressable
                  key={level}
                  accessibilityRole="radio"
                  accessibilityState={{ checked }}
                  onPress={() => onEffortChange(level)}
                  style={[
                    styles.effortChip,
                    {
                      backgroundColor: checked ? palette.text : palette.surfaceRaised,
                      borderColor: checked ? palette.text : palette.border,
                    },
                  ]}
                >
                  <Text style={{ color: checked ? palette.bg : palette.textDim, fontSize: 12, fontWeight: "600" }}>
                    {level}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {!loading && available.length === 0 && !error && (
        <Text style={{ color: palette.textDim, fontSize: 12, lineHeight: 18 }}>
          请在「账号与模型源」页面的 API 模型源中添加并启用模型。
        </Text>
      )}

      {error && (
        <View style={styles.errorRow}>
          <Text accessibilityRole="alert" style={[styles.copy, { color: palette.warn, fontSize: 12 }]}>
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重新读取模型源"
            onPress={onRetry}
            disabled={disabled}
          >
            <Text style={{ color: palette.accent, fontWeight: "600" }}>重试</Text>
          </Pressable>
        </View>
      )}

      <Sheet
        visible={open}
        title={selected ? selected.source.name : "选择 API 模型源"}
        contentKey={selected?.source.id ?? "sources"}
        presentation={modelSourcePresentation(width, height)}
        onClose={() => {
          if (!busyRef.current) setOpen(false);
        }}
      >
        {selected ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回模型源列表"
              disabled={busy}
              onPress={() => {
                setSourceId(null);
                setQuery("");
                setSelectionError(null);
              }}
              style={styles.back}
            >
              <Text style={{ color: palette.accent, fontWeight: "600" }}>‹ API 模型源列表</Text>
            </Pressable>
            <TextInput
              accessibilityLabel="搜索模型源中的模型"
              value={query}
              onChangeText={setQuery}
              placeholder="搜索模型名称或 ID"
              placeholderTextColor={palette.textFaint}
              autoCorrect={false}
              autoCapitalize="none"
              editable={!busy}
              style={[
                styles.search,
                { color: palette.text, borderColor: palette.border, backgroundColor: palette.surfaceRaised },
              ]}
            />
            <Text style={{ color: palette.textDim, fontSize: 12, marginVertical: 10 }}>
              已启用 {matches.length} 个 · 目录新增 {catalogOnly.length} 个
              {catalogLoading ? " · 正在读取目录…" : ""}
            </Text>
            {catalogError && (
              <View style={styles.errorRow}>
                <Text style={[styles.copy, { color: palette.warn, fontSize: 12 }]}>
                  目录读取失败，仍可选择已启用模型：{catalogError}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="重新读取模型目录"
                  disabled={busy}
                  onPress={() => setCatalogReload((value) => value + 1)}
                >
                  <Text style={{ color: palette.accent, fontWeight: "600" }}>重试</Text>
                </Pressable>
              </View>
            )}
            {selectionError && (
              <Text accessibilityRole="alert" style={{ color: palette.warn, marginBottom: 10 }}>
                {selectionError}
              </Text>
            )}
            {matches.map((route) => {
              const isCurrent =
                activeSelection?.source.id === selected.source.id &&
                activeSelection?.route.id === route.id;
              return (
                <Pressable
                  key={route.id}
                  accessibilityRole="button"
                  accessibilityLabel={`选择模型 ${route.name}，${route.model}`}
                  disabled={busy}
                  onPress={() => choose(selected.source, { kind: "route", route }, route.id)}
                  style={[
                    styles.row,
                    {
                      backgroundColor: isCurrent ? palette.accentBg : palette.surfaceRaised,
                      borderColor: isCurrent ? palette.accent : palette.border,
                    },
                    busy && { opacity: 0.55 },
                  ]}
                >
                  <View style={styles.copy}>
                    <View style={styles.titleRow}>
                      <Text style={{ color: palette.text, fontWeight: "600", flexShrink: 1 }}>
                        {sourceRouteLabel(route)}
                      </Text>
                      {selected.source.defaultRouteId === route.id && (
                        <Text style={[styles.badge, { color: palette.accent, backgroundColor: palette.accentBg }]}>
                          默认
                        </Text>
                      )}
                    </View>
                    <Text style={{ color: palette.textDim, fontSize: 12 }}>
                      {route.model} · {agentForSourceRoute(route, agent)} ·{" "}
                      {selected.source.credentials.find((credential) => credential.id === route.credentialId)
                        ?.name ?? "凭据"}
                    </Text>
                  </View>
                  {busyRouteId === route.id ? (
                    <ActivityIndicator color={palette.accent} />
                  ) : isCurrent ? (
                    <Icon name="checkmark.circle.fill" size={18} color={palette.accent} />
                  ) : (
                    <Icon name="chevron.right" size={15} color={palette.textDim} />
                  )}
                </Pressable>
              );
            })}
            {target &&
              catalogOnly.map((model) => (
                <Pressable
                  key={model.id}
                  accessibilityRole="button"
                  accessibilityLabel={`选择并启用模型 ${model.label?.trim() || model.id}，${model.id}`}
                  disabled={busy}
                  onPress={() =>
                    choose(selected.source, { kind: "catalog", model, ...target }, model.id)
                  }
                  style={[
                    styles.row,
                    { backgroundColor: palette.surfaceRaised, borderColor: palette.border },
                    busy && { opacity: 0.55 },
                  ]}
                >
                  <View style={styles.copy}>
                    <Text style={{ color: palette.text, fontWeight: "600" }}>
                      {model.label?.trim() || model.id}
                    </Text>
                    <Text style={{ color: palette.textDim, fontSize: 12 }}>
                      {model.id} · 选择后自动启用
                    </Text>
                  </View>
                  {busyRouteId === model.id ? (
                    <ActivityIndicator color={palette.accent} />
                  ) : (
                    <Icon name="plus" size={15} color={palette.accent} />
                  )}
                </Pressable>
              ))}
            {!catalogLoading && !matches.length && !catalogOnly.length && (
              <Text style={{ color: palette.textDim, paddingVertical: 16 }}>没有匹配的可用模型。</Text>
            )}
          </>
        ) : (
          <>
            <Text style={{ color: palette.textDim, fontSize: 12, marginBottom: 10 }}>
              先选择 API 模型源，再选择已启用模型；目录中的新模型会在选择后自动启用。
            </Text>
            {available.map(({ source, routes, target }) => (
              <Pressable
                key={source.id}
                accessibilityRole="button"
                accessibilityLabel={`模型源 ${source.name}，${routes.length} 个已启用模型`}
                onPress={() => {
                  setSourceId(source.id);
                  setQuery("");
                }}
                style={[
                  styles.row,
                  {
                    backgroundColor:
                      activeSelection?.source.id === source.id ? palette.accentBg : palette.surfaceRaised,
                    borderColor:
                      activeSelection?.source.id === source.id ? palette.accent : palette.border,
                  },
                ]}
              >
                <View style={styles.copy}>
                  <Text style={{ color: palette.text, fontWeight: "600" }}>{source.name}</Text>
                  <Text style={{ color: palette.textDim, fontSize: 12 }}>
                    {routes.length} 个已启用模型 · {source.credentials.length} 组凭据
                    {target ? " · 可读取服务商目录" : ""}
                  </Text>
                </View>
                <Icon name="chevron.right" size={15} color={palette.textDim} />
              </Pressable>
            ))}
            {!available.length && (
              <Text style={{ color: palette.textDim, paddingVertical: 16 }}>
                暂无已启用模型的 API 模型源。
              </Text>
            )}
          </>
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  selector: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  badge: {
    fontSize: 10.5,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 999,
    overflow: "hidden",
  },
  statusBar: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  staleBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
  },
  effortGroup: { gap: 6, paddingTop: 2 },
  effortChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  effortChip: {
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  back: { minHeight: 40, justifyContent: "center" },
  search: { minHeight: 44, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10 },
  row: {
    minHeight: 62,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});
