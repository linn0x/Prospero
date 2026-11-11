import { ConversationTurn, INITIAL_DIFF_LINE_LIMIT } from "./chat/ConversationTurn";
import { usePagedTimeline } from "./use-paged-timeline";
import { TimelineBodyDialog } from "./TimelineBodyDialog";
import { conversationTurns } from "./chat/conversation-turns";
import { MarkdownContent } from "./chat/MarkdownContent";
import { ConversationRail } from "./chat/ConversationRail";
import { chatDisplayItems, historyEndForItem } from "./chat/display";
import { useConversationFont } from "./chat/use-conversation-font";
import { supportsTrajectory } from "./workspace/dock-state";
import { isProsperoBotSession, PROSPERO_BOT_SESSION_STORAGE_KEY, PROSPERO_BOT_TITLE } from "./workspace/session-presentation";
import { createPortal } from "react-dom";
import { notify } from "./notifications/notifications";
import { ModelSwitcher } from "./workspace/ModelSwitcher";
import { modelSwitchSupported } from "./workspace/model-catalog";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject, type UIEvent } from "react";
import { Bot, Check, ChevronDown, CircleAlert, Clock3, Code2, Copy, ExternalLink, FileImage, FolderKanban, ListChecks, Paperclip, Send, Settings, ShieldAlert, Sparkles, Target, Trash2, UserRound, X, Workflow } from "lucide-react";
import type { AgentModeCatalog, AgentModel, DesktopSnapshot, JsonObject, SessionCreateInput, SessionInfo, SkillSuggestion } from "../../shared/types";
import { defaultSessionLaunchAccountId, sessionLaunchAccounts, sessionLaunchWorkspaces } from "../../shared/session-launch-options";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { array, displayError, isMissingSessionError, reportError, number, record, text } from "./state";
import { useLocale } from "./locale";
import { terminalPlainText } from "./terminal-text";
import { SourceSelector } from "./model-sources/SourceSelector";
import { selectedSourceRoute, type SourceRuntimeAgent, type SourceSelection } from "./model-sources/source-state";
import { runModelSourceAction, useModelSources } from "./model-sources/use-model-sources";
import {
  CHAT_TIMELINE_WINDOW_SIZE,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_NAME_LENGTH,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_CHAT_DRAFT_LENGTH,
  ChatEventAccumulator,
  collapseChatEventHistory,
  getChatAttachmentSelectionIssue,
  getChatComposerKeyAction,
  getChatPollReconnectDelay,
  getChatTimelineItemWindow,
  getNextChatSkillIndex,
  hasChatResolution,
  isChatViewportNearEnd,
  limitChatDraftText,
  loadChatDraft,
  mergeFailedChatDraft,
  persistChatDraft,
  updateChatHistoryCursorFromScroll,
  type ChatHistoryCursor,
  type ChatTimelineItem,
} from "./chat-events";

function DiffBlock({ value }: { value: unknown }) {
  const { t } = useLocale();
  const diff = record(value);
  const patch = text(diff.patch);
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => (patch ? patch.split("\n") : []), [patch]);
  if (!patch) return null;
  const truncated = !expanded && lines.length > INITIAL_DIFF_LINE_LIMIT;
  const visiblePatch = truncated ? lines.slice(0, INITIAL_DIFF_LINE_LIMIT).join("\n") : patch;
  const remaining = Math.max(0, lines.length - INITIAL_DIFF_LINE_LIMIT);
  return <Collapsible className="flex flex-col gap-2"><CollapsibleTrigger render={<Button variant="outline" size="sm" />}><ChevronDown data-icon="inline-start" />{text(diff.path, t("文件改动", "File changes"))}<Badge variant="secondary">+{number(diff.additions)} −{number(diff.deletions)}</Badge></CollapsibleTrigger><CollapsibleContent><div className="flex flex-col gap-2"><pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">{visiblePatch}</pre>{truncated && <Button variant="ghost" size="xs" className="w-fit" onClick={() => setExpanded(true)}>{t(`展开全部 ${lines.length} 行`, `Show remaining ${remaining} lines`)}</Button>}</div></CollapsibleContent></Collapsible>;
}

