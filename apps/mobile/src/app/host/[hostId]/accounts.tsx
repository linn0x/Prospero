import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import type {
  AgentAccount,
  AgentApiCatalogModel,
  AgentApiProtocol,
  AgentCredentialKind,
  AgentModelCapabilities,
  CodeAgentKind,
  ModelSource,
  ModelSourceMigration,
  ModelSourceRoute,
  S2CMessage,
  UsageAccount,
} from "@prospero/protocol";
import { CAPABILITY_MODEL_SOURCES, getAgentAccountEngine } from "@prospero/protocol";
import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import {
  accountApiEngineStatus,
  accountApiProtocolDefaults,
  accountApiProtocolFromProfile,
  accountApiProtocolLabel,
  accountApiProtocolsForAgent,
  accountApiStatus,
  modelCapabilitySupportRows,
  modelTokenLimit,
  updateModelTokenLimit,
} from "@/lib/account-api-profile";
import { catalogRouteInput, sourceRouteLabel } from "@/lib/session-model-sources";
import { useHostConnection } from "@/lib/use-host-connection";
import { untilLabel } from "@/lib/format";
import { color, font, quotaRemainingColor, quotaRemainingPct, radius, space } from "@/lib/theme";

type UsageResult = Extract<S2CMessage, { type: "usage.result" }>;

type AccountsPageCache = {
  accounts: AgentAccount[];
  sources: ModelSource[];
  usage: UsageResult | null;
  accountsUpdatedAt: number;
  sourcesUpdatedAt: number;
};

const ACCOUNTS_CACHE_TTL_MS = 60_000;
const accountsPageCache = new Map<string, AccountsPageCache>();

function cacheAccounts(hostId: string, accounts: AgentAccount[]): void {
  const cached = accountsPageCache.get(hostId);
  accountsPageCache.set(hostId, {
    accounts,
    sources: cached?.sources ?? [],
    usage: cached?.usage ?? null,
    accountsUpdatedAt: Date.now(),
    sourcesUpdatedAt: cached?.sourcesUpdatedAt ?? 0,
  });
}

function cacheSources(hostId: string, sources: ModelSource[]): void {
  const cached = accountsPageCache.get(hostId);
  accountsPageCache.set(hostId, {
    accounts: cached?.accounts ?? [],
    sources,
    usage: cached?.usage ?? null,
    accountsUpdatedAt: cached?.accountsUpdatedAt ?? 0,
    sourcesUpdatedAt: Date.now(),
  });
}

function cacheUsage(hostId: string, usage: UsageResult | null): void {
  const cached = accountsPageCache.get(hostId);
  accountsPageCache.set(hostId, {
    accounts: cached?.accounts ?? [],
    sources: cached?.sources ?? [],
    usage,
    accountsUpdatedAt: cached?.accountsUpdatedAt ?? 0,
    sourcesUpdatedAt: cached?.sourcesUpdatedAt ?? 0,
  });
}

type Editor =
  | { kind: "create"; agent: CodeAgentKind }
  | { kind: "rename"; account: AgentAccount }
  | { kind: "credential"; account: AgentAccount; credentialKind: AgentCredentialKind }
  | {
      kind: "api";
      agent: CodeAgentKind;
      account?: AgentAccount;
      phase: "name" | "baseUrl" | "model" | "contextWindow" | "maxOutputTokens" | "apiKey";
      draft: {
        name: string;
        protocol: AgentApiProtocol;
        baseUrl: string;
        model: string;
        modelCapabilities?: AgentModelCapabilities;
      };
    }
  | {
      kind: "source-create";
      phase: "name" | "baseUrl" | "apiKey";
      draft: { name: string; protocol: AgentApiProtocol; baseUrl: string };
    }
  | {
      kind: "source-route";
      source: ModelSource;
      protocol: AgentApiProtocol;
    }
  | {
      kind: "source-credential";
      source: ModelSource;
      credentialId?: string;
      credentialName: string;
    }
  | null;

const agentTitle: Record<CodeAgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  agy: "Antigravity",
};

const statusText: Record<AgentAccount["status"], string> = {
  signed_in: "已登录",
  signed_out: "未登录",
  unavailable: "CLI 未安装",
  error: "状态读取失败",
};

const statusColor: Record<AgentAccount["status"], string> = {
  signed_in: color.success,
  signed_out: color.textFaint,
  unavailable: color.warn,
  error: color.danger,
};

