import { useMemo, useState } from "react";
import {
  BellRing,
  Clock,
  Pause,
  Pencil,
  Play,
  Plus,
  Rocket,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  BotTask,
  BotTaskDelivery,
  BotTaskKind,
  PublicBot,
} from "../../../shared/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { useLocale } from "../locale";
import { displayError } from "../state";
import { formatBotScheduleSummary, formatNextRunRelative } from "./bot-helpers";
import { runBotAction } from "./use-bots";

type TaskPreset = {
  id: string;
  nameZh: string;
  nameEn: string;
  promptZh: string;
  promptEn: string;
  kind: BotTaskKind;
  rrule?: string;
  offsetMs?: number;
};

const TASK_PRESETS: ReadonlyArray<TaskPreset> = [
  {
    id: "morning-brief",
    nameZh: "每日早报 08:00",
    nameEn: "Daily Morning Brief",
    promptZh: "结合我的长期记忆和近期项目，生成今日核心待办与重点提示简报。",
    promptEn: "Review my memory & active projects to draft a concise morning brief.",
    kind: "cron",
    rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
  },
  {
    id: "hourly-heartbeat",
    nameZh: "每小时巡检",
    nameEn: "Hourly Heartbeat",
    promptZh: "检查当前是否有需要跟进或预警的事项，如有重要发现主动向我汇报。",
    promptEn: "Check for any updates or risks that require my attention and report concisely.",
    kind: "heartbeat",
    rrule: "FREQ=HOURLY;INTERVAL=1",
  },
  {
    id: "one-hour-reminder",
    nameZh: "1 小时后提醒我",
    nameEn: "Remind me in 1h",
    promptZh: "到了约定的时间，请主动提醒我确认当前推进事项的进展。",
    promptEn: "Remind me to review and follow up on my current priority.",
    kind: "one_shot",
    offsetMs: 3_600_000,
  },
];

function kindLabel(kind: BotTaskKind, t: (zh: string, en: string) => string): string {
  switch (kind) {
    case "cron":
      return t("定时", "Cron");
    case "heartbeat":
      return t("心跳", "Heartbeat");
    case "one_shot":
      return t("一次性", "One-shot");
  }
}

