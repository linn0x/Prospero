import { useState } from "react";
import {
  BellRing,
  Bot,
  Brain,
  MessageSquare,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import type { PublicBot } from "../../../shared/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { AgentLogo } from "../AgentLogo";
import { useLocale } from "../locale";
import { displayError } from "../state";
import { feishuStateLabel } from "./BotInspectorSheet";
import { accessPolicyLabel } from "./FeishuAccessControlPanel";
import { buildBotUpdateInput } from "./bot-helpers";
import { runBotAction } from "./use-bots";

export function BotCapabilitiesPanel({
  bot,
  onBotsUpdated,
  onEditPersona,
  onEditFeishu,
  onOpenFeishuAccess,
}: {
  bot: PublicBot;
  onBotsUpdated: (bots: PublicBot[]) => void;
  onEditPersona: () => void;
  onEditFeishu: () => void;
  onOpenFeishuAccess: () => void;
}) {
  const { t } = useLocale();
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const toggleSetting = async (
    key: "autoMemory" | "proactiveNotifications" | "allowCrossWorkspace",
    nextValue: boolean,
  ) => {
    if (busyKey) return;
    setBusyKey(key);
    setError(undefined);
    try {
      const res = await runBotAction({
        kind: "update",
        botId: bot.id,
        input: buildBotUpdateInput(bot, { [key]: nextValue }),
      });
      if (res.bots) onBotsUpdated(res.bots);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusyKey(undefined);
    }
  };

  const reconnectFeishu = async () => {
    if (busyKey) return;
    setBusyKey("feishu-reconnect");
    setError(undefined);
    try {
      const res = await runBotAction({ kind: "feishu.reconnect", botId: bot.id });
      if (res.bots) onBotsUpdated(res.bots);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusyKey(undefined);
    }
  };

  return (
    <div className="bot-panel-scroll" data-testid="bot-capabilities-panel">
      <div className="bot-panel-header">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Sparkles className="size-4 text-primary" />
            <span>{t("能力配置与外挂连接", "Capabilities & Optional Channels")}</span>
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "管理智能体人设、自动记忆与主动提醒行为，并按需接入可选外部渠道（如飞书 IM）。",
              "Configure agent persona, autonomous memory/alerts, and optional external channels.",
            )}
          </p>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Persona & Model Summary */}
      <section className="bot-cap-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="bots-pane-avatar" aria-hidden="true">
              {bot.avatar}
            </span>
            <div className="grid gap-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm font-semibold">{bot.name}</strong>
                <span className="bots-meta-chip">
                  <AgentLogo agent={bot.agent} size={12} decorative />
                  <span>{bot.agent}</span>
                  {bot.model && <code>· {bot.model}</code>}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {bot.description || t("暂无简介", "No description")}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onEditPersona}>
            <Settings data-icon="inline-start" />
            {t("编辑人设与模型", "Edit Persona & Model")}
          </Button>
        </div>
      </section>

      {/* Core Personal Agent Toggles */}
      <section className="bot-cap-card grid gap-3">
        <strong className="text-xs font-semibold text-foreground uppercase tracking-wide">
          {t("个人智能体核心开关", "Personal Agent Behaviors")}
        </strong>

        <div className="bot-cap-toggle-row">
          <div className="flex items-start gap-2.5 min-w-0">
            <Brain className="size-4 text-primary shrink-0 mt-0.5" />
            <div className="grid gap-0.5">
              <span className="text-xs font-medium">{t("主动长期记忆", "Auto Active Memory")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t(
                  "在桌面端与手机 App 对话中自动注入「关于你」记忆卡片并支持主动沉淀新偏好。",
                  "Automatically inject 'About You' memory cards and remember preferences across App chats.",
                )}
              </span>
            </div>
          </div>
          <Switch
            checked={bot.autoMemory}
            disabled={Boolean(busyKey)}
            onCheckedChange={(checked) => void toggleSetting("autoMemory", checked)}
          />
        </div>

        <div className="bot-cap-toggle-row">
          <div className="flex items-start gap-2.5 min-w-0">
            <BellRing className="size-4 text-primary shrink-0 mt-0.5" />
            <div className="grid gap-0.5">
              <span className="text-xs font-medium">{t("后台主动提醒推送", "Proactive Notifications")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t(
                  "定时/心跳任务在后台执行完成后，主动向桌面端与手机 App 发送未读红点与通知。",
                  "Send proactive unread alerts & notifications to Desktop and Mobile when tasks complete.",
                )}
              </span>
            </div>
          </div>
          <Switch
            checked={bot.proactiveNotifications}
            disabled={Boolean(busyKey)}
            onCheckedChange={(checked) => void toggleSetting("proactiveNotifications", checked)}
          />
        </div>

        <div className="bot-cap-toggle-row">
          <div className="flex items-start gap-2.5 min-w-0">
            <Users className="size-4 text-primary shrink-0 mt-0.5" />
            <div className="grid gap-0.5">
              <span className="text-xs font-medium">{t("多 Bot 团队协同调度", "Multi-Bot Team Dispatch")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t(
                  "允许当前 Bot 将复杂子任务派发给其他专职子 Bot 分工完成并汇总结果。",
                  "Allow delegating subtasks to specialized Sub-Bots and synthesizing results.",
                )}
              </span>
            </div>
          </div>
          <Switch
            checked={bot.allowCrossWorkspace}
            disabled={Boolean(busyKey)}
            onCheckedChange={(checked) => void toggleSetting("allowCrossWorkspace", checked)}
          />
        </div>
      </section>

      {/* Optional External Channel Plugins */}
      <section className="bot-cap-card grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <strong className="text-xs font-semibold text-foreground uppercase tracking-wide">
              {t("可选外挂渠道", "Optional External Channels")}
            </strong>
            <Badge variant="outline" className="h-4.5 px-1.5 text-[10px]">
              {t("非必需 · 按需开启", "Optional Plugin")}
            </Badge>
          </div>
        </div>

        <div className="bot-cap-plugin-box">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <MessageSquare className="size-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="grid gap-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-xs font-semibold">{t("飞书 / Lark IM 机器人", "Feishu / Lark IM Bot")}</strong>
                  <span className="bots-meta-chip">
                    <span className="bot-feishu-dot" data-state={bot.feishuStatus.state} />
                    <span>{feishuStateLabel(bot.feishuStatus.state, t)}</span>
                  </span>
                  {bot.feishu.enabled && (
                    <span className="bots-meta-chip">
                      <ShieldCheck className="size-3 text-emerald-600 dark:text-emerald-400" />
                      <span>{accessPolicyLabel(bot.feishu.accessPolicy, t)}</span>
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t(
                    "外挂扩展能力：开启后可将本 Bot 同步接入飞书私聊与群聊（所有核心对话、记忆与后台提醒能力在 Prospero 桌面端与手机 App 原生即可使用）。",
                    "Optional integration to mirror this Bot into Feishu DMs/groups. Core chat, memory, and reminders work natively in Desktop & Mobile App without Feishu.",
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {bot.feishu.enabled && (
                <>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busyKey === "feishu-reconnect"}
                    onClick={() => void reconnectFeishu()}
                  >
                    {busyKey === "feishu-reconnect" ? (
                      <Spinner className="size-3" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    {t("重连", "Reconnect")}
                  </Button>
                  <Button variant="outline" size="xs" onClick={onOpenFeishuAccess}>
                    <ShieldCheck className="size-3" />
                    {t("权限 ACL", "Access ACL")}
                  </Button>
                </>
              )}
              <Button variant={bot.feishu.enabled ? "ghost" : "outline"} size="xs" onClick={onEditFeishu}>
                <Bot className="size-3" />
                {bot.feishu.enabled ? t("管理飞书外挂", "Configure Feishu") : t("按需接入飞书", "Connect Feishu (Optional)")}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
