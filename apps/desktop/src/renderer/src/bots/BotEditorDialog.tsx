import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Cpu,
  MessageSquare,
  PlugZap,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { AgyModelPicker, formatAgyEffortLabel } from "../workspace/AgyModelPicker";
import {
  defaultSessionLaunchAccountId,
  sessionLaunchAccounts,
} from "../../../shared/session-launch-options";
import type {
  AgentModel,
  BotFeishuAdmin,
  BotFeishuProbeResult,
  BotSourceBinding,
  BotUpsertInput,
  DesktopSnapshot,
  FeishuAccessPolicy,
  FeishuDomain,
  FeishuGroupTrigger,
  PublicBot,
} from "../../../shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLocale } from "../locale";
import { SourceSelector } from "../model-sources/SourceSelector";
import {
  selectedSourceRoute,
  type SourceRuntimeAgent,
  type SourceSelection,
} from "../model-sources/source-state";
import { runModelSourceAction, useModelSources } from "../model-sources/use-model-sources";
import { displayError } from "../state";
import { FeishuAccessControlPanel } from "./FeishuAccessControlPanel";
import { runBotAction } from "./use-bots";

type BotAgent = "codex" | "claude" | "agy" | "deepseek" | "opencode" | "pi";
export type BotEditorSection = "persona" | "model" | "feishu" | "access";

const BOT_AGENTS: ReadonlyArray<{ id: BotAgent; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "agy", label: "Antigravity (AGY)" },
  { id: "deepseek", label: "DeepSeek Harness" },
  { id: "pi", label: "Pi" },
  { id: "opencode", label: "OpenCode" },
];

const AVATAR_PRESETS = ["⚡", "🤖", "🔍", "🛠️", "📊", "💬", "🧠", "🚀"];

const ROLE_PRESETS: ReadonlyArray<{
  id: string;
  labelZh: string;
  labelEn: string;
  avatar: string;
  descZh: string;
  descEn: string;
  promptZh: string;
  promptEn: string;
  multiBot: boolean;
}> = [
  {
    id: "research",
    labelZh: "深度调研",
    labelEn: "Researcher",
    avatar: "🔍",
    descZh: "信息搜集、技术对比与结构化简报",
    descEn: "Information synthesis, comparisons, and structured briefs",
    promptZh: "你是一位严谨的研究分析助理。回答先给核心结论与行动建议，再附关键依据、边界条件与风险提示。",
    promptEn: "You are a rigorous research assistant. Lead with key conclusions and recommendations, followed by evidence and caveats.",
    multiBot: false,
  },
  {
    id: "advisor",
    labelZh: "思考幕僚",
    labelEn: "Advisor",
    avatar: "🧠",
    descZh: "方案推演、写作润色、复杂问题拆解与决策分析",
    descEn: "Strategy, writing polish, complex problem breakdown, and decision analysis",
    promptZh: "你是一位敏锐的思考幕僚与写作搭档，擅长拆解复杂问题、权衡利弊并给出清晰可执行的建议。",
    promptEn: "You are a sharp strategic advisor and writing partner skilled at breaking down complex problems and offering clear recommendations.",
    multiBot: true,
  },
  {
    id: "feishu-assistant",
    labelZh: "飞书助理",
    labelEn: "Feishu Assistant",
    avatar: "💬",
    descZh: "面向飞书私聊与群聊的轻量高效个人助理",
    descEn: "Concise, responsive assistant tailored for Feishu DMs and group mentions",
    promptZh: "你通过飞书 IM 为用户提供日常协助。回复精炼清晰、善用 Markdown 列表与要点，主动将重要偏好记录到长期记忆。",
    promptEn: "You assist the user through Feishu IM. Keep replies concise and well-structured, and record key preferences in your long-term memory.",
    multiBot: false,
  },
];

function normalizeBotAgent(raw: string | undefined): BotAgent {
  if (raw === "codex" || raw === "claude" || raw === "agy" || raw === "deepseek" || raw === "opencode" || raw === "pi") {
    return raw;
  }
  return "codex";
}