export function BotTasksPanel({
  bot,
  onBotsUpdated,
}: {
  bot: PublicBot;
  onBotsUpdated: (bots: PublicBot[]) => void;
}) {
  const { language, t } = useLocale();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<BotTask | undefined>(undefined);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<BotTaskKind>("cron");
  const [rrule, setRrule] = useState("FREQ=DAILY;BYHOUR=8;BYMINUTE=0");
  const [runAtLocal, setRunAtLocal] = useState("");
  const [delivery, setDelivery] = useState<BotTaskDelivery>("primary_thread");
  const [notifyApp, setNotifyApp] = useState(true);
  const [feishuChatId, setFeishuChatId] = useState("");
  const [busyTaskId, setBusyTaskId] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const feishuChats = useMemo(
    () =>
      bot.threads
        .filter((thr) => Boolean(thr.feishuChatId))
        .map((thr) => ({
          id: thr.feishuChatId!,
          label: thr.chatName?.trim() || thr.title,
        })),
    [bot.threads],
  );

  const openCreate = (preset?: TaskPreset) => {
    setEditingTask(undefined);
    setError(undefined);
    if (preset) {
      setName(language === "zh" ? preset.nameZh : preset.nameEn);
      setPrompt(language === "zh" ? preset.promptZh : preset.promptEn);
      setKind(preset.kind);
      setRrule(preset.rrule ?? "FREQ=DAILY;BYHOUR=8;BYMINUTE=0");
      if (preset.offsetMs) {
        const target = new Date(Date.now() + preset.offsetMs);
        setRunAtLocal(new Date(target.getTime() - target.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
      } else {
        setRunAtLocal("");
      }
    } else {
      setName("");
      setPrompt("");
      setKind("cron");
      setRrule("FREQ=DAILY;BYHOUR=8;BYMINUTE=0");
      setRunAtLocal("");
    }
    setDelivery("primary_thread");
    setNotifyApp(true);
    setFeishuChatId("");
    setDialogOpen(true);
  };

  const openEdit = (task: BotTask) => {
    setEditingTask(task);
    setError(undefined);
    setName(task.name);
    setPrompt(task.prompt);
    setKind(task.kind);
    setRrule(task.rrule ?? "FREQ=DAILY;BYHOUR=8;BYMINUTE=0");
    if (task.runAt) {
      const target = new Date(task.runAt);
      setRunAtLocal(new Date(target.getTime() - target.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    } else {
      setRunAtLocal("");
    }
    setDelivery(task.delivery);
    setNotifyApp(task.notifyApp);
    setFeishuChatId(task.notifyFeishuChatId ?? "");
    setDialogOpen(true);
  };

  const submitForm = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      let parsedRunAt: number | null = null;
      if (kind === "one_shot") {
        if (runAtLocal.trim()) {
          const ts = new Date(runAtLocal).getTime();
          if (!Number.isFinite(ts)) {
            throw new Error(t("请选择有效的提醒时间。", "Please pick a valid date and time."));
          }
          parsedRunAt = ts;
        } else {
          parsedRunAt = Date.now() + 3_600_000;
        }
      }
      const res = editingTask
        ? await runBotAction({
            kind: "task.update",
            botId: bot.id,
            taskId: editingTask.id,
            input: {
              name: name.trim(),
              prompt: prompt.trim(),
              kind,
              rrule: kind === "one_shot" ? null : rrule.trim(),
              runAt: kind === "one_shot" ? parsedRunAt : null,
              delivery,
              notifyApp,
              notifyFeishuChatId: feishuChatId.trim() || null,
              status: null,
            },
          })
        : await runBotAction({
            kind: "task.create",
            botId: bot.id,
            input: {
              name: name.trim(),
              prompt: prompt.trim(),
              kind,
              rrule: kind === "one_shot" ? null : rrule.trim(),
              runAt: kind === "one_shot" ? parsedRunAt : null,
              delivery,
              notifyApp,
              notifyFeishuChatId: feishuChatId.trim() || null,
            },
          });
      if (res.bots) onBotsUpdated(res.bots);
      setDialogOpen(false);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setSaving(false);
    }
  };

  const runTaskAction = async (
    taskId: string,
    action: "task.pause" | "task.resume" | "task.delete" | "task.run",
  ) => {
    if (busyTaskId) return;
    setBusyTaskId(taskId);
    setError(undefined);
    try {
      const res = await runBotAction({ kind: action, botId: bot.id, taskId });
      if (res.bots) onBotsUpdated(res.bots);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusyTaskId(undefined);
    }
  };

  return (
    <div className="bot-panel-scroll" data-testid="bot-tasks-panel">
      <div className="bot-panel-header">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Clock className="size-4 text-primary" />
            <span>{t("后台任务与主动提醒", "Background Tasks & Proactive Reminders")}</span>
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "像 Grok Bot / 小豆一样让智能体 7×24 在后台定时巡检、写早报或到点提醒你，结果会主动推送到桌面端与手机 App。",
              "Schedule recurring briefs, heartbeats, or one-time reminders. Results push directly to Desktop & Mobile App.",
            )}
          </p>
        </div>
        <Button size="sm" onClick={() => openCreate()}>
          <Plus data-icon="inline-start" />
          {t("新建任务", "New Task")}
        </Button>
      </div>

      <div className="bot-preset-strip">
        <span className="text-xs text-muted-foreground shrink-0">
          {t("快速模板：", "Quick presets:")}
        </span>
        {TASK_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-slot="bot-control"
            className="bot-preset-chip"
            onClick={() => openCreate(preset)}
          >
            <Sparkles className="size-3 text-primary" />
            <span>{language === "zh" ? preset.nameZh : preset.nameEn}</span>
          </button>
        ))}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {bot.tasks.length === 0 ? (
        <div className="bot-panel-empty">
          <BellRing className="size-7 text-muted-foreground/60" />
          <div className="grid gap-1 text-center max-w-md">
            <strong className="text-sm">{t("暂无后台任务", "No background tasks yet")}</strong>
            <span className="text-xs text-muted-foreground">
              {t(
                "点击上方模板或「新建任务」，也可以直接在对话里对 Bot 说“每天早上 8 点给我总结工作待办”。",
                "Pick a quick preset above, click New Task, or simply ask the Bot in chat to schedule a reminder.",
              )}
            </span>
          </div>
        </div>
      ) : (
        <div className="bot-card-grid">
          {bot.tasks.map((task) => {
            const busy = busyTaskId === task.id;
            return (
              <article key={task.id} className="bot-task-card" data-status={task.status}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 grid gap-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <strong className="text-sm font-semibold text-foreground truncate">
                        {task.name}
                      </strong>
                      <Badge variant="secondary" className="h-4.5 px-1.5 text-[10px]">
                        {kindLabel(task.kind, t)}
                      </Badge>
                      <Badge
                        variant={
                          task.status === "enabled"
                            ? "default"
                            : task.status === "paused"
                              ? "outline"
                              : "secondary"
                        }
                        className="h-4.5 px-1.5 text-[10px]"
                      >
                        {task.status === "enabled"
                          ? t("运行中", "Active")
                          : task.status === "paused"
                            ? t("已暂停", "Paused")
                            : t("已完成", "Done")}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{task.prompt}</p>
                  </div>
                </div>

                <div className="bot-task-meta-row">
                  <span>{formatBotScheduleSummary(task, t)}</span>
                  {task.status === "enabled" && (
                    <span>
                      · {t("下次", "Next")}: {formatNextRunRelative(task.nextRunAt, t)}
                    </span>
                  )}
                  <span>
                    ·{" "}
                    {task.delivery === "primary_thread"
                      ? t("投递到主对话", "To Primary")
                      : t("新建分支话题", "New Side Chat")}
                  </span>
                  {task.notifyFeishuChatId && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      {t("同步飞书", "Feishu push")}
                    </Badge>
                  )}
                </div>

                {(task.lastSummary || task.lastError) && (
                  <div className="bot-task-summary" data-error={Boolean(task.lastError)}>
                    <span className="font-medium">
                      {task.lastError
                        ? t("上次异常：", "Last error: ")
                        : t("最近结果：", "Last summary: ")}
                    </span>
                    <span>{task.lastError || task.lastSummary}</span>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1 border-t border-border/60">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => void runTaskAction(task.id, "task.run")}
                  >
                    {busy ? <Spinner className="size-3" /> : <Rocket className="size-3" />}
                    {t("立即运行", "Run now")}
                  </Button>
                  {task.status === "enabled" ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => void runTaskAction(task.id, "task.pause")}
                    >
                      <Pause className="size-3" />
                      {t("暂停", "Pause")}
                    </Button>
                  ) : task.status === "paused" ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => void runTaskAction(task.id, "task.resume")}
                    >
                      <Play className="size-3" />
                      {t("恢复", "Resume")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="xs" disabled={busy} onClick={() => openEdit(task)}>
                    <Pencil className="size-3" />
                    {t("编辑", "Edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => void runTaskAction(task.id, "task.delete")}
                  >
                    <Trash2 className="size-3" />
                    {t("删除", "Delete")}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(next) => { if (!saving) setDialogOpen(next); }}>
        <DialogContent className="sm:max-w-[520px] grid gap-4">
          <div className="grid gap-1">
            <DialogTitle>
              {editingTask ? t("编辑后台任务", "Edit Background Task") : t("新建后台任务 / 提醒", "New Task / Reminder")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "任务由本地 Daemon 后台定时触发，并主动将执行摘要推送到桌面端与手机 App。",
                "Triggered by the local daemon in the background and pushed to Desktop & Mobile App.",
              )}
            </DialogDescription>
          </div>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium">{t("任务名称", "Task Name")}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("例如：每日早报 / 竞品价格巡检", "e.g., Daily Brief / Price Watch")}
              />
            </div>

            <div className="grid gap-1.5">
              <label className="text-xs font-medium">{t("执行指令", "Prompt")}</label>
              <Textarea
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("描述 Bot 到点后要替你做什么…", "What should the Bot do when triggered?")}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <label className="text-xs font-medium">{t("调度类型", "Type")}</label>
                <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as BotTaskKind)}>
                  <NativeSelectOption value="cron">{t("定时周期 (Cron)", "Recurring Cron")}</NativeSelectOption>
                  <NativeSelectOption value="heartbeat">{t("心跳巡检 (Heartbeat)", "Heartbeat")}</NativeSelectOption>
                  <NativeSelectOption value="one_shot">{t("一次性提醒", "One-time Reminder")}</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <label className="text-xs font-medium">{t("结果投递位置", "Delivery Target")}</label>
                <NativeSelect
                  value={delivery}
                  onChange={(e) => setDelivery(e.target.value as BotTaskDelivery)}
                >
                  <NativeSelectOption value="primary_thread">{t("主对话流（永续）", "Primary Thread")}</NativeSelectOption>
                  <NativeSelectOption value="new_side_chat">{t("每次新建分支话题", "New Side Chat")}</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>

            {kind === "one_shot" ? (
              <div className="grid gap-1.5">
                <label className="text-xs font-medium">{t("提醒时间", "Reminder Date & Time")}</label>
                <Input
                  type="datetime-local"
                  value={runAtLocal}
                  onChange={(e) => setRunAtLocal(e.target.value)}
                />
              </div>
            ) : (
              <div className="grid gap-1.5">
                <label className="text-xs font-medium">{t("周期规则 (RRULE)", "Schedule Rule (RRULE)")}</label>
                <Input
                  value={rrule}
                  onChange={(e) => setRrule(e.target.value)}
                  placeholder="FREQ=DAILY;BYHOUR=8;BYMINUTE=0"
                />
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div className="grid gap-0.5">
                <span className="text-xs font-medium">{t("App 主动推送提醒", "Push Proactive App Alert")}</span>
                <span className="text-[11px] text-muted-foreground">
                  {t("完成后在桌面端和手机端标红并弹窗通知", "Show unread badge & alert on Desktop & Mobile")}
                </span>
              </div>
              <Switch checked={notifyApp} onCheckedChange={setNotifyApp} />
            </div>

            {bot.feishu.enabled && (
              <div className="grid gap-1.5">
                <label className="text-xs font-medium">
                  {t("可选：同步推送到飞书群/私聊", "Optional: Also push to Feishu chat")}
                </label>
                <Input
                  value={feishuChatId}
                  onChange={(e) => setFeishuChatId(e.target.value)}
                  list={`feishu-chats-${bot.id}`}
                  placeholder={t("留空则仅推送桌面与手机 App", "Leave blank for App-only push")}
                />
                {feishuChats.length > 0 && (
                  <datalist id={`feishu-chats-${bot.id}`}>
                    {feishuChats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </datalist>
                )}
              </div>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={saving} onClick={() => setDialogOpen(false)}>
              {t("取消", "Cancel")}
            </Button>
            <Button disabled={saving || !name.trim() || !prompt.trim()} onClick={() => void submitForm()}>
              {saving && <Spinner data-icon="inline-start" />}
              {editingTask ? t("保存修改", "Save Changes") : t("创建任务", "Create Task")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
