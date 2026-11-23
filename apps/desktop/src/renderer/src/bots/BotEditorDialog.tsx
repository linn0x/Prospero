import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, PlugZap, Sparkles, Trash2 } from "lucide-react";
import {
  defaultSessionLaunchAccountId,
  sessionLaunchAccounts,
} from "../../../shared/session-launch-options";
import type {
  AgentModel,
  BotFeishuProbeResult,
  BotSourceBinding,
  BotUpsertInput,
  DesktopSnapshot,
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
  DialogFooter,
  DialogHeader,
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
import { runBotAction } from "./use-bots";

type BotAgent = "codex" | "claude" | "agy" | "deepseek" | "opencode" | "pi";

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
  crossWorkspace: boolean;
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
    crossWorkspace: false,
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
    crossWorkspace: true,
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
    crossWorkspace: false,
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
  snapshot,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  bot?: PublicBot | undefined;
  snapshot: DesktopSnapshot;
  onOpenChange: (open: boolean) => void;
  onSaved: (bot: PublicBot, bots: PublicBot[]) => void;
  onDeleted?: (bots: PublicBot[]) => void;
}) {
  const { language, t } = useLocale();
  const isEditing = Boolean(bot);
  const isMaster = bot?.kind === "master";

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

  const [launchModels, setLaunchModels] = useState<AgentModel[]>([]);
  const [launchModelsLoading, setLaunchModelsLoading] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<BotFeishuProbeResult | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

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
    }
  }, [bot, independentAccounts, open]);

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
        const astraPresent = catalog.models.some((item) => item.id === "gpt-6-astra");
        const models =
          agent === "codex" && !astraPresent
            ? [
                {
                  id: "gpt-6-astra",
                  label: "GPT-6-Astra",
                  description: "Codex Astra model",
                  isDefault: false,
                  supportedEfforts: ["low", "medium", "high", "xhigh"],
                  defaultEffort: "high",
                },
                ...catalog.models,
              ]
            : catalog.models;
        setLaunchModels(models);
        setModel((current) => {
          const matched = models.find((item) => item.id === current);
          const fallback =
            matched ??
            (agent === "codex" ? models.find((item) => item.id === "gpt-6-astra") : undefined) ??
            models.find((item) => item.id === catalog.currentModel) ??
            models.find((item) => item.isDefault) ??
            models[0];
          setEffort((currentEffort) =>
            currentEffort && fallback?.supportedEfforts.includes(currentEffort)
              ? currentEffort
              : fallback?.defaultEffort ?? fallback?.supportedEfforts[0],
          );
          return fallback?.id ?? current;
        });
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

  // Keep existing sourceBinding revision aligned once sources list arrives.
  useEffect(() => {
    if (!open || !useSource || !selection || !sourceState.sources.length) return;
    const matchedSource = sourceState.sources.find((item) => item.id === selection.sourceId);
    if (matchedSource && matchedSource.revision !== selection.revision) {
      setSelection((current) =>
        current && current.sourceId === matchedSource.id
          ? { ...current, revision: matchedSource.revision }
          : current,
      );
    }
  }, [open, selection, sourceState.sources, useSource]);

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

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {bot
              ? isMaster
                ? t("配置主控 Bot（Prospero Bot）", "Configure Master Bot (Prospero Bot)")
                : t(`编辑 Bot · ${bot.name}`, `Edit Bot · ${bot.name}`)
              : t("新建子 Bot", "Create Sub-Bot")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "每个 Bot 拥有独立人设、跨话题长期记忆、专属模型与 Agent，并可按需接入飞书机器人。",
              "Each Bot has its own persona, persistent memory, configurable agent/model, and optional Feishu IM.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>{t("保存失败", "Action failed")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

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
                    setAllowCrossWorkspace(preset.crossWorkspace);
                  }}
                >
                  {preset.avatar} {language === "zh" ? preset.labelZh : preset.labelEn}
                </Button>
              ))}
            </div>
          )}

          {/* 1. Identity & Persona */}
          <section className="bot-editor-section">
            <div className="flex items-center justify-between">
              <strong className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("1. 身份与人设", "1. Identity & Persona")}
              </strong>
              {isMaster && <Badge variant="secondary">{t("默认主控 Bot", "Default Master Bot")}</Badge>}
            </div>

            <div className="grid gap-3 sm:grid-cols-[100px_1fr]">
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-avatar-input">
                  {t("头像", "Avatar")}
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
                  placeholder={t("例如：日常助理、深度调研员、思考幕僚、飞书管家", "e.g., Daily Assistant, Researcher, Advisor, Feishu Helper")}
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
                rows={4}
                value={systemPrompt}
                disabled={saving}
                placeholder={t("定义该 Bot 的角色身份、输出风格、工具使用边界等…", "Define persona, response style, and boundaries…")}
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </div>
          </section>

          {/* 2. Agent & Model */}
          <section className="bot-editor-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("2. Agent 与模型配置", "2. Agent & Model")}
              </strong>
              <ToggleGroup
                value={[useSource ? "source" : "account"]}
                onValueChange={(values) => {
                  if (values[0] === "account") setUseSource(false);
                  if (values[0] === "source") setUseSource(true);
                }}
                variant="outline"
                size="sm"
              >
                <ToggleGroupItem value="account">{t("订阅 / 本机账号", "Subscription / Local")}</ToggleGroupItem>
                <ToggleGroupItem value="source">{t("API 模型源", "Model Source")}</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="bot-editor-grid-2">
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
              <div className="bot-editor-grid-2">
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="bot-model-select">
                    {t("模型", "Model")}
                  </label>
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
                          {level}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 3. Multi-Bot Collaboration */}
          <section className="bot-editor-section">
            <strong className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("3. 多 Bot 协同", "3. Multi-Bot Collaboration")}
            </strong>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="grid gap-0.5">
                <span className="text-sm font-medium">
                  {t("允许调度其他子 Bot 协同处理任务", "Allow delegating subtasks to other Sub-Bots")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(
                    "开启后，该 Bot 可根据任务需要自动唤醒其他专职子 Bot 分工合作并汇总结果。",
                    "Allows this Bot to delegate subtasks to specialized Sub-Bots and synthesize their replies.",
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
          </section>

          {/* 4. Feishu IM */}
          <section className="bot-editor-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="grid gap-0.5">
                <strong className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("4. 飞书 Bot IM 接入（长连接 · 免公网域名）", "4. Feishu Bot IM (WebSocket Long Connection)")}
                </strong>
                <span className="text-xs text-muted-foreground">
                  {isMaster
                    ? t("主控 Bot 默认仅桌面端使用；如需在飞书内统筹，也可按需开启。", "Master Bot stays Desktop-only by default; enable only if you want Feishu access to Master Bot.")
                    : t("开启后可在飞书私聊或群聊 @机器人直接对话，并与桌面端实时同步。", "Talk with this Bot from Feishu DM or @mentions with live Desktop sync.")}
                </span>
              </div>
              <Switch
                checked={feishuEnabled}
                disabled={saving}
                aria-label={t("启用飞书 Bot IM", "Enable Feishu Bot IM")}
                onCheckedChange={setFeishuEnabled}
              />
            </div>

            <div className="bot-editor-grid-2">
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

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
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
                size="sm"
                disabled={saving || probeBusy || !feishuAppId.trim()}
                onClick={() => void testFeishu()}
              >
                {probeBusy ? <Spinner data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}
                {t("测试飞书连接", "Test connection")}
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

            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium">
                {t("飞书开放平台 3 步配置指南", "3-Step Feishu Open Platform Setup")}
              </summary>
              <ol className="mt-2 grid gap-1 pl-4 list-decimal">
                <li>{t("创建企业自建应用并启用「机器人」能力，复制 App ID 与 App Secret。", "Create a custom app, enable Bot capability, and copy App ID & App Secret.")}</li>
                <li>{t("在「权限管理」开通 im:message、im:message.p2p_msg:readonly、im:message.group_at_msg:readonly、im:chat:readonly；如需自动显示成员姓名，可额外开通 contact:user.base:readonly。", "Grant im:message, im:message.p2p_msg:readonly, im:message.group_at_msg:readonly, and im:chat:readonly permissions (plus optional contact:user.base:readonly to show member names automatically).")}</li>
                <li>{t("在「事件与回调」选择「使用长连接接收事件」，添加 im.message.receive_v1 并发布应用版本。", "In Events & Callbacks choose WebSocket Long Connection, subscribe to im.message.receive_v1, and publish.")}</li>
              </ol>
            </details>
          </section>
        </div>

        <DialogFooter className="flex-wrap justify-between gap-2">
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
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              {t("取消", "Cancel")}
            </Button>
            <Button type="button" disabled={saving || !name.trim()} onClick={() => void save()}>
              {saving && <Spinner data-icon="inline-start" />}
              {bot ? t("保存配置", "Save changes") : t("创建 Bot", "Create Bot")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