export default function AgentAccountsScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { conn, runtime } = useHostConnection(hostId);
  const initialCache = hostId ? accountsPageCache.get(hostId) : undefined;
  const [accounts, setAccounts] = useState<AgentAccount[]>(() => initialCache?.accounts ?? []);
  const [sources, setSources] = useState<ModelSource[]>(() => initialCache?.sources ?? []);
  const [dimension, setDimension] = useState<"subscriptions" | "sources">("subscriptions");
  const [providerFilter, setProviderFilter] = useState<"all" | CodeAgentKind>("all");
  const [showLegacyApi, setShowLegacyApi] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [routeFilter, setRouteFilter] = useState("");
  const [catalogModels, setCatalogModels] = useState<AgentApiCatalogModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadedFor, setCatalogLoadedFor] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [migrations, setMigrations] = useState<ModelSourceMigration[] | null>(null);
  const [loading, setLoading] = useState(() => initialCache === undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResult | null>(() => initialCache?.usage ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [editor, setEditor] = useState<Editor>(null);
  const [name, setName] = useState("");

  const rememberAccounts = useCallback((nextAccounts: AgentAccount[]): void => {
    setAccounts(nextAccounts);
    if (hostId) cacheAccounts(hostId, nextAccounts);
  }, [hostId]);
  const rememberSources = useCallback((nextSources: ModelSource[]): void => {
    setSources(nextSources);
    if (hostId) cacheSources(hostId, nextSources);
  }, [hostId]);

  const refresh = useCallback(async (showLoading = false): Promise<void> => {
    if (!conn || runtime.status !== "connected") {
      setLoading(false);
      return;
    }
    if (!conn.supportsAgentAccounts) {
      setError("当前电脑端还不支持账号管理，请先升级并重启 Prospero daemon。");
      setLoading(false);
      return;
    }
    const cached = hostId ? accountsPageCache.get(hostId) : undefined;
    setLoading(showLoading || cached === undefined);
    setError(null);
    try {
      const [nextAccounts, nextUsage, sourceResult] = await Promise.all([
        conn.agentAccounts(),
        conn.usageGet().catch(() => null),
        conn.supportsModelSources ? conn.modelSourceAction({ kind: "list" }).catch(() => null) : null,
      ]);
      rememberAccounts(nextAccounts);
      if (sourceResult?.sources) rememberSources(sourceResult.sources);
      else if (!conn.supportsModelSources) rememberSources([]);
      setUsage(nextUsage);
      if (hostId) cacheUsage(hostId, nextUsage);
      setNow(Date.now());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [conn, hostId, rememberAccounts, rememberSources, runtime.status]);

  useFocusEffect(
    useCallback(() => {
      const cached = hostId ? accountsPageCache.get(hostId) : undefined;
      if (cached) {
        setAccounts(cached.accounts);
        setSources(cached.sources);
        setUsage(cached.usage);
        setNow(Date.now());
        setLoading(false);
      }
      const accountsStale = !cached || Date.now() - cached.accountsUpdatedAt >= ACCOUNTS_CACHE_TTL_MS;
      const sourcesStale = conn?.supportsModelSources === true && (!cached || Date.now() - cached.sourcesUpdatedAt >= 10_000);
      if (accountsStale || sourcesStale) {
        void refresh(cached === undefined);
      }
      return undefined;
    }, [conn?.supportsModelSources, hostId, refresh]),
  );

  useEffect(() => {
    if (!conn || runtime.status !== "connected") return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void conn.usageGet().then((nextUsage) => {
        setUsage(nextUsage);
        if (hostId) cacheUsage(hostId, nextUsage);
      }, () => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [conn, hostId, runtime.status]);

  const visibleAccounts = useMemo(
    () => accounts.filter((account) => !account.modelSource),
    [accounts],
  );
  const subscriptionAccounts = useMemo(
    () => visibleAccounts.filter((account) => !account.apiProfile && !account.apiProfileError),
    [visibleAccounts],
  );
  const legacyApiAccounts = useMemo(
    () => visibleAccounts.filter((account) => Boolean(account.apiProfile || account.apiProfileError)),
    [visibleAccounts],
  );
  const displayedAccounts = useMemo(
    () =>
      (showLegacyApi ? visibleAccounts : subscriptionAccounts).filter(
        (account) => providerFilter === "all" || getAgentAccountEngine(account) === providerFilter,
      ),
    [providerFilter, showLegacyApi, subscriptionAccounts, visibleAccounts],
  );

  const countByEngine = useMemo(() => {
    const counts: Record<CodeAgentKind, number> = {
      codex: 0,
      claude: 0,
      agy: 0,
      pi: 0,
      opencode: 0,
    };
    for (const account of subscriptionAccounts) {
      counts[getAgentAccountEngine(account)] += 1;
    }
    return counts;
  }, [subscriptionAccounts]);

  const usageByAccount = useMemo(() => {
    const result = new Map<string, UsageAccount>();
    for (const item of usage?.accounts ?? []) {
      if (item.accountId) result.set(item.accountId, item);
    }
    return result;
  }, [usage]);

  const activeSource = useMemo(
    () => sources.find((item) => item.id === selectedSourceId) ?? sources[0] ?? null,
    [selectedSourceId, sources],
  );
  const filteredRoutes = useMemo(() => {
    if (!activeSource) return [];
    const q = routeFilter.trim().toLowerCase();
    return activeSource.routes.filter((route) =>
      `${route.name} ${route.model}`.toLowerCase().includes(q),
    );
  }, [activeSource, routeFilter]);

  const mutate = async (
    accountId: string,
    action: () => Promise<{ accounts: AgentAccount[] }>,
  ): Promise<void> => {
    setBusyId(accountId);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      rememberAccounts(result.accounts);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {
      setBusyId(null);
    }
  };

  const openCreate = (agent: CodeAgentKind): void => {
    setName("");
    setEditor({ kind: "create", agent });
  };

  const openRename = (account: AgentAccount): void => {
    setName(account.name);
    setEditor({ kind: "rename", account });
  };

  const openCredential = (
    account: AgentAccount,
    credentialKind: AgentCredentialKind,
  ): void => {
    setName("");
    setEditor({ kind: "credential", account, credentialKind });
  };

  const openCreateApi = (agent: CodeAgentKind): void => {
    const open = (protocol: AgentApiProtocol): void => {
      const defaults = accountApiProtocolDefaults(protocol);
      setName("");
      setEditor({
        kind: "api",
        agent,
        phase: "name",
        draft: { name: "", protocol, ...defaults },
      });
    };
    const protocols = accountApiProtocolsForAgent(
      agent,
      conn?.supportsAgentApiProtocols === true,
    );
    if (conn?.supportsAgentApiProtocols !== true) {
      open(protocols[0]!);
      return;
    }
    Alert.alert("选择 API 协议", "请选择服务端实际提供的接口。", [
      ...protocols.map((protocol) => ({
        text: accountApiProtocolLabel(protocol),
        onPress: () => open(protocol),
      })),
      { text: "取消", style: "cancel" as const },
    ]);
  };

  const openCreateModelSource = (): void => {
    const protocols: AgentApiProtocol[] = [
      "openai_responses",
      "openai_chat_completions",
      "anthropic",
    ];
    Alert.alert("添加 API 模型源", "选择该服务商或网关提供的接口协议。", [
      ...protocols.map((protocol) => ({
        text: accountApiProtocolLabel(protocol),
        onPress: () => {
          setName("");
          setEditor({
            kind: "source-create",
            phase: "name",
            draft: {
              name: "",
              protocol,
              baseUrl: accountApiProtocolDefaults(protocol).baseUrl,
            },
          });
        },
      })),
      { text: "取消", style: "cancel" as const },
    ]);
  };

  const bindModelSource = async (
    agent: CodeAgentKind,
    source: ModelSource,
    route: ModelSourceRoute,
    launchSession = false,
  ): Promise<void> => {
    if (!conn) return;
    setBusyId(`source:${source.id}:${route.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await conn.modelSourceAction({ kind: "bind", sourceId: source.id, revision: source.revision, routeId: route.id, agent });
      if (result.accounts) rememberAccounts(result.accounts);
      if (result.sources) rememberSources(result.sources);
      if (!result.accounts || !result.sources) await refresh(false);
      if (launchSession && hostId && result.accountId) {
        router.push({
          pathname: "/host/[hostId]",
          params: {
            hostId,
            quickCreate: "conversation",
            authMode: "source",
            accountId: result.accountId,
          },
        });
      } else {
        setNotice(`已绑定 ${source.name} / ${route.name}`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  const runSourceMutation = async (
    busyKey: string,
    work: () => ReturnType<NonNullable<typeof conn>["modelSourceAction"]>,
    successNote?: string,
  ): Promise<void> => {
    if (!conn) return;
    setBusyId(busyKey);
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      if (result.sources) rememberSources(result.sources);
      if (result.accounts) rememberAccounts(result.accounts);
      if (!result.sources) await refresh(false);
      if (successNote) setNotice(successNote);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  const fetchSourceCatalog = async (source: ModelSource): Promise<void> => {
    if (!conn) return;
    const endpoint = source.endpoints[0];
    const credential = source.credentials[0];
    if (!endpoint || !credential) {
      setError("模型源缺少可用端点或凭据。");
      return;
    }
    setCatalogLoading(true);
    setError(null);
    try {
      const result = await conn.modelSourceAction({
        kind: "models",
        sourceId: source.id,
        revision: source.revision,
        protocol: endpoint.protocol,
        credentialId: credential.id,
        refresh: true,
      });
      setCatalogModels(result.models ?? []);
      setCatalogLoadedFor(source.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setCatalogLoading(false);
    }
  };

  const previewMigrations = async (): Promise<void> => {
    if (!conn) return;
    setBusyId("migration-preview");
    setError(null);
    try {
      const result = await conn.modelSourceAction({ kind: "migration.preview" });
      setMigrations(result.migrations ?? []);
      setDimension("sources");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  const openConfigureApi = (account: AgentAccount): void => {
    const profile = account.apiProfile;
    if (!profile && !account.apiProfileError) return;
    const current = accountApiProtocolFromProfile(
      account.agent,
      profile?.protocol,
    );
    const open = (protocol: AgentApiProtocol): void => {
      const defaults = protocol === current && profile
        ? { baseUrl: profile.baseUrl, model: profile.model }
        : account.apiProfileError ? { baseUrl: "", model: "" } : accountApiProtocolDefaults(protocol);
      setName(defaults.baseUrl);
      setEditor({
        kind: "api",
        agent: account.agent,
        account,
        phase: "baseUrl",
        draft: { name: account.name, protocol, ...defaults, ...(profile?.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}) },
      });
    };
    if (conn?.supportsAgentApiProtocols !== true) {
      open(current);
      return;
    }
    const protocols = accountApiProtocolsForAgent(account.agent, true);
    Alert.alert("选择 API 协议", "更换协议会同时切换默认地址和模型。", [
      ...protocols.map((protocol) => ({
        text: `${protocol === current ? "✓ " : ""}${accountApiProtocolLabel(protocol)}`,
        onPress: () => open(protocol),
      })),
      { text: "取消", style: "cancel" as const },
    ]);
  };

  const chooseCredential = (account: AgentAccount): void => {
    Alert.alert("导入 Claude 凭据", "选择这个独立环境使用的认证方式。", [
      { text: "取消", style: "cancel" },
      { text: "订阅账号令牌", onPress: () => openCredential(account, "oauth_token") },
      { text: "Console API Key", onPress: () => openCredential(account, "api_key") },
    ]);
  };

  const submitName = async (value: string): Promise<void> => {
    if (!conn || !editor) return;
    if (editor.kind === "create") {
      const result = await conn.createAgentAccount(editor.agent, value.trim());
      rememberAccounts(result.accounts);
    } else if (editor.kind === "rename") {
      const result = await conn.renameAgentAccount(editor.account.id, value.trim());
      rememberAccounts(result.accounts);
    } else if (editor.kind === "credential") {
      const result = await conn.setAgentAccountCredential(
        editor.account.id,
        editor.credentialKind,
        value.trim(),
      );
      rememberAccounts(result.accounts);
      setName("");
    } else if (editor.kind === "source-create") {
      const trimmed = value.trim();
      if (editor.phase === "name") {
        setName(editor.draft.baseUrl);
        setEditor({ ...editor, phase: "baseUrl", draft: { ...editor.draft, name: trimmed } });
        return;
      }
      if (editor.phase === "baseUrl") {
        setName("");
        setEditor({ ...editor, phase: "apiKey", draft: { ...editor.draft, baseUrl: trimmed } });
        return;
      }
      const result = await conn.modelSourceAction({
        kind: "create",
        name: editor.draft.name,
        endpoints: [{ protocol: editor.draft.protocol, baseUrl: editor.draft.baseUrl }],
        credential: { name: "默认 Key", apiKey: trimmed },
      });
      if (result.sources) {
        rememberSources(result.sources);
        const newest = result.sources.find((s) => s.name === editor.draft.name) ?? result.sources[0];
        if (newest) setSelectedSourceId(newest.id);
      }
      setNotice(`已添加 API 模型源「${editor.draft.name}」，可读取服务商目录或手动添加模型。`);
      setName("");
    } else if (editor.kind === "source-route") {
      const modelId = value.trim();
      const credentialId = editor.source.credentials[0]?.id;
      if (!credentialId) throw new Error("模型源缺少可用凭据");
      const result = await conn.modelSourceAction({
        kind: "routes.set",
        sourceId: editor.source.id,
        revision: editor.source.revision,
        routes: [
          {
            name: modelId.slice(0, 80),
            model: modelId,
            protocol: editor.protocol,
            credentialId,
            enabled: true,
          },
        ],
      });
      if (result.sources) rememberSources(result.sources);
      setNotice(`已添加并启用模型 ${modelId}`);
      setName("");
    } else if (editor.kind === "source-credential") {
      const result = await conn.modelSourceAction({
        kind: "credential.set",
        sourceId: editor.source.id,
        revision: editor.source.revision,
        ...(editor.credentialId ? { credentialId: editor.credentialId } : {}),
        name: editor.credentialName,
        apiKey: value.trim(),
      });
      if (result.sources) rememberSources(result.sources);
      setNotice("凭据已安全更新，已有会话仍保留原版本。");
      setName("");
    } else {
      const trimmedValue = value.trim();
      if (editor.phase === "name") {
        setName(editor.draft.baseUrl);
        setEditor({ ...editor, phase: "baseUrl", draft: { ...editor.draft, name: trimmedValue } });
        return;
      }
      if (editor.phase === "baseUrl") {
        setName(editor.draft.model);
        setEditor({ ...editor, phase: "model", draft: { ...editor.draft, baseUrl: trimmedValue } });
        return;
      }
      if (editor.phase === "model") {
        const nextPhase = conn.supportsAgentApiValidation ? "contextWindow" : "apiKey";
        setName(conn.supportsAgentApiValidation ? String(editor.draft.modelCapabilities?.contextWindow ?? "") : "");
        setEditor({ ...editor, phase: nextPhase, draft: { ...editor.draft, model: trimmedValue } });
        return;
      }
      if (editor.phase === "contextWindow" || editor.phase === "maxOutputTokens") {
        const modelCapabilities = updateModelTokenLimit(editor.draft.modelCapabilities, editor.phase, trimmedValue);
        setName(editor.phase === "contextWindow" ? String(modelCapabilities.maxOutputTokens ?? "") : "");
        setEditor({ ...editor, phase: editor.phase === "contextWindow" ? "maxOutputTokens" : "apiKey", draft: { ...editor.draft, modelCapabilities } });
        return;
      }
      const result = editor.account
        ? await conn.configureAgentApiProfile(
            editor.account.id,
            editor.draft.protocol,
            editor.draft.baseUrl,
            editor.draft.model,
            trimmedValue || undefined,
            JSON.stringify(editor.draft.modelCapabilities ?? {}) === JSON.stringify(editor.account.apiProfile?.modelCapabilities ?? {}) ? undefined : editor.draft.modelCapabilities && Object.keys(editor.draft.modelCapabilities).length ? editor.draft.modelCapabilities : null,
          )
        : await conn.createAgentApiProfile(
            editor.agent,
            editor.draft.name,
            editor.draft.protocol,
            editor.draft.baseUrl,
            editor.draft.model,
            trimmedValue,
            editor.draft.modelCapabilities,
          );
      rememberAccounts(result.accounts);
      setName("");
    }
    setEditor(null);
  };

  const login = async (account: AgentAccount): Promise<void> => {
    if (!conn || !hostId) return;
    setBusyId(account.id);
    setError(null);
    try {
      const result = await conn.loginAgentAccount(account.id);
      rememberAccounts(result.accounts);
      if (!result.sessionId) throw new Error("电脑端没有返回登录终端");
      router.push(`/host/${hostId}/session/${result.sessionId}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  const confirmLogout = (account: AgentAccount): void => {
    if (!conn) return;
    const api = account.apiProfile !== undefined;
    Alert.alert(api ? "移除 API Key" : "注销账号", api
      ? `移除 ${account.name} 的 API Key？该独立配置与会话历史会保留。`
      : `从 ${account.name} 的独立环境注销 ${agentTitle[account.agent]}？`, [
      { text: "取消", style: "cancel" },
      {
        text: api ? "移除" : "注销",
        style: "destructive",
        onPress: () => {
          void mutate(account.id, () => conn.logoutAgentAccount(account.id)).catch(() => {});
        },
      },
    ]);
  };

  const confirmDelete = (account: AgentAccount): void => {
    if (!conn) return;
    if (account.activeSessions > 0) {
      Alert.alert("暂时不能删除", `这个账号仍有 ${String(account.activeSessions)} 个活动会话，请先结束它们。`);
      return;
    }
    Alert.alert(
      "删除独立账号环境",
      `会注销 ${account.name}，并删除它的本机配置、会话历史和插件状态。工作区文件不会删除。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            void mutate(account.id, () => conn.deleteAgentAccount(account.id)).catch(() => {});
          },
        },
      ],
    );
  };

  const renderAccountCard = (account: AgentAccount) => {
    const busy = busyId !== null;
    const hasApiProfile = Boolean(account.apiProfile || account.apiProfileError);
    const sourceBound = Boolean(account.modelSource);
    const engine = getAgentAccountEngine(account);
    return (
      <View key={account.id} style={styles.card}>
        <View style={styles.cardTop}>
          <View style={styles.cardCopy}>
            <View style={styles.nameRow}>
              <AgentIcon agent={engine} size={17} />
              <Text style={styles.name}>{account.name}</Text>
              {account.isDefault && <Text style={styles.defaultBadge}>默认</Text>}
              {hasApiProfile && <Text style={styles.legacyBadge}>旧版 API</Text>}
            </View>
            <View style={styles.metaRow}>
              <View style={[styles.statusDot, { backgroundColor: statusColor[account.status] }]} />
              <Text style={styles.meta}>{hasApiProfile ? accountApiStatus(account) : statusText[account.status]}</Text>
              {account.authMethod && <Text style={styles.meta}>· {account.authMethod}</Text>}
            </View>
            {account.detail && !hasApiProfile && <Text style={styles.environment}>{account.detail}</Text>}
            <Text style={styles.environment}>
              {account.apiProfile
                ? `${engine} · ${accountApiProtocolLabel(accountApiProtocolFromProfile(account.agent, account.apiProfile.protocol))} · ${account.apiProfile.model}\n${account.apiProfile.baseUrl}`
                : account.apiProfileError
                  ? "API Profile · 等待修复"
                  : account.managed
                    ? "Prospero 独立订阅登录态"
                    : "本机订阅环境"}
              {account.activeSessions > 0 ? ` · ${String(account.activeSessions)} 个活动会话` : ""}
            </Text>
            {hasApiProfile && (
              <View style={styles.apiDetails}>
                {account.apiProfileError && <Text style={styles.error}>{account.apiProfileError}</Text>}
                <Text style={styles.environment}>API 协议 · {accountApiStatus(account)}</Text>
                {account.apiValidation && (
                  <>
                    <Text style={styles.environment}>
                      {(["runtime", "streaming", "tools"] as const)
                        .map(
                          (key) =>
                            `${key === "runtime" ? "运行环境" : key === "streaming" ? "流式响应" : "工具调用"}：${
                              account.apiValidation!.checks[key] === "passed"
                                ? "通过"
                                : account.apiValidation!.checks[key] === "failed"
                                  ? "失败"
                                  : "未测试"
                            }`,
                        )
                        .join(" · ")}
                    </Text>
                    <Text style={styles.environment}>
                      {account.apiValidation.detail}
                      {"\n"}
                      {new Date(account.apiValidation.checkedAt).toLocaleString()}
                    </Text>
                  </>
                )}
                {(conn?.supportsAgentApiEngineValidation || account.apiEngineValidation) && (
                  <Text
                    style={[
                      styles.environment,
                      account.apiEngineValidation?.status === "failed" && { color: color.danger },
                    ]}
                  >
                    {accountApiEngineStatus(account)}
                  </Text>
                )}
                {modelCapabilitySupportRows(account).map((row) => (
                  <Text key={row.key} style={styles.environment}>
                    {row.label}：{row.detail}
                  </Text>
                ))}
              </View>
            )}
            <AccountUsage
              account={account}
              usage={usageByAccount.get(account.id)}
              now={now}
            />
          </View>
          {busyId === account.id && <ActivityIndicator size="small" color={color.accent} />}
        </View>

        <View style={styles.actions}>
          {hasApiProfile ? (
            <>
              {conn?.supportsAgentApiValidation && (
                <Action
                  label="测试 API 连接"
                  disabled={busy || Boolean(account.apiProfileError) || account.status === "signed_out"}
                  onPress={() => {
                    if (conn) void mutate(account.id, () => conn.testAgentApiProfile(account.id)).catch(() => {});
                  }}
                />
              )}
              {conn?.supportsAgentApiEngineValidation && (
                <Action
                  label="验证 Agent 执行"
                  disabled={busy || Boolean(account.apiProfileError) || account.status === "signed_out"}
                  onPress={() => {
                    if (conn) void mutate(account.id, () => conn.testAgentApiProfile(account.id, "engine")).catch(() => {});
                  }}
                />
              )}
              <Action
                label={sourceBound ? "在模型源中修改" : account.activeSessions > 0 ? "结束会话后配置" : account.apiProfileError ? "修复配置" : "重新配置"}
                onPress={() => openConfigureApi(account)}
                disabled={busy || sourceBound || account.activeSessions > 0}
              />
              <Action
                label={sourceBound ? "模型源统一管理 Key" : account.activeSessions > 0 ? "结束会话后换 Key" : "替换 API Key"}
                onPress={() => openCredential(account, "api_key")}
                disabled={busy || sourceBound || account.activeSessions > 0 || Boolean(account.apiProfileError)}
              />
            </>
          ) : (
            <>
              <Action
                label={
                  account.agent === "claude" && account.managed
                    ? "生成令牌"
                    : account.status === "signed_in"
                      ? "重新登录"
                      : "登录"
                }
                onPress={() => void login(account)}
                disabled={busy}
              />
              {account.agent === "claude" && account.managed && (
                <Action label="导入凭据" onPress={() => chooseCredential(account)} disabled={busy} />
              )}
            </>
          )}
          {!account.isDefault && (
            <Action
              label="设为默认"
              onPress={() => {
                if (conn) void mutate(account.id, () => conn.setDefaultAgentAccount(account.id)).catch(() => {});
              }}
              disabled={busy}
            />
          )}
          {account.managed && <Action label="重命名" onPress={() => openRename(account)} disabled={busy} />}
          {account.status === "signed_in" && (
            <Action
              label={sourceBound ? "由模型源管理" : account.apiProfile && account.activeSessions > 0 ? "结束会话后移除密钥" : account.apiProfile ? "移除密钥" : "注销"}
              onPress={() => confirmLogout(account)}
              disabled={busy || sourceBound || Boolean(account.apiProfile && account.activeSessions > 0)}
              danger
            />
          )}
          {account.managed && (
            <Action
              label={sourceBound ? "模型源绑定" : account.activeSessions > 0 ? "结束会话后删除" : "删除"}
              onPress={() => confirmDelete(account)}
              disabled={busy || sourceBound || account.activeSessions > 0}
              danger
            />
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "账号与模型源",
          headerRight: () => (
            <Pressable onPress={() => void refresh(true)} hitSlop={10} accessibilityLabel="刷新账号与模型源">
              <Icon name="arrow.clockwise" size={17} color={color.accent} />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh(true)} tintColor={color.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.explainer}>
          <Text style={styles.explainerTitle}>官方订阅登录态与 API 模型源分开管理</Text>
          <Text style={styles.explainerText}>
            分开维护「多份官方 CLI 订阅登录态」与「第三方 / 自建共享模型源」；新建会话时可在两者间一键切换，共享同一工作区。
          </Text>
          <View style={styles.dimensionSwitch} accessibilityRole="tablist" accessibilityLabel="管理维度">
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: dimension === "subscriptions" }}
              onPress={() => setDimension("subscriptions")}
              style={[styles.dimensionTab, dimension === "subscriptions" && styles.dimensionTabActive]}
            >
              <Text style={[styles.dimensionTabText, dimension === "subscriptions" && styles.dimensionTabTextActive]}>
                订阅管理 ({String(subscriptionAccounts.length)})
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: dimension === "sources" }}
              onPress={() => setDimension("sources")}
              style={[styles.dimensionTab, dimension === "sources" && styles.dimensionTabActive]}
            >
              <Text style={[styles.dimensionTabText, dimension === "sources" && styles.dimensionTabTextActive]}>
                API 模型源 ({String(sources.length)})
              </Text>
            </Pressable>
          </View>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
        {notice && <Text style={styles.notice}>{notice}</Text>}
        {loading && accounts.length === 0 && sources.length === 0 && (
          <ActivityIndicator color={color.accent} style={styles.loader} />
        )}

        {dimension === "subscriptions" ? (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
            >
              <FilterPill
                label={`全部订阅 (${String(subscriptionAccounts.length)})`}
                active={providerFilter === "all"}
                onPress={() => setProviderFilter("all")}
              />
              <FilterPill
                label={`Codex (${String(countByEngine.codex)})`}
                active={providerFilter === "codex"}
                onPress={() => setProviderFilter("codex")}
              />
              <FilterPill
                label={`Claude (${String(countByEngine.claude)})`}
                active={providerFilter === "claude"}
                onPress={() => setProviderFilter("claude")}
              />
              {countByEngine.agy > 0 && (
                <FilterPill
                  label={`Antigravity (${String(countByEngine.agy)})`}
                  active={providerFilter === "agy"}
                  onPress={() => setProviderFilter("agy")}
                />
              )}
              {countByEngine.pi > 0 && (
                <FilterPill
                  label={`Pi (${String(countByEngine.pi)})`}
                  active={providerFilter === "pi"}
                  onPress={() => setProviderFilter("pi")}
                />
              )}
              {legacyApiAccounts.length > 0 && (
                <FilterPill
                  label={`旧版独立 API (${String(legacyApiAccounts.length)})`}
                  active={showLegacyApi}
                  onPress={() => setShowLegacyApi((current) => !current)}
                />
              )}
            </ScrollView>

            {legacyApiAccounts.length > 0 && conn?.supportsModelSources && (
              <View style={styles.migrationBanner}>
                <Text style={styles.migrationText}>
                  检测到 {String(legacyApiAccounts.length)} 个旧版独立 API Profile。所有第三方 API 现已统一在「API 模型源」中管理，可一键归并。
                </Text>
                <Pressable
                  style={({ pressed }) => [styles.migrationBtn, pressed && styles.pressed]}
                  disabled={busyId !== null}
                  onPress={() => void previewMigrations()}
                >
                  <Text style={styles.migrationBtnText}>前往 API 模型源整理</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.createBar}>
              <Text style={styles.sectionTitle}>新增订阅登录态</Text>
              <View style={styles.addActions}>
                {(["codex", "claude", "pi"] as const).map((agent) => (
                  <Pressable
                    key={agent}
                    style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
                    onPress={() => openCreate(agent)}
                    disabled={!conn?.supportsAgentAccounts}
                  >
                    <Icon name="plus" size={13} color={color.accent} />
                    <Text style={styles.addButtonText}>{agentTitle[agent]}</Text>
                  </Pressable>
                ))}
                {!conn?.supportsModelSources && conn?.supportsAgentApiProfiles && (
                  <Pressable
                    style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
                    onPress={() => openCreateApi("codex")}
                  >
                    <Icon name="plus" size={13} color={color.accent} />
                    <Text style={styles.addButtonText}>新增 API</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <View style={styles.section}>
              {displayedAccounts.map(renderAccountCard)}
              {displayedAccounts.length === 0 && (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyCardText}>
                    当前筛选下没有订阅账号，可在上方创建隔离的官方 CLI 订阅登录态，或切换到「API 模型源」。
                  </Text>
                </View>
              )}
            </View>

            {conn?.supportsDeepseekHarness && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionIdentity}>
                    <AgentIcon agent="deepseek" size={20} />
                    <Text style={styles.sectionTitle}>DeepSeek Harness</Text>
                  </View>
                </View>
                <View style={styles.card}>
                  <View style={styles.cardTop}>
                    <View style={styles.cardCopy}>
                      <Text style={styles.name}>本机 Harness</Text>
                      <View style={styles.metaRow}>
                        <View style={[styles.statusDot, { backgroundColor: color.success }]} />
                        <Text style={styles.meta}>已接入</Text>
                      </View>
                      <Text style={styles.environment}>
                        模型与 API Key 由 DeepSeek Harness（dsh）管理
                      </Text>
                    </View>
                  </View>
                </View>
              </View>
            )}
          </>
        ) : (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>共享模型源 · API 模型源</Text>
              <View style={styles.addActions}>
                {legacyApiAccounts.length > 0 && conn?.supportsModelSources && (
                  <Pressable
                    style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
                    disabled={busyId !== null}
                    onPress={() => void previewMigrations()}
                  >
                    <Text style={styles.addButtonText}>整理旧版 API</Text>
                  </Pressable>
                )}
                {conn?.supportsModelSources && (
                  <Pressable
                    style={({ pressed }) => [styles.addButtonPrimary, pressed && styles.pressed]}
                    disabled={busyId !== null}
                    onPress={openCreateModelSource}
                  >
                    <Icon name="plus" size={13} color={color.bg} />
                    <Text style={styles.addButtonPrimaryText}>添加模型源</Text>
                  </Pressable>
                )}
              </View>
            </View>

            {!conn?.supportsCapability(CAPABILITY_MODEL_SOURCES) && (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyCardText}>
                  升级并重启电脑端 Prospero daemon 后即可管理共享 API 模型源。
                </Text>
              </View>
            )}

            {migrations && migrations.length > 0 && (
              <View style={styles.sourcePanel}>
                <Text style={styles.sourceTitle}>整理已有独立 API Profile</Text>
                {migrations.map((group) => (
                  <View key={group.id} style={styles.sourceRow}>
                    <View style={styles.sourceCopy}>
                      <Text style={styles.sourceName}>
                        {group.name} · {accountApiProtocolLabel(group.protocol)}
                      </Text>
                      <Text style={styles.sourceMeta}>
                        {group.baseUrl} · {String(group.accounts.length)} 个 Profile
                      </Text>
                    </View>
                    <Pressable
                      style={({ pressed }) => [styles.sourceButton, pressed && styles.pressed]}
                      disabled={busyId !== null}
                      onPress={() =>
                        void runSourceMutation(
                          `migrate:${group.id}`,
                          () =>
                            conn!.modelSourceAction({
                              kind: "migration.apply",
                              migrationId: group.id,
                              name: group.name,
                            }),
                          `已归并至模型源「${group.name}」`,
                        ).then(() =>
                          setMigrations((current) =>
                            current ? current.filter((item) => item.id !== group.id) : null,
                          ),
                        )
                      }
                    >
                      <Text style={styles.sourceButtonText}>归并</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            {conn?.supportsCapability(CAPABILITY_MODEL_SOURCES) && sources.length === 0 && (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyCardText}>
                  电脑端暂无已配置的 API 模型源。同一服务地址只需配置一次，即可批量启用多个模型供 Codex、Claude、OpenCode 与 Pi 共享。
                </Text>
              </View>
            )}

            {sources.length > 0 && (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.filterRow}
                >
                  {sources.map((source) => {
                    const enabledCount = source.routes.filter((r) => r.enabled).length;
                    const active = activeSource?.id === source.id;
                    return (
                      <FilterPill
                        key={source.id}
                        label={`${source.name} (${String(enabledCount)})${source.enabled ? "" : " · 已停用"}`}
                        active={active}
                        onPress={() => {
                          setSelectedSourceId(source.id);
                          setRouteFilter("");
                          setCatalogModels([]);
                          setCatalogLoadedFor(null);
                        }}
                      />
                    );
                  })}
                </ScrollView>

                {activeSource && (
                  <View style={styles.card}>
                    <View style={styles.sectionHeader}>
                      <View style={styles.cardCopy}>
                        <Text style={styles.name}>{activeSource.name}</Text>
                        <Text style={styles.meta}>
                          连接版本 v{String(activeSource.revision)} ·{" "}
                          {activeSource.enabled ? "允许新会话" : "已停用新会话"}
                        </Text>
                      </View>
                      <Action
                        label={activeSource.enabled ? "停用新会话" : "启用"}
                        disabled={busyId !== null}
                        onPress={() =>
                          void runSourceMutation(
                            `toggle-source:${activeSource.id}`,
                            () =>
                              conn!.modelSourceAction({
                                kind: "update",
                                sourceId: activeSource.id,
                                revision: activeSource.revision,
                                enabled: !activeSource.enabled,
                              }),
                            activeSource.enabled ? "已停用新会话" : "已启用模型源",
                          )
                        }
                      />
                    </View>

                    <View style={styles.endpointList}>
                      {activeSource.endpoints.map((endpoint) => (
                        <View key={endpoint.protocol} style={styles.endpointItem}>
                          <Text style={styles.endpointBadge}>
                            {accountApiProtocolLabel(endpoint.protocol)}
                          </Text>
                          <Text style={styles.environment} numberOfLines={1} ellipsizeMode="middle">
                            {endpoint.baseUrl}
                          </Text>
                        </View>
                      ))}
                    </View>

                    <View style={styles.credentialBox}>
                      <View style={styles.sectionHeader}>
                        <Text style={styles.subHeading}>共享凭据</Text>
                        <Pressable
                          disabled={busyId !== null}
                          onPress={() => {
                            setName("");
                            setEditor({
                              kind: "source-credential",
                              source: activeSource,
                              credentialName: `凭据 ${String(activeSource.credentials.length + 1)}`,
                            });
                          }}
                        >
                          <Text style={styles.linkText}>+ 添加凭据</Text>
                        </Pressable>
                      </View>
                      {activeSource.credentials.map((cred) => (
                        <View key={cred.id} style={styles.sourceRow}>
                          <Text style={styles.sourceName}>
                            {cred.name} · v{String(cred.revision)}
                          </Text>
                          <Pressable
                            disabled={busyId !== null}
                            onPress={() => {
                              setName("");
                              setEditor({
                                kind: "source-credential",
                                source: activeSource,
                                credentialId: cred.id,
                                credentialName: cred.name,
                              });
                            }}
                          >
                            <Text style={styles.linkText}>轮换 Key</Text>
                          </Pressable>
                        </View>
                      ))}
                    </View>

                    <View style={styles.sectionHeader}>
                      <Text style={styles.subHeading}>
                        已配置模型 ({String(activeSource.routes.length)})
                      </Text>
                      {activeSource.endpoints[0] && (
                        <Pressable
                          disabled={busyId !== null || activeSource.credentials.length === 0}
                          onPress={() => {
                            setName("");
                            setEditor({
                              kind: "source-route",
                              source: activeSource,
                              protocol: activeSource.endpoints[0]!.protocol,
                            });
                          }}
                        >
                          <Text style={styles.linkText}>+ 手动添加模型</Text>
                        </Pressable>
                      )}
                    </View>

                    {activeSource.routes.length > 3 && (
                      <TextInput
                        value={routeFilter}
                        onChangeText={setRouteFilter}
                        placeholder="搜索已配置模型名称或 ID"
                        placeholderTextColor={color.textFaint}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.searchField}
                      />
                    )}

                    {filteredRoutes.map((route) => {
                      const targetAgent: CodeAgentKind =
                        route.protocol === "anthropic" ? "claude" : "codex";
                      const isDefault = activeSource.defaultRouteId === route.id;
                      const routeBusy = busyId === `source:${activeSource.id}:${route.id}`;
                      return (
                        <View key={route.id} style={styles.routeCard}>
                          <View style={styles.routeTop}>
                            <View style={styles.sourceCopy}>
                              <View style={styles.nameRow}>
                                <Text style={styles.sourceName}>{sourceRouteLabel(route)}</Text>
                                {isDefault && <Text style={styles.defaultBadge}>默认</Text>}
                                {!route.enabled && <Text style={styles.legacyBadge}>已停用</Text>}
                              </View>
                              <Text style={styles.sourceMeta}>
                                {route.model} ·{" "}
                                {activeSource.credentials.find((c) => c.id === route.credentialId)?.name ??
                                  "凭据"}
                              </Text>
                            </View>
                            {routeBusy && <ActivityIndicator size="small" color={color.accent} />}
                          </View>
                          <View style={styles.actions}>
                            <Action
                              label="新建会话"
                              disabled={
                                busyId !== null ||
                                !activeSource.enabled ||
                                !route.enabled ||
                                route.modelCapabilities?.tools === false
                              }
                              onPress={() => void bindModelSource(targetAgent, activeSource, route, true)}
                            />
                            {!isDefault && route.enabled && (
                              <Action
                                label="设为默认"
                                disabled={busyId !== null}
                                onPress={() =>
                                  void runSourceMutation(
                                    `default:${route.id}`,
                                    () =>
                                      conn!.modelSourceAction({
                                        kind: "update",
                                        sourceId: activeSource.id,
                                        revision: activeSource.revision,
                                        defaultRouteId: route.id,
                                      }),
                                    `已将 ${route.name} 设为默认模型`,
                                  )
                                }
                              />
                            )}
                            <Action
                              label={route.enabled ? "停用" : "启用"}
                              disabled={busyId !== null}
                              onPress={() =>
                                void runSourceMutation(
                                  `toggle-route:${route.id}`,
                                  () =>
                                    conn!.modelSourceAction({
                                      kind: "routes.set",
                                      sourceId: activeSource.id,
                                      revision: activeSource.revision,
                                      routes: [{ ...route, enabled: !route.enabled }],
                                    }),
                                )
                              }
                            />
                          </View>
                        </View>
                      );
                    })}

                    {filteredRoutes.length === 0 && (
                      <Text style={styles.environment}>
                        没有匹配的模型，可手动添加或从下方服务商目录启用。
                      </Text>
                    )}

                    <View style={styles.catalogBox}>
                      <View style={styles.sectionHeader}>
                        <Text style={styles.subHeading}>从服务商读取模型目录</Text>
                        <Pressable
                          disabled={catalogLoading || busyId !== null}
                          onPress={() => void fetchSourceCatalog(activeSource)}
                        >
                          <Text style={styles.linkText}>
                            {catalogLoading ? "读取中…" : "↻ 读取目录"}
                          </Text>
                        </Pressable>
                      </View>
                      {catalogLoadedFor === activeSource.id && (
                        <>
                          <TextInput
                            value={catalogQuery}
                            onChangeText={setCatalogQuery}
                            placeholder="筛选目录模型 ID 或名称"
                            placeholderTextColor={color.textFaint}
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={styles.searchField}
                          />
                          {catalogModels
                            .filter((m) =>
                              `${m.id} ${m.label ?? ""}`
                                .toLowerCase()
                                .includes(catalogQuery.trim().toLowerCase()),
                            )
                            .slice(0, 40)
                            .map((model) => {
                              const protocol = activeSource.endpoints[0]!.protocol;
                              const credentialId = activeSource.credentials[0]?.id ?? "";
                              const alreadyEnabled = activeSource.routes.some(
                                (r) => r.model === model.id && r.protocol === protocol && r.enabled,
                              );
                              return (
                                <View key={model.id} style={styles.sourceRow}>
                                  <View style={styles.sourceCopy}>
                                    <Text style={styles.sourceName}>{model.label || model.id}</Text>
                                    <Text style={styles.sourceMeta}>{model.id}</Text>
                                  </View>
                                  <Pressable
                                    disabled={alreadyEnabled || busyId !== null || !credentialId}
                                    style={({ pressed }) => [
                                      styles.sourceButton,
                                      alreadyEnabled && styles.disabled,
                                      pressed && styles.pressed,
                                    ]}
                                    onPress={() =>
                                      void runSourceMutation(
                                        `enable:${model.id}`,
                                        () =>
                                          conn!.modelSourceAction({
                                            kind: "routes.set",
                                            sourceId: activeSource.id,
                                            revision: activeSource.revision,
                                            routes: [catalogRouteInput(model, protocol, credentialId)],
                                          }),
                                        `已启用模型 ${model.label || model.id}`,
                                      )
                                    }
                                  >
                                    <Text style={styles.sourceButtonText}>
                                      {alreadyEnabled ? "已启用" : "启用"}
                                    </Text>
                                  </Pressable>
                                </View>
                              );
                            })}
                        </>
                      )}
                    </View>
                  </View>
                )}
              </>
            )}
          </View>
        )}
      </ScrollView>

      <PromptDialog
        visible={editor !== null}
        title={
          editor?.kind === "rename"
            ? "重命名账号"
            : editor?.kind === "source-create"
              ? editor.phase === "name"
                ? `新增 ${accountApiProtocolLabel(editor.draft.protocol)} 模型源`
                : editor.phase === "baseUrl"
                  ? "模型源 API 地址"
                  : "共享 API Key"
              : editor?.kind === "source-route"
                ? "手动添加模型"
                : editor?.kind === "source-credential"
                  ? editor.credentialId
                    ? `轮换凭据 · ${editor.credentialName}`
                    : "添加共享凭据"
                  : editor?.kind === "credential"
                    ? editor.account.apiProfile
                      ? "保存 API Key"
                      : editor.credentialKind === "oauth_token"
                        ? "导入订阅账号令牌"
                        : "导入 Anthropic API Key"
                    : editor?.kind === "api"
                      ? editor.phase === "name"
                        ? `新增 ${accountApiProtocolLabel(editor.draft.protocol)} 配置`
                        : editor.phase === "baseUrl"
                          ? "API Base URL"
                          : editor.phase === "model"
                            ? "默认模型"
                            : editor.phase === "contextWindow"
                              ? "上下文窗口（可选）"
                              : editor.phase === "maxOutputTokens"
                                ? "最大输出（可选）"
                                : editor.account && conn?.supportsAgentApiProtocols
                                  ? "API Key（可选）"
                                  : "保存 API Key"
                      : `新增 ${editor && editor.kind === "create" ? agentTitle[editor.agent] : ""} 订阅登录态`
        }
        message={
          editor?.kind === "create"
            ? editor.agent === "claude"
              ? "创建后先生成令牌，再把令牌导入电脑端的独立安全存储。"
              : "创建后会得到独立环境，下一步在官方 CLI 终端完成登录。"
            : editor?.kind === "source-create"
              ? editor.phase === "name"
                ? "为这个 API 模型源起一个清晰名称（例如 OpenRouter / 公司网关）。"
                : editor.phase === "baseUrl"
                  ? editor.draft.protocol === "anthropic"
                    ? "输入 API 根地址，例如 https://api.anthropic.com，不要包含 /v1/messages。"
                    : "输入 API 前缀，例如 https://gateway.example.com/v1。"
                  : "API Key 经配对加密通道写入电脑安全存储。"
              : editor?.kind === "source-route"
                ? `输入 ${editor.source.name} 中要启用的精确模型 ID。`
                : editor?.kind === "source-credential"
                  ? "粘贴新的 API Key，写入电脑端安全存储。"
                  : editor?.kind === "credential"
                    ? editor.account.apiProfile
                      ? "粘贴此独立 API Profile 的新 Key。原有 Key 不会显示或回传。"
                      : editor.credentialKind === "oauth_token"
                        ? "先点“生成令牌”完成 claude setup-token，再粘贴终端最后显示的令牌。"
                        : "粘贴该账号自己的 Anthropic Console API Key。"
                    : editor?.kind === "api"
                      ? editor.phase === "name"
                        ? `${accountApiProtocolLabel(editor.draft.protocol)} 兼容服务将只供这个独立环境使用。`
                        : editor.phase === "baseUrl"
                          ? editor.draft.protocol === "anthropic"
                            ? "输入 API 根地址，例如 https://api.anthropic.com，不要包含 /v1/messages。"
                            : `输入 API 前缀，例如 https://gateway.example.com/v1，不要包含 ${editor.draft.protocol === "openai_responses" ? "/responses" : "/chat/completions"}。`
                          : editor.phase === "model"
                            ? "输入该服务中要作为默认模型使用的精确模型 ID。"
                            : editor.phase === "contextWindow" || editor.phase === "maxOutputTokens"
                              ? `按服务商文档填写 Token 正整数上限；未知可留空。${editor.draft.protocol === "openai_chat_completions" ? "Chat Completions 的两个上限须同时填写或同时留空。" : ""}其他已保存的模型能力保持原值。`
                              : editor.account && conn?.supportsAgentApiProtocols
                                ? "留空会保留现有 Key；新 Key 仅写入电脑端安全存储。"
                                : "Key 仅写入电脑端安全存储，不会保存在账号配置或聊天记录中。"
                      : undefined
        }
        value={name}
        confirmLabel={
          editor?.kind === "api" && editor.phase === "apiKey" && editor.account && conn?.supportsAgentApiProtocols
            ? "保存配置"
            : editor?.kind === "credential" ||
                (editor?.kind === "api" && editor.phase === "apiKey") ||
                (editor?.kind === "source-create" && editor.phase === "apiKey") ||
                editor?.kind === "source-credential"
              ? "安全保存"
              : editor?.kind === "rename"
                ? "保存"
                : editor?.kind === "api" || editor?.kind === "source-create"
                  ? "下一步"
                  : "创建"
        }
        secureTextEntry={
          editor?.kind === "credential" ||
          (editor?.kind === "api" && editor.phase === "apiKey") ||
          (editor?.kind === "source-create" && editor.phase === "apiKey") ||
          editor?.kind === "source-credential"
        }
        onChangeText={setName}
        onCancel={() => {
          setName("");
          setEditor(null);
        }}
        onSubmit={submitName}
        validate={(value) => {
          const trimmed = value.trim();
          const optionalApiKey = editor?.kind === "api" && editor.phase === "apiKey" && editor.account !== undefined && conn?.supportsAgentApiProtocols === true;
          const optionalLimit = editor?.kind === "api" && (editor.phase === "contextWindow" || editor.phase === "maxOutputTokens");
          if (!trimmed && !optionalApiKey && !optionalLimit) {
            return editor?.kind === "credential" ||
              (editor?.kind === "api" && editor.phase === "apiKey") ||
              (editor?.kind === "source-create" && editor.phase === "apiKey") ||
              editor?.kind === "source-credential"
              ? "请粘贴凭据"
              : "请输入内容";
          }
          if (editor?.kind === "source-create") {
            if (editor.phase === "name" && trimmed.length > 80) return "名称不能超过 80 个字符";
            if (editor.phase === "baseUrl" && (trimmed.length > 2000 || !/^https?:\/\//i.test(trimmed) || /[\r\n\0]/.test(trimmed))) {
              return "请输入完整的 http(s):// API 地址";
            }
            if (editor.phase === "apiKey" && (trimmed.length > 8192 || /[\r\n\0]/.test(trimmed))) {
              return "凭据格式不正确";
            }
            return null;
          }
          if (editor?.kind === "source-route") {
            if (trimmed.length > 300 || /[\r\n\0]/.test(trimmed)) return "模型 ID 格式不正确";
            return null;
          }
          if (editor?.kind === "source-credential") {
            if (trimmed.length > 8192 || /[\r\n\0]/.test(trimmed)) return "凭据格式不正确";
            return null;
          }
          if (editor?.kind === "api") {
            if (editor.phase === "contextWindow" || editor.phase === "maxOutputTokens") {
              try {
                const limit = modelTokenLimit(trimmed);
                if (editor.phase === "maxOutputTokens" && editor.draft.protocol === "openai_chat_completions" && (limit === undefined) !== (editor.draft.modelCapabilities?.contextWindow === undefined)) return "Chat Completions 的两个 Token 上限须同时填写或同时留空";
                if (editor.phase === "maxOutputTokens" && limit !== undefined && editor.draft.modelCapabilities?.contextWindow !== undefined && limit > editor.draft.modelCapabilities.contextWindow) return "输出上限不能大于上下文窗口";
              } catch (error) { return error instanceof Error ? error.message : String(error); }
              return null;
            }
            if (editor.phase === "name" && trimmed.length > 80) return "名称不能超过 80 个字符";
            if (editor.phase === "baseUrl" && (trimmed.length > 2000 || /[\r\n\0]/.test(trimmed))) return "API 地址格式不正确";
            if (editor.phase === "model" && (trimmed.length > 300 || /[\r\n\0]/.test(trimmed))) return "模型名称格式不正确";
            if (editor.phase === "apiKey" && (trimmed.length > 8192 || /[\r\n\0]/.test(trimmed))) return "凭据格式不正确";
            return null;
          }
          if (editor?.kind === "credential") {
            if (trimmed.length < (editor.account.apiProfile ? 1 : 20)) return "凭据长度不正确";
            if (trimmed.length > 8192 || /[\r\n\0]/.test(trimmed)) return "凭据格式不正确";
            return null;
          }
          if (trimmed.length > 80) return "名称不能超过 80 个字符";
          return null;
        }}
      />
    </View>
  );
}

function FilterPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.filterPill, active && styles.filterPillActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.filterPillText, active && styles.filterPillTextActive]}>{label}</Text>
    </Pressable>
  );
}

function tightestWindow(usage: UsageAccount | undefined): UsageAccount["windows"][number] | null {
  return usage?.windows.reduce<UsageAccount["windows"][number] | null>(
    (best, window) => best === null || window.utilization > best.utilization ? window : best,
    null,
  ) ?? null;
}

function sourceLabel(account: AgentAccount, usage: UsageAccount | undefined): string {
  if (account.apiProfile || usage?.source === "api" || /api/i.test(account.authMethod ?? "")) {
    return "API 模型";
  }
  if (usage?.subscription) return `${usage.subscription} 订阅`;
  if (/chatgpt/i.test(account.authMethod ?? "")) return "ChatGPT 订阅";
  return account.status === "signed_in" ? "官方订阅账号" : "来源待登录";
}

function AccountUsage({
  account,
  usage,
  now,
}: {
  account: AgentAccount;
  usage: UsageAccount | undefined;
  now: number;
}) {
  const window = tightestWindow(usage);
  const api = account.apiProfile !== undefined || usage?.source === "api";
  const remaining = window ? quotaRemainingPct(window.utilization) : null;
  return (
    <View style={styles.usageBox}>
      <View style={styles.usageHead}>
        <Text style={styles.sourceBadge}>{sourceLabel(account, usage)}</Text>
        <Text style={[styles.usageValue, remaining !== null && { color: quotaRemainingColor(remaining) }]}>
          {remaining !== null
            ? `${window?.label ?? "额度"}剩余 ${String(remaining)}%`
            : api
              ? "由 API 服务商计费"
              : usage?.reason ?? "额度暂不可用"}
        </Text>
      </View>
      {window && (
        <>
          <View style={styles.usageTrack}>
            <View
              style={[
                styles.usageFill,
                {
                  width: `${remaining ?? 0}%` as const,
                  backgroundColor: quotaRemainingColor(remaining ?? 0),
                },
              ]}
            />
          </View>
          {window.resetsAt && (
            <Text style={styles.resetText}>{untilLabel(window.resetsAt, now)}</Text>
          )}
        </>
      )}
    </View>
  );
}

function Action({
  label,
  onPress,
  disabled,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.actionText, danger && styles.dangerText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.lg, paddingBottom: 48, gap: space.md },
  explainer: {
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    gap: space.sm,
  },
  explainerTitle: { ...font.body, fontWeight: "700" },
  explainerText: { ...font.sub, lineHeight: 19 },
  dimensionSwitch: {
    marginTop: 4,
    flexDirection: "row",
    gap: 4,
    padding: 3,
    borderRadius: 12,
    backgroundColor: color.surfaceRaised,
  },
  dimensionTab: {
    flex: 1,
    minHeight: 38,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  dimensionTabActive: { backgroundColor: color.surface },
  dimensionTabText: { color: color.textDim, fontSize: 13, fontWeight: "600" },
  dimensionTabTextActive: { color: color.text, fontWeight: "700" },
  filterRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  filterPill: {
    minHeight: 34,
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: "center",
    justifyContent: "center",
  },
  filterPillActive: { backgroundColor: color.text, borderColor: color.text },
  filterPillText: { color: color.textDim, fontSize: 12.5, fontWeight: "600" },
  filterPillTextActive: { color: color.bg },
  migrationBanner: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.warnBg,
    gap: space.sm,
  },
  migrationText: { color: color.warn, fontSize: 12.5, lineHeight: 18 },
  migrationBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
  },
  migrationBtnText: { color: color.text, fontSize: 12, fontWeight: "700" },
  createBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space.sm,
  },
  error: { ...font.sub, color: color.danger, paddingHorizontal: space.xs },
  notice: { ...font.sub, color: color.success, paddingHorizontal: space.xs },
  loader: { paddingVertical: space.xl },
  section: { gap: space.sm },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  sectionIdentity: { flexDirection: "row", alignItems: "center", gap: space.sm },
  addActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  sectionTitle: { ...font.body, fontWeight: "700" },
  subHeading: { ...font.meta, color: color.text, fontSize: 13, fontWeight: "700" },
  linkText: { color: color.accent, fontSize: 12.5, fontWeight: "600" },
  addButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  addButtonText: { color: color.text, fontSize: 12, fontWeight: "600" },
  addButtonPrimary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: color.text,
  },
  addButtonPrimaryText: { color: color.bg, fontSize: 12, fontWeight: "700" },
  sourcePanel: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  sourceTitle: { ...font.meta, color: color.accent, fontWeight: "700" },
  sourceRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingVertical: 4 },
  sourceCopy: { flex: 1, minWidth: 0, gap: 2 },
  sourceName: { ...font.meta, color: color.text, fontSize: 13, fontWeight: "700" },
  sourceMeta: { ...font.meta, color: color.textDim },
  sourceButton: {
    minHeight: 34,
    minWidth: 56,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: color.accentBg,
  },
  sourceButtonText: { color: color.accent, fontSize: 12, fontWeight: "700" },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.md,
    gap: space.md,
  },
  emptyCard: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
  },
  emptyCardText: { ...font.sub, color: color.textDim, lineHeight: 19 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cardCopy: { flex: 1, minWidth: 0, gap: 5 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  name: { ...font.body, fontWeight: "700", flexShrink: 1 },
  defaultBadge: {
    color: color.accent,
    backgroundColor: color.accentBg,
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
  },
  legacyBadge: {
    color: color.warn,
    backgroundColor: color.warnBg,
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
  },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  meta: { ...font.meta, color: color.textDim },
  environment: { ...font.meta, lineHeight: 16 },
  apiDetails: { gap: 3 },
  endpointList: { gap: 6 },
  endpointItem: {
    padding: 9,
    borderRadius: 10,
    backgroundColor: color.surfaceRaised,
    gap: 3,
  },
  endpointBadge: { color: color.textDim, fontSize: 11, fontWeight: "700" },
  credentialBox: {
    padding: 10,
    borderRadius: 10,
    backgroundColor: color.surfaceRaised,
    gap: 6,
  },
  searchField: {
    minHeight: 40,
    paddingHorizontal: 11,
    borderRadius: 10,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    color: color.text,
    fontSize: 13,
  },
  routeCard: {
    padding: 10,
    borderRadius: 10,
    backgroundColor: color.surfaceRaised,
    gap: 8,
  },
  routeTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  catalogBox: {
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    gap: 8,
  },
  usageBox: { marginTop: 3, gap: 5 },
  usageHead: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  sourceBadge: {
    ...font.meta,
    color: color.accent,
    backgroundColor: color.accentBg,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  usageValue: { ...font.meta, color: color.textDim, flexShrink: 1 },
  usageTrack: { height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: color.surfaceRaised },
  usageFill: { height: "100%", borderRadius: 2 },
  resetText: { ...font.meta, color: color.textFaint },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  action: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.sm, backgroundColor: color.surfaceRaised },
  actionText: { color: color.textDim, fontSize: 12, fontWeight: "600" },
  dangerText: { color: color.danger },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