const QuestionCard = memo(function QuestionCard({ event, isDone, sessionId, onError }: { event: JsonObject; isDone: boolean; sessionId: string; onError: (message?: string) => void }) {
  const { t } = useLocale();
  const reqId = text(event.reqId);
  const labelPrefix = useId();
  const questions = array(event.questions).map(record);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const canSubmit = questions.every((question) => (selections[text(question.id)] ?? []).length || (other[text(question.id)] ?? "").trim());
  const reply = async (cancelled = false): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const answers = cancelled ? [] : questions.map((question) => {
        const id = text(question.id); const custom = (other[id] ?? "").trim();
        return { questionId: id, values: [...(selections[id] ?? []), ...(custom ? [custom] : [])] };
      }).filter((answer) => answer.values.length);
      await window.prospero.interact(sessionId, { type: "question.respond", reqId, answers, ...(cancelled ? { cancelled: true } : {}) });
    } catch (reason) { onError(reportError(reason)); } finally { busyRef.current = false; setBusy(false); }
  };
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><CircleAlert className="size-4" />{t("Agent 需要你的选择", "Agent needs your input")}</CardTitle><CardDescription>{t("完成以下问题后，Agent 会继续当前任务。", "Answer the questions below and the agent will continue.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">{questions.map((question, index) => {
    const id = text(question.id);
    const labelId = `${labelPrefix}-${String(index)}`;
    return <section className="flex flex-col gap-3" key={id}>{text(question.header) && <Badge variant="outline" className="w-fit">{text(question.header)}</Badge>}<strong id={labelId}>{text(question.question)}</strong>{!isDone && <><ToggleGroup aria-labelledby={labelId} value={selections[id] ?? []} multiple={question.multiSelect === true} onValueChange={(values) => setSelections((current) => ({ ...current, [id]: values }))} variant="outline" className="grid grid-cols-1 gap-2 md:grid-cols-2">{array(question.options).map(record).map((option) => <ToggleGroupItem value={text(option.label)} key={text(option.label)} className="h-auto min-w-0 items-start justify-start py-3 text-left"><span className="flex min-w-0 flex-col gap-1"><b>{text(option.label)}</b><small className="text-muted-foreground">{text(option.description, text(option.preview))}</small></span></ToggleGroupItem>)}</ToggleGroup>{question.allowOther === true && <Input aria-labelledby={labelId} type={question.secret === true ? "password" : "text"} value={other[id] ?? ""} onChange={(input) => setOther((current) => ({ ...current, [id]: input.target.value }))} placeholder={t("其他回答", "Other answer")} autoComplete="off" />}</>}</section>;
  })}{isDone && <Badge variant="secondary" className="w-fit"><Check />{t("已回答", "Answered")}</Badge>}</CardContent>{!isDone && <CardFooter className="justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => void reply(true)}>{t("取消问题", "Cancel questions")}</Button><Button disabled={busy || !canSubmit} onClick={() => void reply()}>{busy && <Spinner data-icon="inline-start" />}{t("提交回答", "Submit answers")}</Button></CardFooter>}</Card>;
});

const ToolCard = memo(function ToolCard({ event, openOutput, compact = false }: { event: JsonObject; openOutput: (id: string, tool: string) => void; compact?: boolean }) {
  const { t, status } = useLocale();
  const kind = text(event.kind); const state = text(event.state, kind === "tool.start" ? "running" : "success"); const callId = text(event.callId);
  const summary = terminalPlainText(text(event.summary, state === "running" ? t("正在执行…", "Running…") : t("执行完成", "Completed")));
  if (compact) return <div className="trajectory-tool">
    <div className="trajectory-tool-heading"><Code2 /><span>{text(event.tool, t("工具调用", "Tool call"))}</span><small data-failed={state === "error" || state === "failed" || undefined}>{status(state)}</small></div>
    <p className="terminal-output-text">{summary}</p>
    <DiffBlock value={event.diff} />
    {kind === "tool.end" && event.hasMore === true && callId && <Button variant="ghost" size="xs" onClick={() => openOutput(callId, text(event.tool))}><ExternalLink />{t("查看输出", "View output")}</Button>}
  </div>;
  return <Card size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><Code2 className="size-4" />{text(event.tool, t("工具调用", "Tool call"))}</CardTitle><CardDescription className="terminal-output-text">{summary}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><DiffBlock value={event.diff} />{kind === "tool.end" && event.hasMore === true && callId && <Button variant="outline" size="sm" className="w-fit" onClick={() => openOutput(callId, text(event.tool, t("工具输出", "Tool output")))}><ExternalLink data-icon="inline-start" />{t("查看输出", "View output")}</Button>}</CardContent><CardFooter><Badge variant={state === "error" || state === "failed" ? "destructive" : "secondary"}>{status(state)}</Badge></CardFooter></Card>;
});

const PermissionCard = memo(function PermissionCard({ event, isDone, sessionId, onError }: { event: JsonObject; isDone: boolean; sessionId: string; onError: (message?: string) => void }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState<string>();
  const busyRef = useRef(false);
  const reply = async (value: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(value);
    try {
      await window.prospero.interact(sessionId, { type: "permission.respond", reqId: text(event.reqId), reply: value });
    } catch (reason) {
      onError(reportError(reason));
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  };
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldAlert className="size-4" />{text(event.summary, t("Agent 请求权限", "Agent requests permission"))}</CardTitle><CardDescription>{t("请确认这项操作是否可以继续。", "Confirm whether this operation may continue.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{array(event.resources).length > 0 && <pre className="rounded-lg bg-muted p-3 text-xs">{array(event.resources).map(String).join("\n")}</pre>}<DiffBlock value={event.diff} />{isDone && <Badge variant="secondary" className="w-fit"><Check />{t("已处理", "Resolved")}</Badge>}</CardContent>{!isDone && <CardFooter className="justify-end gap-2"><Button variant="destructive" disabled={Boolean(busy)} onClick={() => void reply("reject")}>{busy === "reject" && <Spinner data-icon="inline-start" />}{t("拒绝", "Reject")}</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => void reply("always")}>{busy === "always" && <Spinner data-icon="inline-start" />}{t("本会话允许", "Allow for session")}</Button><Button disabled={Boolean(busy)} onClick={() => void reply("once")}>{busy === "once" && <Spinner data-icon="inline-start" />}{t("允许一次", "Allow once")}</Button></CardFooter>}</Card>;
});

type EventProps = { event: JsonObject; projectRoot?: string | undefined; isResolved: boolean; streaming?: boolean | undefined; sessionId: string; onError: (message?: string) => void; openOutput: (id: string, tool: string) => void; openSubagent: (id: string, label: string) => void; onOpenSession?: ((id: string) => void) | undefined };

type ChildDispatchAgent = "codex" | "claude" | "opencode" | "pi" | "deepseek" | "agy";

function CrossModelChildLauncher({ session, snapshot, onCreated, onError }: { session: SessionInfo; snapshot?: DesktopSnapshot | undefined; onCreated: (id: string, jump?: boolean) => void; onError: (message: string) => void }) {
  const { t } = useLocale();
  const supported = typeof window.prospero.createCrossModelChild === "function";
  const isBot = isProsperoBotSession(session);
  const [open, setOpen] = useState(false);
  const independentAccounts = useMemo(
    () => (snapshot?.accounts ?? []).filter((account) => !account["modelSource"] && !account["apiProfile"] && !account["apiProfileError"]),
    [snapshot?.accounts],
  );
  const [useSource, setUseSource] = useState(() => independentAccounts.length === 0);
  const sourceState = useModelSources(supported && open && useSource);
  const [agent, setAgent] = useState<ChildDispatchAgent>("codex");
  const sourceAgent: SourceRuntimeAgent =
    agent === "codex" || agent === "claude" || agent === "opencode" || agent === "pi" ? agent : "codex";
  const [workspace, setWorkspace] = useState(session.cwd);
  const [accountId, setAccountId] = useState<string | undefined>(() =>
    defaultSessionLaunchAccountId(independentAccounts, "codex"),
  );
  const [launchModels, setLaunchModels] = useState<AgentModel[]>([]);
  const [launchModelsLoading, setLaunchModelsLoading] = useState(false);
  const [model, setModel] = useState<string | undefined>();
  const [effort, setEffort] = useState<string | undefined>();
  const [selection, setSelection] = useState<SourceSelection>();
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);

  const workspaces = useMemo(() => {
    const list = snapshot ? sessionLaunchWorkspaces(snapshot) : [];
    if (session.cwd && !list.some((item) => item.path === session.cwd)) {
      const name = session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? session.cwd;
      return [{ path: session.cwd, label: name, detail: session.cwd, kind: "project" as const }, ...list];
    }
    return list;
  }, [session.cwd, snapshot]);

  useEffect(() => {
    if (open && (!workspace || !workspaces.some((item) => item.path === workspace))) {
      setWorkspace(session.cwd || workspaces[0]?.path || "");
    }
  }, [open, session.cwd, workspace, workspaces]);

  const launchAccounts = useMemo(
    () => sessionLaunchAccounts(independentAccounts, agent),
    [agent, independentAccounts],
  );

  useEffect(() => {
    if (!open || useSource) return;
    if (!accountId || !launchAccounts.some((item) => item.id === accountId)) {
      setAccountId(defaultSessionLaunchAccountId(independentAccounts, agent));
    }
  }, [accountId, agent, independentAccounts, launchAccounts, open, useSource]);

  useEffect(() => {
    if (!open || useSource || typeof window.prospero.getLaunchModels !== "function") {
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
        setLaunchModels(catalog.models);
        setModel((current) => {
          const matched = catalog.models.find((item) => item.id === current);
          const fallback =
            matched ??
            catalog.models.find((item) => item.id === catalog.currentModel) ??
            catalog.models.find((item) => item.isDefault) ??
            catalog.models[0];
          setEffort(
            fallback?.defaultEffort ??
              (catalog.currentEffort && fallback?.supportedEfforts.includes(catalog.currentEffort)
                ? catalog.currentEffort
                : fallback?.supportedEfforts[0]),
          );
          return fallback?.id;
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

  const choice = selectedSourceRoute(sourceState.sources, selection, sourceAgent);
  const selectedLaunchModel = launchModels.find((item) => item.id === model);
  const canLaunch = Boolean(
    task.trim() &&
      !busy &&
      (useSource ? choice && selection : agent === "opencode" || launchAccounts.length > 0),
  );

  if (!supported || session.kind !== "structured") return null;

  const launch = async (jump = false): Promise<void> => {
    if (!canLaunch) return;
    setBusy(true);
    try {
      const targetWorkspace = workspace && workspace !== session.cwd ? workspace : undefined;
      const result = useSource && selection
        ? await window.prospero.createCrossModelChild(session.id, {
            sourceId: selection.sourceId,
            routeId: selection.routeId,
            revision: selection.revision,
            agent: sourceAgent,
            task: task.trim(),
            ...(targetWorkspace ? { workspace: targetWorkspace } : {}),
          })
        : await window.prospero.createCrossModelChild(session.id, {
            agent,
            task: task.trim(),
            ...(targetWorkspace ? { workspace: targetWorkspace } : {}),
            ...(accountId ? { accountId } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
      const id = text(result["sessionId"]);
      if (!id) throw new Error(t("子 Agent 创建没有返回会话 ID", "Child agent creation did not return a session id"));
      setTask("");
      setOpen(false);
      onCreated(id, jump);
    } catch (reason) {
      onError(reportError(reason));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Button variant={isBot ? "secondary" : "outline"} size="sm" onClick={() => setOpen(true)}>
      <Workflow data-icon="inline-start" />
      {isBot ? t("派发工作区会话", "Dispatch workspace session") : t("跨模型子 Agent", "Cross-model child")}
    </Button>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("派发跨工作区 / 跨模型子会话", "Dispatch cross-workspace / cross-model child session")}</DialogTitle>
          <DialogDescription>
            {t(
              "可指定任意工作区、订阅账号（含 Codex Daybreak Blue）或 API 模型源启动独立 structured 会话（YOLO 自动批准），完成后自动将结果回传主会话。",
              "Launch an independent YOLO structured session in any workspace using a subscription account or API model source; its summary fans back into this session.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {workspaces.length > 0 && (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="child-dispatch-workspace">
                {t("目标工作区", "Target workspace")}
              </label>
              <NativeSelect
                id="child-dispatch-workspace"
                value={workspace}
                disabled={busy}
                aria-label={t("目标工作区", "Target workspace")}
                onChange={(event) => setWorkspace(event.target.value)}
              >
                {workspaces.map((item) => (
                  <NativeSelectOption key={item.path} value={item.path}>
                    {item.label} ({item.path})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {independentAccounts.length > 0 && (
            <div className="model-source-session-mode" role="group" aria-label={t("模型连接方式", "Model connection")}>
              <Button
                data-liquid-glass="tab"
                variant={!useSource ? "secondary" : "ghost"}
                aria-pressed={!useSource}
                disabled={busy}
                onClick={() => setUseSource(false)}
              >
                {t("订阅登录态", "Subscription login")}
              </Button>
              <Button
                data-liquid-glass="tab"
                variant={useSource ? "secondary" : "ghost"}
                aria-pressed={useSource}
                disabled={busy}
                onClick={() => {
                  if (agent === "deepseek" || agent === "agy") setAgent("codex");
                  setUseSource(true);
                }}
              >
                {t("API 模型源", "API model source")}
              </Button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="child-dispatch-agent">
                {t("子 Agent 类型", "Child agent runtime")}
              </label>
              <NativeSelect
                id="child-dispatch-agent"
                value={useSource ? sourceAgent : agent}
                disabled={busy}
                aria-label={t("子 Agent 类型", "Child agent runtime")}
                onChange={(event) => {
                  const nextAgent = event.target.value as ChildDispatchAgent;
                  setAgent(nextAgent);
                  setSelection(undefined);
                  setAccountId(defaultSessionLaunchAccountId(independentAccounts, nextAgent));
                  setModel(undefined);
                  setEffort(undefined);
                }}
              >
                <NativeSelectOption value="codex">Codex</NativeSelectOption>
                <NativeSelectOption value="claude">Claude Code</NativeSelectOption>
                <NativeSelectOption value="opencode">OpenCode</NativeSelectOption>
                <NativeSelectOption value="pi">Pi</NativeSelectOption>
                {!useSource && <NativeSelectOption value="agy">Antigravity (agy)</NativeSelectOption>}
                {!useSource && <NativeSelectOption value="deepseek">DeepSeek</NativeSelectOption>}
              </NativeSelect>
            </div>
            {!useSource && (
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="child-dispatch-account">
                  {t("订阅账号", "Subscription account")}
                </label>
                <NativeSelect
                  id="child-dispatch-account"
                  value={accountId ?? ""}
                  disabled={busy}
                  aria-label={t("订阅账号", "Subscription account")}
                  onChange={(event) => {
                    setAccountId(event.target.value || undefined);
                    setModel(undefined);
                    setEffort(undefined);
                  }}
                >
                  {agent === "opencode" && (
                    <NativeSelectOption value="">{t("本机 OpenCode CLI", "Local OpenCode CLI")}</NativeSelectOption>
                  )}
                  {launchAccounts.map((acc) => (
                    <NativeSelectOption key={acc.id} value={acc.id}>
                      {acc.name}{acc.isDefault ? t("（默认）", " (default)") : ""}
                    </NativeSelectOption>
                  ))}
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
              onChange={setSelection}
              onRefresh={() => void sourceState.refresh()}
              disabled={busy}
            />
          ) : (
            launchModels.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="child-dispatch-model">
                    {t("模型", "Model")}
                  </label>
                  <NativeSelect
                    id="child-dispatch-model"
                    value={model ?? ""}
                    disabled={busy || launchModelsLoading}
                    aria-label={t("模型", "Model")}
                    onChange={(event) => {
                      const nextModel = launchModels.find((item) => item.id === event.target.value);
                      setModel(nextModel?.id);
                      setEffort(nextModel?.defaultEffort ?? nextModel?.supportedEfforts[0]);
                    }}
                  >
                    {launchModels.map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {item.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                {Boolean(selectedLaunchModel?.supportedEfforts.length) && (
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="child-dispatch-effort">
                      {t("推理强度", "Reasoning effort")}
                    </label>
                    <NativeSelect
                      id="child-dispatch-effort"
                      value={effort ?? ""}
                      disabled={busy}
                      aria-label={t("推理强度", "Reasoning effort")}
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
            )
          )}
          <InputGroup>
            <InputGroupTextarea
              value={task}
              maxLength={65_536}
              rows={5}
              aria-label={t("子任务", "Child task")}
              placeholder={t(
                "描述要派发到目标工作区执行的完整任务，完成后摘要将自动回传当前会话…",
                "Describe the task to dispatch to the target workspace; its summary will return here…",
              )}
              onChange={(event) => setTask(event.target.value)}
            />
          </InputGroup>
          {(useSource ? choice : true) && (
            <p className="text-xs text-muted-foreground">
              {t("目标：", "Target: ")}
              {workspace ? `${workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace} · ` : ""}
              {useSource && choice
                ? `${choice.source.name} / ${choice.route.model}`
                : `${agent}${selectedLaunchModel ? ` / ${selectedLaunchModel.label}` : ""}`}
              {" · "}
              {t("YOLO 自动批准", "YOLO auto-approval")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button variant="secondary" disabled={!canLaunch} onClick={() => void launch(true)}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("派发并打开会话", "Dispatch & open")}
          </Button>
          <Button disabled={!canLaunch} onClick={() => void launch(false)}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("派发子任务", "Dispatch child")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function MasterHarnessConfigDialog({ session, account, snapshot, onSwitched, onError }: { session: SessionInfo; account?: JsonObject | undefined; snapshot?: DesktopSnapshot | undefined; onSwitched?: ((session: SessionInfo) => void) | undefined; onError: (message: string) => void }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const independentAccounts = useMemo(
    () => (snapshot?.accounts ?? []).filter((item) => !item["modelSource"] && !item["apiProfile"] && !item["apiProfileError"]),
    [snapshot?.accounts],
  );
  const initialUseSource = Boolean(account?.["modelSource"]);
  const [useSource, setUseSource] = useState(initialUseSource);
  const sourceState = useModelSources(open && useSource);
  const initialAgent: ChildDispatchAgent =
    ["codex", "claude", "opencode", "pi", "deepseek", "agy"].includes(session.agent)
      ? (session.agent as ChildDispatchAgent)
      : "codex";
  const [agent, setAgent] = useState<ChildDispatchAgent>(initialAgent);
  const sourceAgent: SourceRuntimeAgent =
    agent === "codex" || agent === "claude" || agent === "opencode" || agent === "pi" ? agent : "codex";
  const [workspace, setWorkspace] = useState(session.cwd);
  const [accountId, setAccountId] = useState<string | undefined>(
    session.accountId ?? defaultSessionLaunchAccountId(independentAccounts, initialAgent),
  );
  const [launchModels, setLaunchModels] = useState<AgentModel[]>([]);
  const [launchModelsLoading, setLaunchModelsLoading] = useState(false);
  const [model, setModel] = useState<string | undefined>(
    session.agentControls?.currentModel ?? session.model ?? (initialAgent === "codex" ? "gpt-6-astra" : undefined),
  );
  const [customModel, setCustomModel] = useState("");
  const [effort, setEffort] = useState<string | undefined>(
    session.agentControls?.currentEffort ?? session.effort,
  );
  const [selection, setSelection] = useState<SourceSelection>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const nextAgent: ChildDispatchAgent =
      ["codex", "claude", "opencode", "pi", "deepseek", "agy"].includes(session.agent)
        ? (session.agent as ChildDispatchAgent)
        : "codex";
    setAgent(nextAgent);
    setUseSource(Boolean(account?.["modelSource"]));
    setWorkspace(session.cwd);
    setAccountId(session.accountId ?? defaultSessionLaunchAccountId(independentAccounts, nextAgent));
    setModel(session.agentControls?.currentModel ?? session.model ?? (nextAgent === "codex" ? "gpt-6-astra" : undefined));
    setCustomModel("");
    setEffort(session.agentControls?.currentEffort ?? session.effort);
  }, [account, independentAccounts, open, session.accountId, session.agent, session.agentControls?.currentEffort, session.agentControls?.currentModel, session.cwd, session.effort, session.model]);

  const workspaces = useMemo(() => {
    const list = snapshot ? sessionLaunchWorkspaces(snapshot) : [];
    if (session.cwd && !list.some((item) => item.path === session.cwd)) {
      const name = session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? session.cwd;
      return [{ path: session.cwd, label: name, detail: session.cwd, kind: "project" as const }, ...list];
    }
    return list;
  }, [session.cwd, snapshot]);

  const launchAccounts = useMemo(
    () => sessionLaunchAccounts(independentAccounts, agent),
    [agent, independentAccounts],
  );

  useEffect(() => {
    if (!open || useSource) return;
    if (!accountId || !launchAccounts.some((item) => item.id === accountId)) {
      setAccountId(defaultSessionLaunchAccountId(independentAccounts, agent));
    }
  }, [accountId, agent, independentAccounts, launchAccounts, open, useSource]);

  useEffect(() => {
    if (!open || useSource || typeof window.prospero.getLaunchModels !== "function") {
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
          return fallback?.id;
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

  const choice = selectedSourceRoute(sourceState.sources, selection, sourceAgent);
  const selectedLaunchModel = launchModels.find((item) => item.id === model);
  const effectiveModel = customModel.trim() || model;
  const canApply = Boolean(
    !busy &&
      workspace &&
      (useSource ? choice && selection : agent === "opencode" || launchAccounts.length > 0 || Boolean(effectiveModel)),
  );

  const applyConfig = async (): Promise<void> => {
    if (!canApply) return;
    setBusy(true);
    try {
      const sameHarnessAndWorkspace =
        !useSource &&
        agent === session.agent &&
        (accountId ?? undefined) === (session.accountId ?? undefined) &&
        workspace === session.cwd;
      if (sameHarnessAndWorkspace && effectiveModel && modelSwitchSupported(session, account)) {
        await window.prospero.setAgentModel(session.id, effectiveModel, effort);
        onSwitched?.({
          ...session,
          model: effectiveModel,
          ...(effort ? { effort } : {}),
          agentControls: session.agentControls
            ? {
                ...session.agentControls,
                currentModel: effectiveModel,
                ...(effort ? { currentEffort: effort } : {}),
              }
            : {
                compact: true,
                model: true,
                mode: true,
                currentModel: effectiveModel,
                ...(effort ? { currentEffort: effort } : {}),
              },
        });
        setOpen(false);
        return;
      }

      let created: SessionInfo;
      if (useSource) {
        if (!choice || !selection) throw new Error(t("请选择有效的模型源和模型。", "Choose a valid model source and model."));
        const bound = await runModelSourceAction({
          kind: "bind",
          sourceId: choice.source.id,
          routeId: choice.route.id,
          revision: choice.source.revision,
          agent: sourceAgent,
        });
        if (!bound.accountId) throw new Error(t("模型源没有返回会话绑定。", "The source did not return an account binding."));
        const routeEfforts =
          choice.route.protocol !== "openai_chat_completions"
            ? (choice.route.modelCapabilities?.supportedEfforts ?? [])
            : [];
        const sessionEffort =
          (effort && routeEfforts.includes(effort as never) ? effort : undefined) ??
          choice.route.defaultEffort;
        created = await window.prospero.createSession({
          cwd: workspace || session.cwd,
          agent: sourceAgent,
          accountId: bound.accountId,
          kind: "structured",
          approvalPolicy: "yolo",
          ...(sessionEffort ? { effort: sessionEffort as SessionCreateInput["effort"] } : {}),
        });
      } else {
        created = await window.prospero.createSession({
          cwd: workspace || session.cwd,
          agent,
          kind: "structured",
          approvalPolicy: "yolo",
          ...(accountId ? { accountId } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effort ? { effort: effort as SessionCreateInput["effort"] } : {}),
        });
      }
      await window.prospero.renameSession(created.id, PROSPERO_BOT_TITLE).catch(() => undefined);
      try {
        localStorage.setItem(PROSPERO_BOT_SESSION_STORAGE_KEY, created.id);
      } catch {}
      const named: SessionInfo = {
        ...created,
        title: PROSPERO_BOT_TITLE,
        displayTitle: PROSPERO_BOT_TITLE,
        ...(effectiveModel && !useSource ? { model: effectiveModel } : {}),
        ...(effort ? { effort } : {}),
      };
      onSwitched?.(named);
      setOpen(false);
    } catch (reason) {
      onError(reportError(reason));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="master-harness-config-button">
      <Settings data-icon="inline-start" />
      {t("修改模型 / Harness", "Model & Harness")}
    </Button>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("配置主会话 Harness 与模型", "Configure Master Session Harness & Model")}</DialogTitle>
          <DialogDescription>
            {t(
              "自定义 Prospero Bot 主会话使用的 Harness（Codex / Claude / OpenCode / Pi / DeepSeek / AGY）、账号或外部模型源、模型（如 gpt-6-astra）及推理强度。",
              "Customize the Harness (Codex / Claude / OpenCode / Pi / DeepSeek / AGY), account or external model source, model (e.g. gpt-6-astra), and reasoning effort for the Prospero Bot Master Session.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {workspaces.length > 0 && (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="master-config-workspace">
                {t("主会话统筹工作区", "Master Session Workspace")}
              </label>
              <NativeSelect
                id="master-config-workspace"
                value={workspace}
                disabled={busy}
                aria-label={t("主会话统筹工作区", "Master Session Workspace")}
                onChange={(event) => setWorkspace(event.target.value)}
              >
                {workspaces.map((item) => (
                  <NativeSelectOption key={item.path} value={item.path}>
                    {item.label} ({item.detail})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("配置来源", "Configuration Source")}
            </span>
            <ToggleGroup
              value={[useSource ? "source" : "account"]}
              onValueChange={(values) => {
                if (values[0] === "account") setUseSource(false);
                if (values[0] === "source") setUseSource(true);
              }}
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="account">{t("订阅 / 账号", "Account / Subscription")}</ToggleGroupItem>
              <ToggleGroupItem value="source">{t("外部模型源", "External Model Source")}</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="master-config-harness">
                {t("Harness (Agent 运行时)", "Harness (Agent Runtime)")}
              </label>
              <NativeSelect
                id="master-config-harness"
                value={useSource ? sourceAgent : agent}
                disabled={busy}
                aria-label={t("Harness (Agent 运行时)", "Harness (Agent Runtime)")}
                onChange={(event) => {
                  const next = event.target.value as ChildDispatchAgent;
                  setAgent(next);
                  if (!useSource) {
                    setAccountId(defaultSessionLaunchAccountId(independentAccounts, next));
                    setModel(next === "codex" ? "gpt-6-astra" : undefined);
                  }
                }}
              >
                <NativeSelectOption value="codex">Codex</NativeSelectOption>
                <NativeSelectOption value="claude">Claude Code</NativeSelectOption>
                <NativeSelectOption value="opencode">OpenCode</NativeSelectOption>
                <NativeSelectOption value="pi">Pi</NativeSelectOption>
                {!useSource && <NativeSelectOption value="deepseek">DeepSeek</NativeSelectOption>}
                {!useSource && <NativeSelectOption value="agy">AGY</NativeSelectOption>}
              </NativeSelect>
            </div>
            {!useSource && launchAccounts.length > 0 && (
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="master-config-account">
                  {t("订阅 / 账号", "Subscription / Account")}
                </label>
                <NativeSelect
                  id="master-config-account"
                  value={accountId ?? ""}
                  disabled={busy}
                  aria-label={t("订阅 / 账号", "Subscription / Account")}
                  onChange={(event) => setAccountId(event.target.value || undefined)}
                >
                  {launchAccounts.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.name}
                    </NativeSelectOption>
                  ))}
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
              onChange={setSelection}
              onRefresh={() => void sourceState.refresh()}
              disabled={busy}
            />
          ) : (
            <div className="grid gap-3">
              {launchModels.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="master-config-model">
                      {t("模型", "Model")}
                    </label>
                    <NativeSelect
                      id="master-config-model"
                      value={model ?? ""}
                      disabled={busy || launchModelsLoading}
                      aria-label={t("模型", "Model")}
                      onChange={(event) => {
                        const nextModel = launchModels.find((item) => item.id === event.target.value);
                        setModel(nextModel?.id ?? event.target.value);
                        setCustomModel("");
                        setEffort(nextModel?.defaultEffort ?? nextModel?.supportedEfforts[0]);
                      }}
                    >
                      {launchModels.map((item) => (
                        <NativeSelectOption key={item.id} value={item.id}>
                          {item.label} ({item.id})
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  {Boolean(selectedLaunchModel?.supportedEfforts.length) && (
                    <div className="grid gap-1.5">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="master-config-effort">
                        {t("推理强度", "Reasoning Effort")}
                      </label>
                      <NativeSelect
                        id="master-config-effort"
                        value={effort ?? ""}
                        disabled={busy}
                        aria-label={t("推理强度", "Reasoning Effort")}
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
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="master-config-custom-model">
                  {t("自定义模型 ID（可选，如 gpt-6-astra / gpt-daybreak-blue-latest）", "Custom Model ID (optional, e.g. gpt-6-astra / gpt-daybreak-blue-latest)")}
                </label>
                <Input
                  id="master-config-custom-model"
                  value={customModel}
                  disabled={busy}
                  placeholder={model ?? "gpt-6-astra"}
                  onChange={(event) => setCustomModel(event.target.value)}
                />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button disabled={!canApply} onClick={() => void applyConfig()}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("应用到主会话", "Apply to Master Session")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
type SharedEventHandlers = Omit<EventProps, "event" | "isResolved" | "streaming">;

const TurnEntryCard = memo(function TurnEntryCard({
  entry,
  activity,
  turnCompleted,
  projectRoot,
  sessionId,
  onError,
  openOutput,
  openSubagent,
  onOpenSession,
}: SharedEventHandlers & { entry: JsonObject; activity: boolean; turnCompleted: boolean }) {
  const kind = text(entry.kind);
  const streaming = !turnCompleted;
  if (activity && kind === "reasoning" && entry.hasMore !== true) {
    return (
      <div className="chat-reasoning">
        <MarkdownContent value={text(entry.text)} onError={onError} projectRoot={projectRoot} streaming={streaming} />
      </div>
    );
  }
  if (activity && (kind === "tool.start" || kind === "tool.end")) {
    return <ToolCard compact event={entry} openOutput={openOutput} />;
  }
  return (
    <EventCard
      event={entry}
      isResolved={activity}
      streaming={streaming}
      projectRoot={projectRoot}
      sessionId={sessionId}
      onError={onError}
      openOutput={openOutput}
      openSubagent={openSubagent}
      onOpenSession={onOpenSession}
    />
  );
});

const TurnCardBody = memo(function TurnCardBody({
  event,
  projectRoot,
  sessionId,
  onError,
  openOutput,
  openSubagent,
  onOpenSession,
}: SharedEventHandlers & { event: JsonObject }) {
  const completed = event.completed === true;
  const renderTurnEvent = useCallback(
    (entry: JsonObject, activity?: boolean) => (
      <TurnEntryCard
        entry={entry}
        activity={Boolean(activity)}
        turnCompleted={completed}
        projectRoot={projectRoot}
        sessionId={sessionId}
        onError={onError}
        openOutput={openOutput}
        openSubagent={openSubagent}
        onOpenSession={onOpenSession}
      />
    ),
    [completed, projectRoot, sessionId, onError, openOutput, openSubagent, onOpenSession],
  );
  return <ConversationTurn event={event} projectRoot={projectRoot} renderEvent={renderTurnEvent} />;
});

const EventCardBody = memo(function EventCardBody(props: EventProps) {
  const { event, isResolved, streaming, sessionId, onError, openOutput, openSubagent, onOpenSession, projectRoot } = props;
  const { t, status } = useLocale();
  const kind = text(event.kind);
  if (kind === "conversation.turn") {
    return (
      <TurnCardBody
        event={event}
        projectRoot={projectRoot}
        sessionId={sessionId}
        onError={onError}
        openOutput={openOutput}
        openSubagent={openSubagent}
        onOpenSession={onOpenSession}
      />
    );
  }
  if (kind === "user.message") {
    const attachments = array(event.attachments).map(record);
    return <Message align="end"><MessageAvatar><Avatar><AvatarFallback><UserRound className="size-4" /></AvatarFallback></Avatar></MessageAvatar><MessageContent><MessageHeader>{t("你", "You")}</MessageHeader><Bubble align="end" variant="secondary"><BubbleContent className="grid gap-2 whitespace-pre-wrap">{text(event.text) && <MarkdownContent value={text(event.text)} onError={onError} projectRoot={projectRoot} streaming={false} />}{attachments.length > 0 && <AttachmentGroup>{attachments.map((attachment, index) => <Attachment state="done" size="sm" key={text(attachment.id, String(index))}><AttachmentMedia><FileImage /></AttachmentMedia><AttachmentContent><AttachmentTitle>{text(attachment.name, t(`图片 ${String(index + 1)}`, `Image ${String(index + 1)}`))}</AttachmentTitle><AttachmentDescription>{text(attachment.mimeType, t("图片", "Image"))}</AttachmentDescription></AttachmentContent></Attachment>)}</AttachmentGroup>}</BubbleContent></Bubble></MessageContent></Message>;
  }
  if (kind === "assistant.text") return <Message><MessageAvatar><Avatar><AvatarFallback><Bot className="size-4" /></AvatarFallback></Avatar></MessageAvatar><MessageContent><MessageHeader>Agent</MessageHeader><Bubble variant="ghost"><BubbleContent><MarkdownContent value={text(event.text)} onError={onError} projectRoot={projectRoot} streaming={streaming} /></BubbleContent></Bubble></MessageContent></Message>;
  if (kind === "reasoning") return <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" />}><ChevronDown data-icon="inline-start" />{t("思考过程", "Reasoning")}</CollapsibleTrigger><CollapsibleContent><div className="chat-reasoning mt-2 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-muted-foreground"><MarkdownContent value={text(event.text)} onError={onError} projectRoot={projectRoot} streaming={streaming} /></div></CollapsibleContent></Collapsible>;
  if (kind === "activity.group") return <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" />}><ChevronDown />{t(`已完成 ${array(event.events).length} 项操作`, `Completed ${array(event.events).length} actions`)}</CollapsibleTrigger><CollapsibleContent className="grid gap-3 pt-3">{array(event.events).map(record).map((entry, index) => <EventCard key={index} event={entry} isResolved streaming={false} sessionId={sessionId} onError={onError} openOutput={openOutput} openSubagent={openSubagent} onOpenSession={onOpenSession} />)}</CollapsibleContent></Collapsible>;
  if (kind === "tool.start" || kind === "tool.end") return <ToolCard event={event} openOutput={openOutput} />;
  if (kind === "permission.request") return <PermissionCard event={event} isDone={isResolved} sessionId={sessionId} onError={onError} />;
  if (kind === "permission.auto") return <Alert><ShieldAlert /><AlertTitle>{t("已按", "Automatically allowed by")} {text(event.policy, t("策略", "policy"))}</AlertTitle><AlertDescription>{text(event.summary)}</AlertDescription></Alert>;
  if (kind === "question.request") return <QuestionCard event={event} isDone={isResolved} sessionId={sessionId} onError={onError} />;
  if (kind === "agent.error") return <Alert variant="destructive"><X /><AlertTitle>{t("Agent 运行错误", "Agent runtime error")}</AlertTitle><AlertDescription>{text(event.message)}</AlertDescription></Alert>;
  if (kind === "subagent.started" || kind === "subagent.updated") {
    const subagent = record(event.subagent); const id = text(subagent.id, text(event.subagentId)); const label = text(subagent.name, id); const role = text(subagent.role); const summary = terminalPlainText(text(event.summary, text(subagent.preview))); const crossModel = role.includes("跨模型") || role.includes("Cross-model") || role.includes("跨工作区");
    return <Card size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><Bot className="size-4" />{crossModel ? t("派发子会话", "Dispatched session") : t("子 Agent", "Subagent")}</CardTitle><CardDescription>{label}{role ? ` · ${role}` : ""}</CardDescription></CardHeader><CardContent className="flex flex-col items-start gap-3">{summary && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{summary}</p>}{id && !crossModel && <Button variant="outline" size="sm" onClick={() => openSubagent(id, label)}><ExternalLink data-icon="inline-start" />{t("查看执行详情", "View execution details")}</Button>}{crossModel && <div className="flex flex-wrap items-center gap-2">{id && onOpenSession && <Button variant="outline" size="sm" onClick={() => onOpenSession(id)}><ExternalLink data-icon="inline-start" />{t("打开子会话", "Open child session")}</Button>}<p className="text-xs text-muted-foreground">{t("作为独立会话运行，完成后摘要自动回传主会话。", "Runs as an independent session; summary returns here on completion.")}</p></div>}</CardContent><CardFooter><Badge variant="secondary">{status(text(subagent.status, text(event.status, "active")))}</Badge></CardFooter></Card>;
  }
  if (kind === "trajectory.record") return <Alert><Bot /><AlertTitle>{text(event.title)}</AlertTitle><AlertDescription><MarkdownContent value={text(event.detail)} onError={onError} projectRoot={projectRoot} streaming={streaming} /><Badge variant={text(event.phase) === "failed" ? "destructive" : "secondary"}>{status(text(event.phase))}</Badge></AlertDescription></Alert>;
  if (kind === "turn.end") return <Marker variant="separator"><MarkerIcon><Check /></MarkerIcon><MarkerContent>{text(event.finish) === "failed" ? t("本轮失败", "Turn failed") : text(event.finish) === "interrupted" ? t("本轮已停止", "Turn stopped") : t("本轮完成", "Turn complete")}{number(event.outputTokens) > 0 && ` · ${String(number(event.outputTokens))} tokens`}</MarkerContent></Marker>;
  return null;
});

type TimelineItemProps = Omit<EventProps, "event"> & { item: ChatTimelineItem };
const EventCard = memo(function EventCard(props: EventProps) {
  const { t } = useLocale();
  return <><EventCardBody {...props} />{props.event.hasMore === true && Boolean(props.event.bodyRecordId) && !["tool.start", "tool.end"].includes(text(props.event.kind)) && <Button variant="outline" size="sm" onClick={() => props.openOutput(text(props.event.bodyRecordId), t("完整内容", "Full content"))}><ExternalLink data-icon="inline-start" />{t("查看完整内容", "Read full content")}</Button>}</>;
});
const TimelineItem = memo(function TimelineItem({ item, ...props }: TimelineItemProps) {
  const kind = text(item.event.kind);
  return <MessageScrollerItem key={item.key} messageId={item.key} data-chat-key={item.key} scrollAnchor={kind === "user.message" || kind === "conversation.turn"}><EventCard event={item.event} {...props} /></MessageScrollerItem>;
});

const TrajectoryFeed = memo(function TrajectoryFeed({ items, resolutions, ...props }: SharedEventHandlers & { items: readonly ChatTimelineItem[]; resolutions: ReadonlySet<string> }) {
  const { t } = useLocale();
  const [limit, setLimit] = useState(CHAT_TIMELINE_WINDOW_SIZE);
  const activity = useMemo(() => chatDisplayItems(items, "trajectory"), [items]);
  return <div className="trajectory-feed">
    <p className="trajectory-description">{t("思考过程与执行记录", "Reasoning and execution history")}</p>
    {activity.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit((value) => value + CHAT_TIMELINE_WINDOW_SIZE)}>{t("查看更早记录", "View earlier activity")}</Button>}
    {!activity.length && <div className="dock-empty">{t("暂无执行轨迹", "No activity yet")}</div>}
    {activity.slice(-limit).map((item) => {
      const kind = text(item.event.kind);
      const isResolved = kind === "permission.request" ? hasChatResolution(resolutions, "permission.resolved", text(item.event.reqId)) : kind === "question.request" ? hasChatResolution(resolutions, "question.resolved", text(item.event.reqId)) : false;
      return <div className="trajectory-entry" key={item.key}>{kind === "tool.start" || kind === "tool.end" ? <ToolCard compact event={item.event} openOutput={props.openOutput} /> : <EventCard event={item.event} isResolved={isResolved} {...props} />}</div>;
    })}
  </div>;
});

type StarterProjectChip = { path: string; name: string };
type ConversationTimelineSectionProps = {
  sessionId: string;
  sessionAgent: string;
  projectRoot?: string | undefined;
  isBotSession: boolean;
  starterProjects: readonly StarterProjectChip[];
  onSelectStarterProject: (project: StarterProjectChip) => void;
  displayItems: readonly ChatTimelineItem[];
  resolutions: ReadonlySet<string>;
  nextOrdinal: number;
  pagedEnabled: boolean;
  pagedLive: boolean;
  historyCursor: ChatHistoryCursor | null;
  selectHistoryCursor: (next: ChatHistoryCursor | null) => void;
  jumpToLatest: () => void;
  handleTimelineScroll: (event: UIEvent<HTMLDivElement>) => void;
  timelineViewport: RefObject<HTMLDivElement | null>;
  pendingJumpKey: string | undefined;
  setPendingJumpKey: (key: string | undefined) => void;
  jumpCompleted: () => void;
  onError: (message?: string) => void;
  openOutput: (id: string, tool: string) => void;
  openSubagent: (id: string, label: string) => void;
  onOpenSession?: ((id: string) => void) | undefined;
};

export const ConversationTimelineSection = memo(function ConversationTimelineSection({
  sessionId,
  sessionAgent,
  projectRoot,
  isBotSession,
  starterProjects,
  onSelectStarterProject,
  displayItems,
  resolutions,
  nextOrdinal,
  pagedEnabled,
  pagedLive,
  historyCursor,
  selectHistoryCursor,
  jumpToLatest,
  handleTimelineScroll,
  timelineViewport,
  pendingJumpKey,
  setPendingJumpKey,
  jumpCompleted,
  onError,
  openOutput,
  openSubagent,
  onOpenSession,
}: ConversationTimelineSectionProps) {
  const { t } = useLocale();
  const navigationPoints = useMemo(
    () => displayItems.filter((item) => item.event.kind === "conversation.turn"),
    [displayItems],
  );
  const historyWindow = useMemo(
    () => getChatTimelineItemWindow(displayItems, nextOrdinal, historyCursor?.end ?? null),
    [historyCursor, nextOrdinal, displayItems],
  );
  const visibleItems = useMemo(
    () => displayItems.slice(historyWindow.start, historyWindow.end),
    [historyWindow.end, historyWindow.start, displayItems],
  );
  const visibleRevision = useMemo(
    () => visibleItems.map((item) => item.key).join("|"),
    [visibleItems],
  );
  const handleRailJump = useCallback(
    (key: string) => {
      selectHistoryCursor({ end: historyEndForItem(displayItems, key, nextOrdinal, CHAT_TIMELINE_WINDOW_SIZE), mode: "page" });
      setPendingJumpKey(key);
    },
    [displayItems, nextOrdinal, selectHistoryCursor, setPendingJumpKey],
  );

  return (
    <MessageScrollerProvider autoScroll={historyCursor === null && (!pagedEnabled || pagedLive)}>
      <MessageScroller>
        <ConversationRail
          points={navigationPoints}
          pendingKey={pendingJumpKey}
          revision={visibleRevision}
          onJumped={jumpCompleted}
          onJump={handleRailJump}
        />
        <MessageScrollerViewport ref={timelineViewport} onScroll={handleTimelineScroll} aria-label={t("会话消息时间线", "Conversation message timeline")}>
          <MessageScrollerContent className="mx-auto w-full max-w-4xl px-6 py-8">
            {!displayItems.length && (isBotSession ? (
              <Empty className="my-auto">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
                  <EmptyTitle>{t("Prospero Bot · 全局主会话", "Prospero Bot · Master Session")}</EmptyTitle>
                  <EmptyDescription>{t("像 Grokbot 主对话一样统筹全局：直接发消息让 Prospero Bot 给任意工作区派发子会话、跟进进度并汇总结果，或点击下方「派发工作区会话」手动派发。", "Coordinate across all workspaces like a master chat: ask Prospero Bot to dispatch child sessions to any workspace and synthesize results, or click Dispatch Workspace Session below.")}</EmptyDescription>
                </EmptyHeader>
                {starterProjects.length > 0 && (
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {starterProjects.map((project) => (
                      <Button key={project.path} variant="outline" size="sm" onClick={() => onSelectStarterProject(project)}>
                        <FolderKanban data-icon="inline-start" />
                        {project.name}
                      </Button>
                    ))}
                  </div>
                )}
              </Empty>
            ) : (
              <Empty className="my-auto">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Bot /></EmptyMedia>
                  <EmptyTitle>{`${t("开始与", "Start collaborating with")} ${sessionAgent}`}</EmptyTitle>
                  <EmptyDescription>{t("消息、工具调用、审批、提问和子 Agent 过程会按时间线显示在这里。", "Messages, tool calls, approvals, questions, and subagent activity appear here in a timeline.")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ))}
            {historyWindow.start > 0 && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={() => selectHistoryCursor({ end: historyWindow.cursorStart, mode: "page" })}>
                  <ChevronDown className="rotate-180" data-icon="inline-start" />
                  {t(`查看更早的 ${String(Math.min(CHAT_TIMELINE_WINDOW_SIZE, historyWindow.start))} 条记录`, `View ${String(Math.min(CHAT_TIMELINE_WINDOW_SIZE, historyWindow.start))} earlier events`)}
                </Button>
              </div>
            )}
            {visibleItems.map((item) => {
              const kind = text(item.event.kind);
              const isResolved =
                kind === "permission.request"
                  ? hasChatResolution(resolutions, "permission.resolved", text(item.event.reqId))
                  : kind === "question.request"
                    ? hasChatResolution(resolutions, "question.resolved", text(item.event.reqId))
                    : false;
              return (
                <TimelineItem
                  key={item.key}
                  item={item}
                  isResolved={isResolved}
                  sessionId={sessionId}
                  projectRoot={projectRoot}
                  onError={onError}
                  openOutput={openOutput}
                  openSubagent={openSubagent}
                  onOpenSession={onOpenSession}
                />
              );
            })}
            {!historyWindow.isLatest && (
              <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                <span>{t(`当前显示 ${String(historyWindow.start + 1)}–${String(historyWindow.end)}，另有 ${String(historyWindow.newerCount)} 条较新记录`, `Showing ${String(historyWindow.start + 1)}–${String(historyWindow.end)} with ${String(historyWindow.newerCount)} newer events`)}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const nextEnd = Math.min(displayItems.length, historyWindow.end + CHAT_TIMELINE_WINDOW_SIZE);
                    if (nextEnd >= displayItems.length) jumpToLatest();
                    else selectHistoryCursor({ end: displayItems[nextEnd]?.ordinal ?? nextOrdinal, mode: "page" });
                  }}
                >
                  {t("查看较新记录", "View newer events")}
                  <ChevronDown data-icon="inline-end" />
                </Button>
                <Button size="sm" onClick={jumpToLatest}>{t("回到最新", "Jump to latest")}</Button>
              </div>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton onClick={jumpToLatest} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
});

export const CHAT_SESSION_DRAFT_CACHE_LIMIT = 200;
export type PendingAttachment = { id: string; name: string; mimeType: string; size: number; dataB64: string };
export type ChatSessionDraftEntry = { text: string; attachments: PendingAttachment[] };
type ChatDraftState = { sessionId: string; text: string; attachments: PendingAttachment[] };

const EMPTY_ATTACHMENTS: PendingAttachment[] = [];
const sessionDraftCache = new Map<string, ChatSessionDraftEntry>();

export function loadChatSessionDraft(sessionId: string): ChatSessionDraftEntry {
  const cached = sessionDraftCache.get(sessionId);
  if (cached) {
    sessionDraftCache.delete(sessionId);
    sessionDraftCache.set(sessionId, cached);
    return { text: cached.text, attachments: [...cached.attachments] };
  }
  return { text: loadChatDraft(sessionId), attachments: [] };
}

export function saveChatSessionDraft(
  sessionId: string,
  entry: ChatSessionDraftEntry,
  persistStorage = false,
): void {
  if (!sessionId) return;
  const normalizedText = limitChatDraftText(entry.text);
  const attachments = entry.attachments.length ? [...entry.attachments] : EMPTY_ATTACHMENTS;
  if (persistStorage) {
    persistChatDraft(sessionId, normalizedText);
  }
  if (!normalizedText && attachments.length === 0) {
    sessionDraftCache.delete(sessionId);
    return;
  }
  sessionDraftCache.delete(sessionId);
  sessionDraftCache.set(sessionId, { text: normalizedText, attachments });
  while (sessionDraftCache.size > CHAT_SESSION_DRAFT_CACHE_LIMIT) {
    const oldest = sessionDraftCache.keys().next().value;
    if (oldest === undefined) break;
    sessionDraftCache.delete(oldest);
  }
}

export function getChatSessionDraftCacheSize(): number {
  return sessionDraftCache.size;
}

export function clearChatSessionDraftCache(): void {
  sessionDraftCache.clear();
}

async function fileToAttachment(file: File): Promise<PendingAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { id: crypto.randomUUID(), name: file.name, mimeType: file.type, size: file.size, dataB64: btoa(binary) };
}

export function ChatPane({ session, account, snapshot, onOpenSession, onSwitchBotSession, onOpenGoal, trajectoryHost, onMissingSession }: { session: SessionInfo; account?: JsonObject | undefined; snapshot?: DesktopSnapshot | undefined; onOpenSession?: ((id: string) => void) | undefined; onSwitchBotSession?: ((session: SessionInfo) => void) | undefined; onOpenGoal?: (() => void) | undefined; trajectoryHost?: HTMLDivElement | null; onMissingSession?: (id: string) => void }) {
  const { t } = useLocale();
  const tRef = useRef(t);
  tRef.current = t;
  const onOpenSessionRef = useRef(onOpenSession);
  onOpenSessionRef.current = onOpenSession;
  const hasOpenSession = Boolean(onOpenSession);
  const stableOpenSession = useCallback((id: string): void => {
    onOpenSessionRef.current?.(id);
  }, []);
  const openSessionHandler = useMemo(
    () => (hasOpenSession ? stableOpenSession : undefined),
    [hasOpenSession, stableOpenSession],
  );
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false);
  const composerOptionsId = useId();
  const paged = usePagedTimeline(session.id, session.historyMode === "paged");
  const [bodyDetail, setBodyDetail] = useState<{ id: string; title: string; sessionId: string }>();
  const accumulator = useRef<ChatEventAccumulator | null>(null); if (!accumulator.current) accumulator.current = new ChatEventAccumulator();
  const [legacyTimeline, setTimeline] = useState(() => accumulator.current!.snapshot()); const cursor = useRef<number | undefined>(undefined);
  const timeline = paged.enabled ? paged.timeline : legacyTimeline;
  const [historyCursor, setHistoryCursor] = useState<ChatHistoryCursor | null>(null); const historyCursorRef = useRef<ChatHistoryCursor | null>(null);
  const timelineEndRef = useRef(0); timelineEndRef.current = timeline.nextOrdinal;
  const timelineViewport = useRef<HTMLDivElement | null>(null); const jumpToLatestRef = useRef(false);
  const [draftState, setDraftState] = useState<ChatDraftState>(() => {
    const initial = loadChatSessionDraft(session.id);
    return { sessionId: session.id, text: initial.text, attachments: initial.attachments };
  });
  const draftRef = useRef(draftState); draftRef.current = draftState;
  const draft = draftState.sessionId === session.id ? draftState.text : "";
  const attachments = draftState.sessionId === session.id ? draftState.attachments : EMPTY_ATTACHMENTS;
  const setDraft = useCallback((next: string | ((current: string) => string)): void => {
    const activeCurrent = draftRef.current.sessionId === session.id
      ? draftRef.current
      : { sessionId: session.id, ...loadChatSessionDraft(session.id) };
    const value = limitChatDraftText(typeof next === "function" ? next(activeCurrent.text) : next);
    const state: ChatDraftState = { sessionId: session.id, text: value, attachments: activeCurrent.attachments };
    draftRef.current = state;
    saveChatSessionDraft(session.id, { text: value, attachments: activeCurrent.attachments }, false);
    setDraftState(state);
  }, [session.id]);
  const setAttachments = useCallback((next: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[])): void => {
    const activeCurrent = draftRef.current.sessionId === session.id
      ? draftRef.current
      : { sessionId: session.id, ...loadChatSessionDraft(session.id) };
    const nextAttachments = typeof next === "function" ? next(activeCurrent.attachments) : next;
    const normalized = nextAttachments.length ? nextAttachments : EMPTY_ATTACHMENTS;
    const state: ChatDraftState = { sessionId: session.id, text: activeCurrent.text, attachments: normalized };
    draftRef.current = state;
    saveChatSessionDraft(session.id, { text: activeCurrent.text, attachments: normalized }, false);
    setDraftState(state);
  }, [session.id]);
  const sendingDraftRef = useRef<ChatDraftState | undefined>(undefined);
  const [sending, setSending] = useState(false); const [resumingArchive, setResumingArchive] = useState(false);
  const [attaching, setAttaching] = useState(false); const [attachmentProgress, setAttachmentProgress] = useState<{ current: number; total: number }>(); const attachingRef = useRef(false); const attachmentBatchRef = useRef(0);
  const [skills, setSkills] = useState<SkillSuggestion[]>([]); const [activeSkillIndex, setActiveSkillIndex] = useState(-1); const skillLookupRef = useRef(0); const skillListId = useId();
  const [modes, setModes] = useState<AgentModeCatalog>(); const [modeBusy, setModeBusy] = useState(false);
  const [operationError, setOperationError] = useState<string>(); const [legacyConnectionError, setConnectionError] = useState<string>();
  const connectionError = paged.enabled ? paged.state.error : legacyConnectionError;
  const [detail, setDetail] = useState<{ title: string; content: string; loading?: boolean; truncated?: boolean }>(); const detailRequest = useRef(0); const fileInput = useRef<HTMLInputElement>(null);
  const [busyDelivery, setBusyDelivery] = useState<"queue" | "steer">("queue");
  const [queueBusy, setQueueBusy] = useState<Record<string, "remove" | "guide">>({});
  const queueBusyRef = useRef(new Set<string>());
  const messageQueue = session.messageQueue ?? [];
  const sessionBusy = ["starting", "running", "waiting_approval", "waiting_input"].includes(session.status);
  const [fontSize] = useConversationFont();
  const [pendingJumpKey, setPendingJumpKey] = useState<string>();
  const jumpCompleted = useCallback(() => setPendingJumpKey(undefined), []);
  const deepseek = supportsTrajectory(session);
  const isBotSession = isProsperoBotSession(session);
  const displayItems = useMemo(() => conversationTurns(timeline.items, timeline.resolutions), [timeline]);
  const starterProjects = useMemo<StarterProjectChip[]>(() => {
    if (!isBotSession || displayItems.length > 0 || !snapshot?.projects.length) return [];
    return snapshot.projects.slice(0, 6).map((project) => ({
      path: project,
      name: snapshot.projectAliases[project.toLocaleLowerCase()] || project.split(/[\\/]/).filter(Boolean).at(-1) || project,
    }));
  }, [displayItems.length, isBotSession, snapshot?.projectAliases, snapshot?.projects]);
  const handleSelectStarterProject = useCallback((project: StarterProjectChip): void => {
    setDraft(tRef.current(`请在工作区 ${project.path} (${project.name}) 派发一个子会话，任务是：`, `Dispatch a child session in workspace ${project.path} (${project.name}) to: `));
  }, [setDraft]);
  const latestAgentError = timeline.items.findLast((item) => item.event.kind === "agent.error");
  const latestErrorKey = latestAgentError?.key;
  const latestErrorMessage = text(latestAgentError?.event.message);
  useEffect(() => {
    if (latestErrorMessage) notify({ kind: "error", title: t("Agent 运行错误", "Agent runtime error"), message: latestErrorMessage, key: `${session.id}:${latestErrorKey}` });
  }, [latestErrorKey, latestErrorMessage, session.id, t]);
  useEffect(() => {
    if (session.status === "waiting_approval" || session.status === "waiting_input") notify({ kind: "warning", message: session.status === "waiting_approval" ? t("当前会话有操作等待审批。", "An action in this session needs approval.") : t("当前会话需要你的答复才能继续。", "This session needs your answer to continue."), key: `${session.id}:${session.status}` });
  }, [session.id, session.status, t]);
  const selectHistoryCursor = useCallback((next: ChatHistoryCursor | null): void => { historyCursorRef.current = next; setHistoryCursor(next); }, []);
  const jumpToLatest = useCallback((): void => { if (paged.enabled) void paged.controller.latest(); jumpToLatestRef.current = true; selectHistoryCursor(null); }, [paged.controller, paged.enabled, selectHistoryCursor]);
  const handleTimelineScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget;
    if (paged.enabled) { if (!isChatViewportNearEnd(element)) paged.controller.freeze(); return; }
    const current = historyCursorRef.current;
    const next = updateChatHistoryCursorFromScroll(current, isChatViewportNearEnd(element), timelineEndRef.current);
    if (next === current) return;
    if (current?.mode === "frozen" && next === null) jumpToLatestRef.current = true;
    selectHistoryCursor(next);
  }, [paged.controller, paged.enabled, selectHistoryCursor]);
  useEffect(() => {
    if (!jumpToLatestRef.current || historyCursor !== null) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = timelineViewport.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
      jumpToLatestRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [historyCursor]);
  useEffect(() => {
    const current = draftRef.current;
    if (current.sessionId === session.id) return;
    saveChatSessionDraft(current.sessionId, { text: current.text, attachments: current.attachments }, true);
    const restored = loadChatSessionDraft(session.id);
    const next: ChatDraftState = { sessionId: session.id, text: restored.text, attachments: restored.attachments };
    draftRef.current = next;
    setDraftState(next);
  }, [session.id]);
  useEffect(() => {
    if (draftState.sessionId !== session.id || sending) return;
    const timer = window.setTimeout(() => {
      saveChatSessionDraft(session.id, { text: draftState.text, attachments: draftState.attachments }, true);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draftState, sending, session.id]);
  useEffect(() => () => {
    const current = draftRef.current;
    const pending = sendingDraftRef.current;
    const textValue = current.text || (pending?.sessionId === current.sessionId ? pending.text : "");
    const attachmentItems = current.attachments.length > 0
      ? current.attachments
      : (pending?.sessionId === current.sessionId ? pending.attachments : EMPTY_ATTACHMENTS);
    saveChatSessionDraft(current.sessionId, { text: textValue, attachments: attachmentItems }, true);
  }, []);
  useEffect(() => {
    let active = true;
    setTimeline(accumulator.current!.reset([]));
    cursor.current = undefined;
    jumpToLatestRef.current = false;
    selectHistoryCursor(null);
    attachmentBatchRef.current += 1;
    attachingRef.current = false;
    setAttaching(false);
    setAttachmentProgress(undefined);
    setSkills([]);
    setActiveSkillIndex(-1);
    queueBusyRef.current.clear();
    setQueueBusy({});
    setResumingArchive(false);
    setOperationError(undefined);
    setConnectionError(undefined);
    void window.prospero.getAgentModes(session.id).then((next) => {
      if (active) setModes(next);
    }).catch(() => {
      if (active) setModes(undefined);
    });
    return () => { active = false; detailRequest.current += 1; };
  }, [selectHistoryCursor, session.id]);
  useEffect(() => {
    const requestId = ++skillLookupRef.current;
    const match = draft.match(/(?:^|\s)\$([^\s]*)$/);
    if (!match) {
      setSkills([]);
      setActiveSkillIndex(-1);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void window.prospero.getSkillSuggestions(session.id, match[1] ?? "").then((next) => {
        if (!active || skillLookupRef.current !== requestId) return;
        setSkills(next);
        setActiveSkillIndex(next.length ? 0 : -1);
      }).catch(() => {
        if (!active || skillLookupRef.current !== requestId) return;
        setSkills([]);
        setActiveSkillIndex(-1);
      });
    }, 160);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draft, session.id]);
  useEffect(() => {
    const byId = new Map(messageQueue.map((item) => [item.id, item]));
    setQueueBusy((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id, action]) => {
        const item = byId.get(id);
        return Boolean(item && !(action === "guide" && item.kind === "guide"));
      })) as Record<string, "remove" | "guide">;
      queueBusyRef.current = new Set(Object.keys(next));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [messageQueue]);
  useEffect(() => {
    if (activeSkillIndex < 0) return;
    document.getElementById(`${skillListId}-${String(activeSkillIndex)}`)?.scrollIntoView({ block: "nearest" });
  }, [activeSkillIndex, skillListId]);
  useEffect(() => {
    let active = true; let timer: number | undefined; let errorDelay = 1_000; let pollFailed = false;
    if (paged.enabled) return;
    const poll = async (): Promise<void> => { let nextDelay = 25; const startedAt = performance.now(); try { const frame = await window.prospero.getSessionView(session.id, cursor.current === undefined ? {} : { afterSeq: cursor.current, waitMs: 20_000 }); if (!active) return; nextDelay = getChatPollReconnectDelay(Boolean(frame), performance.now() - startedAt); if (frame) { const incoming = array(frame.events).map(record); if (text(frame.mode) === "delta") { const next = accumulator.current!.append(incoming); if (next) setTimeline(next); } else { setTimeline(accumulator.current!.reset(incoming)); jumpToLatestRef.current = false; selectHistoryCursor(null); } cursor.current = number(frame.evSeq, number(frame.seq)); setConnectionError(undefined); } else if (pollFailed) setConnectionError(undefined); pollFailed = false; errorDelay = 1_000; } catch (reason) { if (active && isMissingSessionError(reason)) { onMissingSession?.(session.id); active = false; return; } if (active) setConnectionError(displayError(reason)); pollFailed = true; nextDelay = errorDelay; errorDelay = Math.min(8_000, errorDelay * 2); } if (active) timer = window.setTimeout(() => void poll(), nextDelay); };
    void poll(); return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); void window.prospero.cancelSessionView(session.id).catch(() => undefined); };
  }, [onMissingSession, paged.enabled, selectHistoryCursor, session.id]);
  const send = async (): Promise<void> => {
    if (session.archived) { setOperationError(t("请先继续这条已归档对话", "Resume this archived chat first")); return; }
    const value = draft.trim();
    if ((!value && !attachments.length) || sending || attachingRef.current) return;
    const targetSessionId = session.id;
    const rawDraft = draft;
    const queued = attachments;
    setSending(true);
    sendingDraftRef.current = { sessionId: targetSessionId, text: rawDraft, attachments: queued };
    const cleared: ChatDraftState = { sessionId: targetSessionId, text: "", attachments: EMPTY_ATTACHMENTS };
    draftRef.current = cleared;
    setDraftState(cleared);
    saveChatSessionDraft(targetSessionId, { text: "", attachments: EMPTY_ATTACHMENTS }, true);
    try {
      const result = await window.prospero.interact(targetSessionId, { type: "chat.send", text: value, attachments: queued.map(({ name, mimeType, dataB64 }) => ({ name, mimeType, dataB64 })), ...(sessionBusy ? { delivery: busyDelivery } : {}) });
      if (result?.accepted === false) throw new Error(text(result.error, t("消息未被接收", "The message was not accepted")));
      sendingDraftRef.current = undefined;
      if (draftRef.current.sessionId === targetSessionId) {
        saveChatSessionDraft(targetSessionId, { text: draftRef.current.text, attachments: draftRef.current.attachments }, true);
      }
      setOperationError(result?.accepted === true && text(result.error)
        ? t(`消息已被接收，但 Agent 执行失败：${text(result.error)}`, `The message was accepted, but the agent failed: ${text(result.error)}`)
        : undefined);
    } catch (reason) {
      const failedDraft = sendingDraftRef.current?.text ?? value;
      sendingDraftRef.current = undefined;
      if (draftRef.current.sessionId === targetSessionId) {
        const mergedText = mergeFailedChatDraft(failedDraft, draftRef.current.text);
        const queuedIds = new Set(queued.map((item) => item.id));
        const mergedAttachments = [...queued, ...draftRef.current.attachments.filter((item) => !queuedIds.has(item.id))];
        const restored: ChatDraftState = { sessionId: targetSessionId, text: mergedText, attachments: mergedAttachments };
        draftRef.current = restored;
        setDraftState(restored);
        saveChatSessionDraft(targetSessionId, { text: mergedText, attachments: mergedAttachments }, true);
      } else {
        const existing = loadChatSessionDraft(targetSessionId);
        const mergedText = mergeFailedChatDraft(failedDraft, existing.text);
        const queuedIds = new Set(queued.map((item) => item.id));
        const mergedAttachments = [...queued, ...existing.attachments.filter((item) => !queuedIds.has(item.id))];
        saveChatSessionDraft(targetSessionId, { text: mergedText, attachments: mergedAttachments }, true);
      }
      setOperationError(reportError(reason));
    } finally {
      setSending(false);
    }
  };
  const attach = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    if (sending || attachingRef.current) {
      setOperationError(t("请等待当前操作完成后再添加附件", "Wait for the current operation to finish before attaching files"));
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const incoming = [...files];
    const issue = getChatAttachmentSelectionIssue(attachments, incoming);
    if (issue) {
      if (issue.kind === "count") setOperationError(t("每条消息最多上传 6 张图片", "You can upload up to 6 images per message"));
      if (issue.kind === "type") setOperationError(`${issue.name ?? t("该文件", "This file")} ${t("不是支持的图片格式", "is not a supported image format")}`);
      if (issue.kind === "name") setOperationError(t(`文件名不能超过 ${String(MAX_CHAT_ATTACHMENT_NAME_LENGTH)} 个字符`, `File names cannot exceed ${String(MAX_CHAT_ATTACHMENT_NAME_LENGTH)} characters`));
      if (issue.kind === "size") setOperationError(`${issue.name ?? t("该图片", "This image")} ${t(`超过 ${String(MAX_CHAT_ATTACHMENT_BYTES / 1024 / 1024)} MB`, `exceeds ${String(MAX_CHAT_ATTACHMENT_BYTES / 1024 / 1024)} MB`)}`);
      if (issue.kind === "total") setOperationError(t(`附件总大小不能超过 ${String(MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)} MB`, `Attachments cannot exceed ${String(MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)} MB in total`));
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const targetSessionId = session.id;
    const batchId = ++attachmentBatchRef.current;
    attachingRef.current = true;
    setAttaching(true);
    setOperationError(undefined);
    try {
      const converted: PendingAttachment[] = [];
      for (let index = 0; index < incoming.length; index++) {
        if (attachmentBatchRef.current !== batchId) return;
        setAttachmentProgress({ current: index + 1, total: incoming.length });
        converted.push(await fileToAttachment(incoming[index]!));
      }
      if (attachmentBatchRef.current === batchId && draftRef.current.sessionId === targetSessionId) {
        setAttachments((current) => [...current, ...converted]);
      }
    } catch (reason) {
      if (attachmentBatchRef.current === batchId) setOperationError(reportError(reason));
    } finally {
      if (attachmentBatchRef.current === batchId) {
        attachingRef.current = false;
        setAttaching(false);
        setAttachmentProgress(undefined);
      }
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const chooseSkill = (skill: SkillSuggestion): void => { skillLookupRef.current += 1; setDraft((current) => current.replace(/(?:^|\s)\$[^\s]*$/, (match) => `${match.startsWith(" ") ? " " : ""}$${skill.value} `)); setSkills([]); setActiveSkillIndex(-1); };
  const setMode = async (mode: string): Promise<void> => { setModeBusy(true); try { const result = await window.prospero.setAgentMode(session.id, mode); setModes((current) => current ? { ...current, currentMode: result.currentMode } : current); setOperationError(undefined); } catch (reason) { setOperationError(reportError(reason)); } finally { setModeBusy(false); } };
  const queueAction = async (queueId: string, action: "remove" | "guide"): Promise<void> => {
    if (queueBusyRef.current.has(queueId)) return;
    queueBusyRef.current.add(queueId);
    setQueueBusy((current) => ({ ...current, [queueId]: action }));
    setOperationError(undefined);
    try {
      await window.prospero.interact(session.id, { type: action === "remove" ? "chat.queue.remove" : "chat.queue.guide", queueId });
    } catch (reason) {
      setOperationError(reportError(reason));
    } finally {
      queueBusyRef.current.delete(queueId);
      setQueueBusy((current) => {
        if (!(queueId in current)) return current;
        const next = { ...current };
        delete next[queueId];
        return next;
      });
    }
  };
  const closeDetail = useCallback((): void => { detailRequest.current += 1; setDetail(undefined); }, []);
  const openOutput = useCallback(async (id: string, tool: string): Promise<void> => {
    if (paged.enabled) { setBodyDetail({ id, title: tool, sessionId: session.id }); return; }
    const request = ++detailRequest.current;
    const translate = tRef.current;
    const title = `${tool} · ${translate("工具输出", "Tool output")}`;
    setDetail({ title, content: "", loading: true });
    try {
      const result = await window.prospero.getToolOutput(session.id, id);
      if (detailRequest.current !== request) return;
      setDetail({ title, content: terminalPlainText(text(result.output, translate("（无输出）", "(No output)"))), truncated: result.truncated === true });
      setOperationError(undefined);
    } catch (reason) {
      if (detailRequest.current !== request) return;
      setDetail(undefined);
      setOperationError(reportError(reason));
    }
  }, [paged.enabled, session.id]);
  const openSubagent = useCallback(async (id: string, label: string): Promise<void> => {
    const request = ++detailRequest.current;
    const translate = tRef.current;
    const title = `${translate("子 Agent", "Subagent")} · ${label}`;
    setDetail({ title, content: "", loading: true });
    try {
      const result = await window.prospero.getSubagentEvents(session.id, id);
      if (detailRequest.current !== request) return;
      const lines = collapseChatEventHistory(array(result.events).map(record)).map((event) => {
        const body = terminalPlainText(text(event.text, text(event.summary, text(event.message, text(event.detail)))));
        return `${text(event.kind)}${body ? `\n${body}` : ""}`;
      });
      setDetail({ title, content: lines.join("\n\n") || translate("（尚无事件）", "(No events yet)") });
      setOperationError(undefined);
    } catch (reason) {
      if (detailRequest.current !== request) return;
      setDetail(undefined);
      setOperationError(reportError(reason));
    }
  }, [session.id]);
  const handleComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = event.clipboardData?.files;
    if (!files?.length || event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    void attach(files);
  };
  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const native = event.nativeEvent;
    const action = getChatComposerKeyAction(event.key, event.shiftKey, native.isComposing || native.keyCode === 229, skills.length);
    if (!action) return;
    event.preventDefault();
    if (action === "nextSkill") setActiveSkillIndex((current) => getNextChatSkillIndex(current, skills.length, 1));
    if (action === "previousSkill") setActiveSkillIndex((current) => getNextChatSkillIndex(current, skills.length, -1));
    if (action === "dismissSkills") {
      skillLookupRef.current += 1;
      setSkills([]);
      setActiveSkillIndex(-1);
    }
    if (action === "selectSkill") chooseSkill(skills[activeSkillIndex] ?? skills[0]!);
    if (action === "send") void send();
  };
  return <div className="chat-pane flex size-full min-h-0 flex-col bg-background" style={{ "--conversation-font-size": `${fontSize}px` } as CSSProperties}>
    {bodyDetail?.sessionId === session.id && <TimelineBodyDialog key={`${session.id}:${bodyDetail.id}`} sessionId={session.id} recordId={bodyDetail.id} title={bodyDetail.title} onClose={() => setBodyDetail(undefined)} />}
    {isBotSession && (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/25 px-4 py-2" data-testid="master-session-config-bar">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <Sparkles className="size-3.5 text-primary" />
            {t("Prospero Bot · 主会话", "Prospero Bot · Master Session")}
          </span>
          <Badge variant="secondary">Harness: {session.agent}</Badge>
          <Badge variant="outline">
            {session.agentControls?.currentModel ?? session.model ?? "gpt-6-astra"}
            {(session.agentControls?.currentEffort ?? session.effort)
              ? ` · ${session.agentControls?.currentEffort ?? session.effort}`
              : ""}
          </Badge>
          {account && (
            <Badge variant="outline">
              {text(account["name"], session.accountId)}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ModelSwitcher key={`${session.id}:header`} session={session} account={account} />
          <MasterHarnessConfigDialog
            session={session}
            account={account}
            snapshot={snapshot}
            onSwitched={onSwitchBotSession}
            onError={setOperationError}
          />
          <CrossModelChildLauncher
            session={session}
            snapshot={snapshot}
            onCreated={(id, jump) => {
              if (jump) openSessionHandler?.(id);
            }}
            onError={setOperationError}
          />
        </div>
      </div>
    )}
    {paged.enabled && <div className="flex flex-wrap items-center justify-center gap-2 px-6 py-2" aria-label={t("会话历史分页", "Conversation history pages")}>
      {paged.state.page?.older && <Button variant="outline" size="sm" disabled={paged.state.loading} onClick={() => void paged.controller.older()}>{t("查看更早记录", "Older records")}</Button>}
      {paged.state.page?.newer && <Button variant="outline" size="sm" disabled={paged.state.loading} onClick={() => void paged.controller.newer()}>{t("查看较新记录", "Newer records")}</Button>}
      {!paged.state.live && <Button size="sm" disabled={paged.state.loading} onClick={jumpToLatest}>{t("回到最新", "Jump to latest")}</Button>}
      {paged.state.loading && <Spinner />}
      {paged.state.error && <Button variant="outline" size="sm" onClick={() => void paged.controller.retry()}>{t("重新读取", "Reload")}</Button>}
    </div>}
    {deepseek && trajectoryHost && createPortal(<TrajectoryFeed key={session.id} items={timeline.items} resolutions={timeline.resolutions} sessionId={session.id} projectRoot={session.cwd} onError={setOperationError} openOutput={openOutput} openSubagent={openSubagent} onOpenSession={openSessionHandler} />, trajectoryHost)}
    <ConversationTimelineSection
      sessionId={session.id}
      sessionAgent={session.agent}
      projectRoot={session.cwd}
      isBotSession={isBotSession}
      starterProjects={starterProjects}
      onSelectStarterProject={handleSelectStarterProject}
      displayItems={displayItems}
      resolutions={timeline.resolutions}
      nextOrdinal={timeline.nextOrdinal}
      pagedEnabled={paged.enabled}
      pagedLive={paged.state.live}
      historyCursor={historyCursor}
      selectHistoryCursor={selectHistoryCursor}
      jumpToLatest={jumpToLatest}
      handleTimelineScroll={handleTimelineScroll}
      timelineViewport={timelineViewport}
      pendingJumpKey={pendingJumpKey}
      setPendingJumpKey={setPendingJumpKey}
      jumpCompleted={jumpCompleted}
      onError={setOperationError}
      openOutput={openOutput}
      openSubagent={openSubagent}
      onOpenSession={openSessionHandler}
    />
    <div className="chat-composer-shell"><div className="chat-composer-inner flex flex-col gap-2">{connectionError && <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("会话连接中断", "Session connection interrupted")}</AlertTitle><AlertDescription>{connectionError}</AlertDescription></Alert>}{operationError && <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("会话操作失败", "Session action failed")}</AlertTitle><AlertDescription>{operationError}</AlertDescription></Alert>}{messageQueue.length > 0 && <section className="grid gap-2 rounded-xl border bg-muted/35 p-3" aria-label={t("待发送消息", "Queued messages")} aria-live="polite"><header className="flex flex-wrap items-center justify-between gap-2"><strong className="flex items-center gap-2 text-sm"><Clock3 className="size-4" />{t("待发送", "Queued")} · {messageQueue.length}</strong><span className="text-xs text-muted-foreground">{t("当前轮结束后依次发送", "Sent in order after the current turn")}</span></header><div className="grid max-h-52 gap-1.5 overflow-y-auto">{messageQueue.map((item) => <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-background/80 px-2.5 py-2" key={item.id}><Badge variant="outline">{item.kind === "guide" ? t("引导", "Guide") : t("排队", "Queue")}</Badge><span className="min-w-0 flex-1 truncate text-sm" title={item.text}>{item.text || t(`${String(item.attachmentCount)} 张图片`, `${String(item.attachmentCount)} images`)}</span>{item.attachmentCount > 0 && <span className="flex items-center gap-1 text-xs text-muted-foreground"><FileImage className="size-3.5" />{item.attachmentCount}</span>}{item.kind !== "guide" && <Button variant="ghost" size="xs" aria-busy={queueBusy[item.id] === "guide"} disabled={Boolean(queueBusy[item.id])} onClick={() => void queueAction(item.id, "guide")}>{queueBusy[item.id] === "guide" ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}{t("现在引导", "Guide now")}</Button>}<Button variant="ghost" size="icon-xs" aria-label={t("取消待发送消息", "Cancel queued message")} aria-busy={queueBusy[item.id] === "remove"} disabled={Boolean(queueBusy[item.id])} onClick={() => void queueAction(item.id, "remove")}>{queueBusy[item.id] === "remove" ? <Spinner /> : <Trash2 />}</Button></div>)}</div></section>}{attachments.length > 0 && <AttachmentGroup>{attachments.map((item) => <Attachment state="idle" size="sm" key={item.id}><AttachmentMedia><FileImage /></AttachmentMedia><AttachmentContent><AttachmentTitle>{item.name}</AttachmentTitle><AttachmentDescription>{t(`图片 · ${(item.size / 1024 / 1024).toFixed(1)} MB · 等待发送`, `Image · ${(item.size / 1024 / 1024).toFixed(1)} MB · waiting to send`)}</AttachmentDescription></AttachmentContent><AttachmentActions><AttachmentAction aria-label={`${t("移除", "Remove")} ${item.name}`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}><X /></AttachmentAction></AttachmentActions></Attachment>)}</AttachmentGroup>}
      {attachmentProgress && <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Spinner />{t(`正在处理图片 ${String(attachmentProgress.current)}/${String(attachmentProgress.total)}…`, `Processing image ${String(attachmentProgress.current)}/${String(attachmentProgress.total)}…`)}</div>}
      <div id={composerOptionsId} className="chat-composer-options" hidden={!composerOptionsOpen}><CrossModelChildLauncher session={session} snapshot={snapshot} onCreated={(id, jump) => { if (jump) openSessionHandler?.(id); }} onError={setOperationError} />{isBotSession && <MasterHarnessConfigDialog session={session} account={account} snapshot={snapshot} onSwitched={onSwitchBotSession} onError={setOperationError} />}{Boolean(modes?.modes.length) && modes && <ToggleGroup value={modes.currentMode ? [modes.currentMode] : []} onValueChange={(values) => values[0] && void setMode(values[0])} disabled={modeBusy} variant="outline" size="sm">{modes.modes.map((mode) => <ToggleGroupItem key={mode.id} value={mode.id} title={mode.description}>{mode.id === "plan" ? <ListChecks /> : <Bot />}{mode.label}</ToggleGroupItem>)}</ToggleGroup>}{onOpenGoal && <Button variant="outline" size="sm" onClick={onOpenGoal}><Target data-icon="inline-start" />{t("目标", "Goal")}</Button>}</div>{session.archived && <Button variant="outline" disabled={resumingArchive || sending} onClick={() => { setResumingArchive(true); void window.prospero.setSessionArchived(session.id, false).catch(error => setOperationError(reportError(error))).finally(() => setResumingArchive(false)); }}>{t("已归档 · 继续对话", "Archived · Resume chat")}</Button>}<InputGroup className="h-auto rounded-xl bg-card shadow-sm"><InputGroupTextarea data-chat-composer disabled={session.archived} value={draft} maxLength={MAX_CHAT_DRAFT_LENGTH} onChange={(event) => setDraft(event.target.value)} onPaste={handleComposerPaste} onKeyDown={handleComposerKeyDown} role="combobox" aria-label={t("消息", "Message")} aria-autocomplete="list" aria-expanded={skills.length > 0} aria-controls={skills.length ? skillListId : undefined} aria-activedescendant={skills.length ? `${skillListId}-${String(Math.max(0, activeSkillIndex))}` : undefined} placeholder={isBotSession ? t("向 Prospero Bot 发送全局指令，如“在某工作区派发会话完成某任务”…", "Ask Prospero Bot to dispatch tasks to any workspace…") : t("发送消息；输入 $ 加载 Skill…", "Send a message; type $ to load a skill…")} rows={3} className="min-h-20" />{skills.length > 0 && <div id={skillListId} role="listbox" className="absolute inset-x-2 bottom-full mb-2 flex max-h-56 flex-col gap-1 overflow-auto rounded-xl border bg-popover p-1 shadow-xl">{skills.map((skill, index) => <Button id={`${skillListId}-${String(index)}`} role="option" aria-selected={index === activeSkillIndex} variant={index === activeSkillIndex ? "secondary" : "ghost"} className="h-auto justify-start" key={skill.value} onMouseEnter={() => setActiveSkillIndex(index)} onMouseDown={(event) => { event.preventDefault(); chooseSkill(skill); }} onClick={() => chooseSkill(skill)}><span className="flex min-w-0 flex-col items-start gap-0.5"><strong>${skill.label ?? skill.value}</strong>{skill.detail && <small className="text-muted-foreground">{skill.detail}</small>}</span></Button>)}</div>}<InputGroupAddon align="block-end" className="justify-between gap-2 border-t"><div className="chat-composer-actions flex min-w-0 flex-wrap items-center gap-2"><ModelSwitcher key={session.id} session={session} account={account} />{isBotSession && !composerOptionsOpen && <><MasterHarnessConfigDialog session={session} account={account} snapshot={snapshot} onSwitched={onSwitchBotSession} onError={setOperationError} /><CrossModelChildLauncher session={session} snapshot={snapshot} onCreated={(id, jump) => { if (jump) openSessionHandler?.(id); }} onError={setOperationError} /></>}<Button variant="ghost" size="sm" aria-expanded={composerOptionsOpen} aria-controls={composerOptionsId} onClick={() => setComposerOptionsOpen(value => !value)}>{t("选项", "Options")}{modes?.currentMode && modes.currentMode !== "default" && <span> · {modes.modes.find(mode => mode.id === modes.currentMode)?.label ?? modes.currentMode}</span>}<ChevronDown /></Button>{sessionBusy && <ToggleGroup value={[busyDelivery]} onValueChange={(values) => { if (values[0] === "queue" || values[0] === "steer") setBusyDelivery(values[0]); }} variant="outline" size="sm" aria-label={t("发送方式", "Delivery mode")}><ToggleGroupItem value="queue" title={t("当前轮结束后发送", "Send after the current turn")}>{t("排队", "Queue")}</ToggleGroupItem><ToggleGroupItem value="steer" title={t("尝试引导当前轮；无法引导时排到队首", "Try to steer the current turn; queue first if unavailable")}>{t("引导", "Steer")}</ToggleGroupItem></ToggleGroup>}<InputGroupButton size="sm" disabled={sending || attaching} title={t("上传图片", "Upload images")} onClick={() => fileInput.current?.click()}><Paperclip data-icon="inline-start" />{attaching ? t("处理中", "Processing") : t("附件", "Attach")}</InputGroupButton><input ref={fileInput} hidden type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => void attach(event.target.files)} /></div><Button data-chat-send onClick={() => void send()} disabled={session.archived || (!draft.trim() && !attachments.length) || sending || attaching}>{sending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}{sending ? t("发送中", "Sending") : t("发送", "Send")}</Button></InputGroupAddon></InputGroup><p className="text-center text-xs text-muted-foreground">{t("Enter 发送 · Shift + Enter 换行 · 最多 6 张，单张 5 MB / 共 10 MB", "Enter to send · Shift + Enter for a new line · Up to 6 images, 5 MB each / 10 MB total")}</p></div></div>
    <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) closeDetail(); }}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{detail?.title}</DialogTitle><DialogDescription>{t("可选择部分内容，或复制全部已显示内容。", "Select part of the output, or copy all displayed content.")}</DialogDescription></DialogHeader>{detail?.loading ? <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Spinner />{t("正在读取…", "Loading…")}</div> : <>{detail?.truncated && <Alert><CircleAlert /><AlertTitle>{t("输出已截断", "Output truncated")}</AlertTitle><AlertDescription>{t("daemon 仅保留了这次工具输出的前 200,000 个字符。", "The daemon retained only the first 200,000 characters of this tool output.")}</AlertDescription></Alert>}<pre className="terminal-output-text max-h-[60vh] overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">{detail?.content}</pre></>}<DialogFooter>{detail?.content && <Button variant="outline" onClick={() => void window.prospero.writeClipboard(detail.content)}><Copy data-icon="inline-start" />{t("复制", "Copy")}</Button>}<Button variant="outline" onClick={closeDetail}>{t("关闭", "Close")}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