function toSourceAgent(agent: BotAgent): SourceRuntimeAgent {
  return agent === "deepseek" ? "codex" : agent;
}

export function BotEditorDialog({
  open,
  bot,
  initialSection = "persona",
  snapshot,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  bot?: PublicBot | undefined;
  initialSection?: BotEditorSection;
  snapshot: DesktopSnapshot;
  onOpenChange: (open: boolean) => void;
  onSaved: (bot: PublicBot, bots: PublicBot[]) => void;
  onDeleted?: (bots: PublicBot[]) => void;
}) {
  const { language, t } = useLocale();
  const isEditing = Boolean(bot);
  const isMaster = bot?.kind === "master";

  const [section, setSection] = useState<BotEditorSection>(initialSection);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("🤖");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [agent, setAgent] = useState<BotAgent>("codex");
  const [useSource, setUseSource] = useState(false);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [customModel, setCustomModel] = useState("");
  const [effort, setEffort] = useState<string | undefined>(undefined);
  const [selection, setSelection] = useState<SourceSelection | undefined>(undefined);
  const [allowCrossWorkspace, setAllowCrossWorkspace] = useState(false);

  const [feishuEnabled, setFeishuEnabled] = useState(false);
  const [feishuDomain, setFeishuDomain] = useState<FeishuDomain>("feishu");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [feishuGroupTrigger, setFeishuGroupTrigger] = useState<FeishuGroupTrigger>("mention");
  const [feishuStreamingCard, setFeishuStreamingCard] = useState(true);
  const [feishuAccessPolicy, setFeishuAccessPolicy] = useState<FeishuAccessPolicy>("admins_only");
  const [feishuAdmins, setFeishuAdmins] = useState<BotFeishuAdmin[]>([]);

  const [launchModels, setLaunchModels] = useState<AgentModel[]>([]);
  const [launchModelsLoading, setLaunchModelsLoading] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<BotFeishuProbeResult | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const modelRef = useRef(model);
  modelRef.current = model;

  const sourceState = useModelSources(open && useSource);
  const independentAccounts = useMemo(
    () =>
      snapshot.accounts.filter(
        (item) => !item["modelSource"] && !item["apiProfile"] && !item["apiProfileError"],
      ),
    [snapshot.accounts],
  );
  const launchAccounts = useMemo(
    () => sessionLaunchAccounts(independentAccounts, agent),
    [agent, independentAccounts],
  );
  const sourceAgent = toSourceAgent(agent);

  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setError(undefined);
    setProbeResult(undefined);
    setConfirmDelete(false);
    if (bot) {
      const nextAgent = normalizeBotAgent(bot.agent);
      setName(bot.name);
      setAvatar(bot.avatar || "🤖");
      setDescription(bot.description);
      setSystemPrompt(bot.systemPrompt);
      setAgent(nextAgent);
      const hasBinding = Boolean(bot.sourceBinding);
      setUseSource(hasBinding);
      setAccountId(
        bot.accountId ??
          defaultSessionLaunchAccountId(independentAccounts, nextAgent),
      );
      setModel(bot.model ?? undefined);
      setCustomModel("");
      setEffort(bot.effort ?? undefined);
      setSelection(
        bot.sourceBinding
          ? {
              sourceId: bot.sourceBinding.sourceId,
              routeId: bot.sourceBinding.routeId,
              revision: 1,
              agent: toSourceAgent(nextAgent),
            }
          : undefined,
      );
      setAllowCrossWorkspace(bot.allowCrossWorkspace);
      setFeishuEnabled(bot.feishu.enabled);
      setFeishuDomain(bot.feishu.domain);
      setFeishuAppId(bot.feishu.appId);
      setFeishuAppSecret("");
      setFeishuGroupTrigger(bot.feishu.groupTrigger);
      setFeishuStreamingCard(bot.feishu.streamingCard);
      setFeishuAccessPolicy(bot.feishu.accessPolicy);
      setFeishuAdmins(bot.feishu.adminUsers);
    } else {
      setName("");
      setAvatar("🤖");
      setDescription("");
      setSystemPrompt("");
      setAgent("codex");
      setUseSource(false);
      setAccountId(defaultSessionLaunchAccountId(independentAccounts, "codex"));
      setModel("gpt-6-astra");
      setCustomModel("");
      setEffort(undefined);
      setSelection(undefined);
      setAllowCrossWorkspace(false);
      setFeishuEnabled(false);
      setFeishuDomain("feishu");
      setFeishuAppId("");
      setFeishuAppSecret("");
      setFeishuGroupTrigger("mention");
      setFeishuStreamingCard(true);
      setFeishuAccessPolicy("admins_only");
      setFeishuAdmins([]);
    }
  }, [bot, independentAccounts, initialSection, open]);

  useEffect(() => {
    if (!open || useSource) return;
    if (!accountId || !launchAccounts.some((item) => item.id === accountId)) {
      setAccountId(defaultSessionLaunchAccountId(independentAccounts, agent));
    }
  }, [accountId, agent, independentAccounts, launchAccounts, open, useSource]);

  useEffect(() => {
    if (!open || useSource || typeof window.prospero?.getLaunchModels !== "function") {
      setLaunchModels([]);
      setLaunchModelsLoading(false);
      return;
    }
    if (agent === "opencode") {
      setLaunchModels([]);
      return;
    }
    let cancelled = false;
    setLaunchModelsLoading(true);
    void window.prospero
      .getLaunchModels(agent, accountId)
      .then((catalog) => {
        if (cancelled) return;
        const models = catalog.models ?? [];
        setLaunchModels(models);
        const matched = models.find((item) => item.id === modelRef.current);
        const fallback =
          matched ??
          models.find((item) => item.id === catalog.currentModel) ??
          models.find((item) => item.isDefault) ??
          models[0];
        setModel(fallback?.id ?? modelRef.current);
        if (fallback) {
          setEffort((currentEffort) =>
            (currentEffort && fallback.supportedEfforts.includes(currentEffort)
              ? currentEffort
              : undefined) ??
            (fallback.id === catalog.currentModel &&
            catalog.currentEffort &&
            fallback.supportedEfforts.includes(catalog.currentEffort)
              ? catalog.currentEffort
              : undefined) ??
            fallback.defaultEffort ??
            fallback.supportedEfforts[0],
          );
        }
      })
      .catch(() => {
        if (!cancelled) setLaunchModels([]);
      })
      .finally(() => {
        if (!cancelled) setLaunchModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, agent, open, useSource]);

  useEffect(() => {
    if (!open || !useSource) return;
    const picked = selectedSourceRoute(sourceState.sources, selection, sourceAgent);
    if (!picked) {
      const firstSource = sourceState.sources.find((item) => item.routes.some((route) => route.enabled));
      const firstRoute = firstSource?.routes.find((route) => route.enabled);
      if (firstSource && firstRoute) {
        setSelection({
          sourceId: firstSource.id,
          routeId: firstRoute.id,
          revision: firstSource.revision,
          agent: sourceAgent,
        });
      }
    }
  }, [open, selection, sourceAgent, sourceState.sources, useSource]);

  useEffect(() => {
    if (!open || !useSource) return;
    const active = selectedSourceRoute(sourceState.sources, selection, sourceAgent);
    if (active && active.route.defaultEffort && !effort) {
      setEffort(active.route.defaultEffort);
    }
  }, [effort, open, selection, sourceAgent, sourceState.sources, useSource]);

  const choice = selectedSourceRoute(sourceState.sources, selection, sourceAgent);
  const selectedLaunchModel = launchModels.find((item) => item.id === model);
  const effectiveModel = customModel.trim() || model;

  const testFeishu = async (): Promise<void> => {
    setProbeBusy(true);
    setProbeResult(undefined);
    setError(undefined);
    try {
      const result = await runBotAction({
        kind: "feishu.test",
        botId: bot?.id ?? null,
        domain: feishuDomain,
        appId: feishuAppId.trim(),
        appSecret: feishuAppSecret.trim() || null,
      });
      setProbeResult(result.probe ?? undefined);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setProbeBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      let nextAccountId: string | null = accountId ?? null;
      let nextModel: string | null = effectiveModel ?? null;
      let nextEffort: string | null = effort ?? null;
      let nextSourceBinding: BotSourceBinding | null = null;

      if (useSource) {
        if (!choice) {
          throw new Error(t("请选择有效的模型源与已启用路由。", "Select a valid model source and enabled route."));
        }
        const bound = await runModelSourceAction({
          kind: "bind",
          sourceId: choice.source.id,
          routeId: choice.route.id,
          revision: choice.source.revision,
          agent: sourceAgent,
        });
        if (!bound.accountId) {
          throw new Error(t("模型源未返回绑定账号。", "Model source did not return an account binding."));
        }
        nextAccountId = bound.accountId;
        nextModel = choice.route.model;
        nextEffort =
          choice.route.protocol !== "openai_chat_completions"
            ? (effort ?? choice.route.defaultEffort ?? null)
            : null;
        nextSourceBinding = {
          sourceId: choice.source.id,
          routeId: choice.route.id,
          boundAccountId: bound.accountId,
        };
      }

      const payload: BotUpsertInput = {
        name: name.trim(),
        avatar: avatar.trim() || "🤖",
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        agent: useSource ? sourceAgent : agent,
        accountId: nextAccountId,
        model: nextModel,
        effort: nextEffort,
        sourceBinding: nextSourceBinding,
        customWorkspace: bot?.customWorkspace ?? null,
        allowCrossWorkspace,
        feishu: {
          enabled: feishuEnabled,
          domain: feishuDomain,
          appId: feishuAppId.trim(),
          appSecret: feishuAppSecret.trim() || null,
          groupTrigger: feishuGroupTrigger,
          streamingCard: feishuStreamingCard,
          accessPolicy: feishuAccessPolicy,
          adminUsers: feishuAdmins,
        },
      };

      const result = bot
        ? await runBotAction({ kind: "update", botId: bot.id, input: payload })
        : await runBotAction({ kind: "create", input: payload });

      if (result.bot && result.bots) {
        onSaved(result.bot, result.bots);
      }
      onOpenChange(false);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeBot = async (): Promise<void> => {
    if (!bot || bot.kind === "master" || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await runBotAction({ kind: "delete", botId: bot.id });
      if (result.bots) onDeleted?.(result.bots);
      onOpenChange(false);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setSaving(false);
    }
  };

  const navItems: ReadonlyArray<{
    id: BotEditorSection;
    label: string;
    icon: typeof Sparkles;
    badge?: string | undefined;
    dot?: PublicBot["feishuStatus"]["state"] | undefined;
  }> = [
    { id: "persona", label: t("基础与人设", "Identity & Persona"), icon: Sparkles },
    { id: "model", label: t("模型与引擎", "Agent & Model"), icon: Cpu },
    {
      id: "feishu",
      label: t("飞书 IM", "Feishu IM"),
      icon: MessageSquare,
      dot: feishuEnabled ? (bot?.feishuStatus.state ?? "connecting") : undefined,
    },
    {
      id: "access",
      label: t("权限与管理员", "Access & Admins"),
      icon: ShieldCheck,
      badge: feishuAdmins.length > 0 ? String(feishuAdmins.length) : undefined,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="flex h-[min(84vh,670px)] w-[min(860px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[860px]">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-3.5 pr-12 bg-muted/15">
          <span className="bots-pane-avatar" aria-hidden="true">
            {avatar || "🤖"}
          </span>
          <div className="min-w-0 grid gap-0.5">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-sm font-semibold truncate">
                {bot
                  ? isMaster
                    ? t("配置主控 Bot（Prospero Bot）", "Configure Master Bot")
                    : t(`配置 Bot · ${name || bot.name}`, `Edit Bot · ${name || bot.name}`)
                  : t("新建子 Bot", "Create Sub-Bot")}
              </DialogTitle>
              {isMaster && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {t("默认主控", "Master")}
                </Badge>
              )}
            </div>
            <DialogDescription className="text-xs text-muted-foreground truncate">
              {t(
                "独立人设、模型引擎、跨话题记忆与飞书 IM 机器人配置。",
                "Configure persona, model runtime, layered memory, and Feishu IM.",
              )}
            </DialogDescription>
          </div>
        </div>

        {/* Left-nav settings split */}
        <div className="bot-editor-shell">
          <nav className="bot-editor-nav" aria-label={t("配置分类", "Settings categories")}>
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="bot-editor-nav-btn"
                  data-active={active}
                  onClick={() => setSection(item.id)}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate flex-1 text-left">{item.label}</span>
                  {item.dot && <span className="bot-feishu-dot" data-state={item.dot} />}
                  {item.badge && (
                    <span className="text-[10px] rounded-full bg-muted px-1.5 py-0 text-muted-foreground tabular-nums">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="bot-editor-content">
            {section === "persona" && (
              <div className="mx-auto max-w-xl grid gap-5">
                {!isEditing && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground mr-1">
                      <Sparkles className="inline size-3.5 mr-1" />
                      {t("快速模板：", "Templates:")}
                    </span>
                    {ROLE_PRESETS.map((preset) => (
                      <Button
                        key={preset.id}
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={saving}
                        onClick={() => {
                          const zh = language === "zh";
                          setAvatar(preset.avatar);
                          setName(zh ? preset.labelZh : preset.labelEn);
                          setDescription(zh ? preset.descZh : preset.descEn);
                          setSystemPrompt(zh ? preset.promptZh : preset.promptEn);
                          setAllowCrossWorkspace(preset.multiBot);
                        }}
                      >
                        {preset.avatar} {language === "zh" ? preset.labelZh : preset.labelEn}
                      </Button>
                    ))}
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-[88px_1fr]">
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-avatar-input">
                      {t("图标", "Avatar")}
                    </label>
                    <Input
                      id="bot-avatar-input"
                      value={avatar}
                      disabled={saving}
                      maxLength={8}
                      className="text-center text-lg"
                      onChange={(event) => setAvatar(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-name-input">
                      {t("Bot 名称", "Bot name")}
                    </label>
                    <Input
                      id="bot-name-input"
                      value={name}
                      disabled={saving}
                      placeholder={t("例如：日常助理、深度调研员、飞书管家", "e.g., Daily Assistant, Researcher")}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                </div>

                <div className="bot-avatar-presets">
                  {AVATAR_PRESETS.map((emoji) => (
                    <Button
                      key={emoji}
                      type="button"
                      size="xs"
                      variant={avatar === emoji ? "secondary" : "ghost"}
                      disabled={saving}
                      onClick={() => setAvatar(emoji)}
                    >
                      {emoji}
                    </Button>
                  ))}
                </div>

                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-desc-input">
                    {t("职责简介", "Short description")}
                  </label>
                  <Input
                    id="bot-desc-input"
                    value={description}
                    disabled={saving}
                    placeholder={t("一句话描述这个 Bot 擅长处理的任务", "One-line summary of what this Bot handles")}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>

                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-prompt-input">
                    {t("人设与行为指令（System Prompt）", "Persona & System Prompt")}
                  </label>
                  <Textarea
                    id="bot-prompt-input"
                    rows={6}
                    value={systemPrompt}
                    disabled={saving}
                    className="leading-relaxed"
                    placeholder={t("定义该 Bot 的角色身份、输出风格、行为边界等…", "Define persona, response style, and boundaries…")}
                    onChange={(event) => setSystemPrompt(event.target.value)}
                  />
                </div>

                <div className="bot-setting-row">
                  <div className="grid gap-0.5 min-w-0">
                    <span className="text-xs font-medium text-foreground">
                      {t("允许调度其他子 Bot 协同", "Multi-Bot Collaboration")}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t(
                        "开启后，该 Bot 可自动唤醒其他专职子 Bot 分工合作并汇总结果。",
                        "Allows delegating subtasks to other specialized Sub-Bots.",
                      )}
                    </span>
                  </div>
                  <Switch
                    checked={allowCrossWorkspace}
                    disabled={saving}
                    aria-label={t("允许调度其他子 Bot 协同处理任务", "Allow delegating subtasks to other Sub-Bots")}
                    onCheckedChange={setAllowCrossWorkspace}
                  />
                </div>
              </div>
            )}

            {section === "model" && (
              <div className="mx-auto max-w-xl grid gap-5">
                <div className="bot-setting-row">
                  <div className="grid gap-0.5 min-w-0">
                    <span className="text-xs font-medium text-foreground">
                      {t("模型接入方式", "Model Provider")}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("选择本机订阅 CLI 账号或自定义 API 模型源", "Use a subscription CLI account or an API Model Source")}
                    </span>
                  </div>
                  <ToggleGroup
                    value={[useSource ? "source" : "account"]}
                    onValueChange={(values) => {
                      if (values[0] === "account") setUseSource(false);
                      if (values[0] === "source") setUseSource(true);
                    }}
                    variant="outline"
                    size="sm"
                  >
                    <ToggleGroupItem value="account">{t("订阅 / 本机账号", "Subscription")}</ToggleGroupItem>
                    <ToggleGroupItem value="source">{t("API 模型源", "Model Source")}</ToggleGroupItem>
                  </ToggleGroup>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-agent-select">
                      {t("驱动 Agent / Harness", "Agent / Harness")}
                    </label>
                    <NativeSelect
                      id="bot-agent-select"
                      value={agent}
                      disabled={saving}
                      onChange={(event) => {
                        const next = normalizeBotAgent(event.target.value);
                        setAgent(next);
                        setAccountId(defaultSessionLaunchAccountId(independentAccounts, next));
                        setModel(next === "codex" ? "gpt-6-astra" : undefined);
                        setCustomModel("");
                        setEffort(undefined);
                      }}
                    >
                      {BOT_AGENTS.filter((item) => !useSource || item.id !== "deepseek").map((item) => (
                        <NativeSelectOption key={item.id} value={item.id}>
                          {item.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>

                  {!useSource && (
                    <div className="grid gap-1.5">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-account-select">
                        {t("执行账号", "Account")}
                      </label>
                      <NativeSelect
                        id="bot-account-select"
                        value={accountId ?? ""}
                        disabled={saving || launchAccounts.length === 0}
                        onChange={(event) => setAccountId(event.target.value || undefined)}
                      >
                        {launchAccounts.length === 0 ? (
                          <NativeSelectOption value="">
                            {agent === "deepseek"
                              ? t("本机 DeepSeek CLI", "Local DeepSeek CLI")
                              : t("默认本机环境", "Local default")}
                          </NativeSelectOption>
                        ) : (
                          launchAccounts.map((item) => (
                            <NativeSelectOption key={item.id} value={item.id}>
                              {item.name}
                            </NativeSelectOption>
                          ))
                        )}
                      </NativeSelect>
                    </div>
                  )}
                </div>

                {useSource ? (
                  <SourceSelector
                    sources={sourceState.sources}
                    loading={sourceState.loading}
                    error={sourceState.error}
                    value={selection}
                    agent={sourceAgent}
                    effort={effort}
                    onEffortChange={setEffort}
                    onChange={setSelection}
                    onRefresh={() => void sourceState.refresh()}
                    disabled={saving}
                  />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-model-select">
                        {t("模型", "Model")}
                      </label>
                      {agent === "agy" ? (
                        <AgyModelPicker
                          id="bot-model-select"
                          models={launchModels}
                          value={model}
                          effort={effort}
                          loading={launchModelsLoading}
                          disabled={saving || launchModelsLoading || launchModels.length === 0}
                          onChange={(nextModel, nextEffort) => {
                            setModel(nextModel);
                            setEffort(nextEffort);
                          }}
                        />
                      ) : (
                        <NativeSelect
                          id="bot-model-select"
                          value={model ?? ""}
                          disabled={saving || launchModelsLoading || launchModels.length === 0}
                          onChange={(event) => {
                            const next = launchModels.find((item) => item.id === event.target.value);
                            setModel(next?.id);
                            setEffort(next?.defaultEffort ?? next?.supportedEfforts[0]);
                          }}
                        >
                          {launchModels.length === 0 ? (
                            <NativeSelectOption value={model ?? ""}>
                              {launchModelsLoading ? t("读取目录中…", "Loading catalog…") : model || t("默认模型", "Default model")}
                            </NativeSelectOption>
                          ) : (
                            launchModels.map((item) => (
                              <NativeSelectOption key={item.id} value={item.id}>
                                {item.label}
                              </NativeSelectOption>
                            ))
                          )}
                        </NativeSelect>
                      )}
                    </div>

                    <div className="grid gap-1.5">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-custom-model-input">
                        {t("自定义模型 ID（可选覆盖）", "Custom model ID (optional)")}
                      </label>
                      <Input
                        id="bot-custom-model-input"
                        value={customModel}
                        disabled={saving}
                        placeholder={model ?? t("留空则使用左侧所选模型", "Leave empty to use selected model")}
                        onChange={(event) => setCustomModel(event.target.value)}
                      />
                    </div>

                    {Boolean(selectedLaunchModel?.supportedEfforts.length) && (
                      <div className="grid gap-1.5">
                        <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-effort-select">
                          {t("推理强度", "Reasoning effort")}
                        </label>
                        <NativeSelect
                          id="bot-effort-select"
                          value={effort ?? ""}
                          disabled={saving}
                          onChange={(event) => setEffort(event.target.value || undefined)}
                        >
                          {selectedLaunchModel?.supportedEfforts.map((level) => (
                            <NativeSelectOption key={level} value={level}>
                              {agent === "agy" ? formatAgyEffortLabel(level) : level}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {section === "feishu" && (
              <div className="mx-auto max-w-xl grid gap-5">
                <div className="bot-setting-row">
                  <div className="grid gap-0.5 min-w-0">
                    <span className="text-xs font-semibold text-foreground">
                      {t("启用飞书 Bot 长连接 IM", "Enable Feishu WebSocket IM")}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {isMaster
                        ? t("主控 Bot 默认仅桌面端使用；开启后可在飞书内直接调用。", "Master Bot stays Desktop-only by default; enable to access via Feishu.")
                        : t("开启后可在飞书私聊或群聊中随时对话，免公网域名。", "Chat from Feishu DM or groups without a public webhook.")}
                    </span>
                  </div>
                  <Switch
                    checked={feishuEnabled}
                    disabled={saving}
                    aria-label={t("启用飞书 Bot IM", "Enable Feishu Bot IM")}
                    onCheckedChange={setFeishuEnabled}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-feishu-domain">
                      {t("平台域", "Platform domain")}
                    </label>
                    <NativeSelect
                      id="bot-feishu-domain"
                      value={feishuDomain}
                      disabled={saving}
                      onChange={(event) => setFeishuDomain(event.target.value as FeishuDomain)}
                    >
                      <NativeSelectOption value="feishu">飞书 (open.feishu.cn)</NativeSelectOption>
                      <NativeSelectOption value="lark">Lark (open.larksuite.com)</NativeSelectOption>
                    </NativeSelect>
                  </div>

                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-feishu-trigger">
                      {t("群聊触发方式", "Group chat trigger")}
                    </label>
                    <NativeSelect
                      id="bot-feishu-trigger"
                      value={feishuGroupTrigger}
                      disabled={saving}
                      onChange={(event) => setFeishuGroupTrigger(event.target.value as FeishuGroupTrigger)}
                    >
                      <NativeSelectOption value="mention">{t("仅 @提及机器人时回复", "Reply only on @mention")}</NativeSelectOption>
                      <NativeSelectOption value="all">{t("响应群内所有消息", "Respond to all group messages")}</NativeSelectOption>
                    </NativeSelect>
                  </div>

                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-feishu-appid">
                      App ID
                    </label>
                    <Input
                      id="bot-feishu-appid"
                      value={feishuAppId}
                      disabled={saving}
                      placeholder="cli_xxxxxxxxxxxxxxxx"
                      className="font-mono text-xs"
                      onChange={(event) => setFeishuAppId(event.target.value)}
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-feishu-secret">
                      App Secret
                    </label>
                    <Input
                      id="bot-feishu-secret"
                      type="password"
                      value={feishuAppSecret}
                      disabled={saving}
                      placeholder={
                        bot?.feishu.hasAppSecret
                          ? t("已保存密钥（留空保持不变）", "Saved secret (leave blank to keep)")
                          : t("填写飞书应用 App Secret", "Enter Feishu App Secret")
                      }
                      onChange={(event) => setFeishuAppSecret(event.target.value)}
                    />
                  </div>
                </div>

                <div className="bot-setting-row">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Switch
                      checked={feishuStreamingCard}
                      disabled={saving}
                      aria-label={t("流式卡片更新", "Streaming interactive card updates")}
                      onCheckedChange={setFeishuStreamingCard}
                    />
                    <span className="text-xs text-muted-foreground">
                      {t("流式更新飞书互动卡片（思考中 → 实时输出 → 完成）", "Stream progress into Feishu interactive card")}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={saving || probeBusy || !feishuAppId.trim()}
                    onClick={() => void testFeishu()}
                  >
                    {probeBusy ? <Spinner data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}
                    {t("测试连接", "Test connection")}
                  </Button>
                </div>

                {probeResult && (
                  <Alert variant={probeResult.ok ? "default" : "destructive"}>
                    {probeResult.ok ? <CheckCircle2 /> : <CircleAlert />}
                    <AlertTitle>
                      {probeResult.ok ? t("连接成功", "Connection verified") : t("连接校验未通过", "Connection check failed")}
                    </AlertTitle>
                    <AlertDescription>{probeResult.message}</AlertDescription>
                  </Alert>
                )}

                <details className="rounded-lg border border-border bg-muted/20 px-3.5 py-2.5 text-xs text-muted-foreground">
                  <summary className="cursor-pointer font-medium text-foreground">
                    {t("飞书开放平台 3 步配置指南", "3-Step Feishu Open Platform Setup")}
                  </summary>
                  <ol className="mt-2 grid gap-1.5 pl-4 list-decimal leading-relaxed">
                    <li>{t("创建企业自建应用并启用「机器人」能力，复制 App ID 与 App Secret。", "Create a custom app, enable Bot capability, and copy App ID & App Secret.")}</li>
                    <li>{t("在「权限管理」开通 im:message、im:message.p2p_msg:readonly、im:message.group_at_msg:readonly、im:chat:readonly；如需自动显示成员姓名，可额外开通 contact:user.base:readonly。", "Grant im:message, im:message.p2p_msg:readonly, im:message.group_at_msg:readonly, and im:chat:readonly permissions (plus optional contact:user.base:readonly to show member names automatically).")}</li>
                    <li>{t("在「事件与回调」选择「使用长连接接收事件」，添加 im.message.receive_v1 并发布应用版本。", "In Events & Callbacks choose WebSocket Long Connection, subscribe to im.message.receive_v1, and publish.")}</li>
                  </ol>
                </details>
              </div>
            )}

            {section === "access" && (
              <div className="mx-auto max-w-xl">
                <FeishuAccessControlPanel
                  accessPolicy={feishuAccessPolicy}
                  adminUsers={feishuAdmins}
                  recentSenders={bot?.feishuStatus.recentSenders ?? []}
                  disabled={saving}
                  onChange={(nextPolicy, nextAdmins) => {
                    setFeishuAccessPolicy(nextPolicy);
                    setFeishuAdmins(nextAdmins);
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="border-t border-border px-5 py-2.5 bg-destructive/5">
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>{t("保存失败", "Action failed")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-5 py-3">
          <div>
            {bot && !isMaster && (
              confirmDelete ? (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="destructive" size="sm" disabled={saving} onClick={() => void removeBot()}>
                    {t("确认删除", "Confirm delete")}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setConfirmDelete(false)}>
                    {t("取消", "Cancel")}
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setConfirmDelete(true)}>
                  <Trash2 data-icon="inline-start" />
                  {t("删除 Bot", "Delete Bot")}
                </Button>
              )
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => onOpenChange(false)}>
              {t("取消", "Cancel")}
            </Button>
            <Button type="button" size="sm" disabled={saving || !name.trim()} onClick={() => void save()}>
              {saving && <Spinner data-icon="inline-start" />}
              {bot ? t("保存配置", "Save changes") : t("创建 Bot", "Create Bot")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
