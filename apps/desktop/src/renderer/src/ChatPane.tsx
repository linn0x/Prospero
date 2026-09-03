import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type UIEvent } from "react";
import { Bot, Check, ChevronDown, CircleAlert, Code2, ExternalLink, FileImage, ListChecks, Paperclip, Send, ShieldAlert, Target, UserRound, X } from "lucide-react";
import type { AgentModeCatalog, JsonObject, SessionInfo, SkillSuggestion } from "../../shared/types";
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
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { array, displayError, number, record, text } from "./state";
import { useLocale } from "./locale";
import {
  CHAT_TIMELINE_WINDOW_SIZE,
  MAX_CHAT_DRAFT_LENGTH,
  ChatEventAccumulator,
  collapseChatEventHistory,
  getChatPollReconnectDelay,
  getChatTimelineItemWindow,
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
  if (!text(diff.patch)) return null;
  return <Collapsible className="flex flex-col gap-2"><CollapsibleTrigger render={<Button variant="outline" size="sm" />}><ChevronDown data-icon="inline-start" />{text(diff.path, t("文件改动", "File changes"))}<Badge variant="secondary">+{number(diff.additions)} −{number(diff.deletions)}</Badge></CollapsibleTrigger><CollapsibleContent><pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">{text(diff.patch)}</pre></CollapsibleContent></Collapsible>;
}

function QuestionCard({ event, isDone, sessionId, onError }: { event: JsonObject; isDone: boolean; sessionId: string; onError: (message?: string) => void }) {
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
    } catch (reason) { onError(displayError(reason)); } finally { busyRef.current = false; setBusy(false); }
  };
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><CircleAlert className="size-4" />{t("Agent 需要你的选择", "Agent needs your input")}</CardTitle><CardDescription>{t("完成以下问题后，Agent 会继续当前任务。", "Answer the questions below and the agent will continue.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">{questions.map((question, index) => {
    const id = text(question.id);
    const labelId = `${labelPrefix}-${String(index)}`;
    return <section className="flex flex-col gap-3" key={id}>{text(question.header) && <Badge variant="outline" className="w-fit">{text(question.header)}</Badge>}<strong id={labelId}>{text(question.question)}</strong>{!isDone && <><ToggleGroup aria-labelledby={labelId} value={selections[id] ?? []} multiple={question.multiSelect === true} onValueChange={(values) => setSelections((current) => ({ ...current, [id]: values }))} variant="outline" className="grid grid-cols-1 gap-2 md:grid-cols-2">{array(question.options).map(record).map((option) => <ToggleGroupItem value={text(option.label)} key={text(option.label)} className="h-auto min-w-0 items-start justify-start py-3 text-left"><span className="flex min-w-0 flex-col gap-1"><b>{text(option.label)}</b><small className="text-muted-foreground">{text(option.description, text(option.preview))}</small></span></ToggleGroupItem>)}</ToggleGroup>{question.allowOther === true && <Input aria-labelledby={labelId} type={question.secret === true ? "password" : "text"} value={other[id] ?? ""} onChange={(input) => setOther((current) => ({ ...current, [id]: input.target.value }))} placeholder={t("其他回答", "Other answer")} autoComplete="off" />}</>}</section>;
  })}{isDone && <Badge variant="secondary" className="w-fit"><Check />{t("已回答", "Answered")}</Badge>}</CardContent>{!isDone && <CardFooter className="justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => void reply(true)}>{t("取消问题", "Cancel questions")}</Button><Button disabled={busy || !canSubmit} onClick={() => void reply()}>{busy && <Spinner data-icon="inline-start" />}{t("提交回答", "Submit answers")}</Button></CardFooter>}</Card>;
}

function ToolCard({ event, openOutput }: { event: JsonObject; openOutput: (id: string, tool: string) => void }) {
  const { t, status } = useLocale();
  const kind = text(event.kind); const state = text(event.state, kind === "tool.start" ? "running" : "success"); const callId = text(event.callId);
  return <Card size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><Code2 className="size-4" />{text(event.tool, t("工具调用", "Tool call"))}</CardTitle><CardDescription>{text(event.summary, state === "running" ? t("正在执行…", "Running…") : t("执行完成", "Completed"))}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><DiffBlock value={event.diff} />{kind === "tool.end" && event.hasMore === true && callId && <Button variant="outline" size="sm" className="w-fit" onClick={() => openOutput(callId, text(event.tool, t("工具输出", "Tool output")))}><ExternalLink data-icon="inline-start" />{t("查看完整输出", "View full output")}</Button>}</CardContent><CardFooter><Badge variant={state === "error" || state === "failed" ? "destructive" : "secondary"}>{status(state)}</Badge></CardFooter></Card>;
}

function PermissionCard({ event, isDone, sessionId, onError }: { event: JsonObject; isDone: boolean; sessionId: string; onError: (message?: string) => void }) {
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
      onError(displayError(reason));
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  };
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldAlert className="size-4" />{text(event.summary, t("Agent 请求权限", "Agent requests permission"))}</CardTitle><CardDescription>{t("请确认这项操作是否可以继续。", "Confirm whether this operation may continue.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{array(event.resources).length > 0 && <pre className="rounded-lg bg-muted p-3 text-xs">{array(event.resources).map(String).join("\n")}</pre>}<DiffBlock value={event.diff} />{isDone && <Badge variant="secondary" className="w-fit"><Check />{t("已处理", "Resolved")}</Badge>}</CardContent>{!isDone && <CardFooter className="justify-end gap-2"><Button variant="destructive" disabled={Boolean(busy)} onClick={() => void reply("reject")}>{busy === "reject" && <Spinner data-icon="inline-start" />}{t("拒绝", "Reject")}</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => void reply("always")}>{busy === "always" && <Spinner data-icon="inline-start" />}{t("本会话允许", "Allow for session")}</Button><Button disabled={Boolean(busy)} onClick={() => void reply("once")}>{busy === "once" && <Spinner data-icon="inline-start" />}{t("允许一次", "Allow once")}</Button></CardFooter>}</Card>;
}

type EventProps = { event: JsonObject; isResolved: boolean; sessionId: string; onError: (message?: string) => void; openOutput: (id: string, tool: string) => void; openSubagent: (id: string, label: string) => void };
const EventCard = memo(function EventCard({ event, isResolved, sessionId, onError, openOutput, openSubagent }: EventProps) {
  const { t, status } = useLocale();
  const kind = text(event.kind);
  if (kind === "user.message") return <Message align="end"><MessageAvatar><Avatar><AvatarFallback><UserRound className="size-4" /></AvatarFallback></Avatar></MessageAvatar><MessageContent><MessageHeader>{t("你", "You")}</MessageHeader><Bubble align="end"><BubbleContent className="whitespace-pre-wrap">{text(event.text)}</BubbleContent></Bubble></MessageContent></Message>;
  if (kind === "assistant.text") return <Message><MessageAvatar><Avatar><AvatarFallback><Bot className="size-4" /></AvatarFallback></Avatar></MessageAvatar><MessageContent><MessageHeader>Agent</MessageHeader><Bubble variant="ghost"><BubbleContent className="whitespace-pre-wrap text-[0.925rem] leading-7">{text(event.text)}</BubbleContent></Bubble></MessageContent></Message>;
  if (kind === "reasoning") return <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" />}><ChevronDown data-icon="inline-start" />{t("思考过程", "Reasoning")}</CollapsibleTrigger><CollapsibleContent><pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">{text(event.text)}</pre></CollapsibleContent></Collapsible>;
  if (kind === "tool.start" || kind === "tool.end") return <ToolCard event={event} openOutput={openOutput} />;
  if (kind === "permission.request") return <PermissionCard event={event} isDone={isResolved} sessionId={sessionId} onError={onError} />;
  if (kind === "permission.auto") return <Alert><ShieldAlert /><AlertTitle>{t("已按", "Automatically allowed by")} {text(event.policy, t("策略", "policy"))}</AlertTitle><AlertDescription>{text(event.summary)}</AlertDescription></Alert>;
  if (kind === "question.request") return <QuestionCard event={event} isDone={isResolved} sessionId={sessionId} onError={onError} />;
  if (kind === "agent.error") return <Alert variant="destructive"><X /><AlertTitle>{t("Agent 运行错误", "Agent runtime error")}</AlertTitle><AlertDescription>{text(event.message)}</AlertDescription></Alert>;
  if (kind === "subagent.started" || kind === "subagent.updated") {
    const subagent = record(event.subagent); const id = text(subagent.id, text(event.subagentId)); const label = text(subagent.name, text(event.summary, id));
    return <Card size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><Bot className="size-4" />{t("子 Agent", "Subagent")}</CardTitle><CardDescription>{label}</CardDescription></CardHeader><CardContent>{id && <Button variant="outline" size="sm" onClick={() => openSubagent(id, label)}><ExternalLink data-icon="inline-start" />{t("查看执行详情", "View execution details")}</Button>}</CardContent><CardFooter><Badge variant="secondary">{status(text(subagent.status, text(event.status, "active")))}</Badge></CardFooter></Card>;
  }
  if (kind === "trajectory.record") return <Alert><Bot /><AlertTitle>{text(event.title)}</AlertTitle><AlertDescription>{text(event.detail)} · {text(event.phase)}</AlertDescription></Alert>;
  if (kind === "turn.end") return <Marker variant="separator"><MarkerIcon><Check /></MarkerIcon><MarkerContent>{text(event.finish) === "failed" ? t("本轮失败", "Turn failed") : text(event.finish) === "interrupted" ? t("本轮已停止", "Turn stopped") : t("本轮完成", "Turn complete")}{number(event.outputTokens) > 0 && ` · ${String(number(event.outputTokens))} tokens`}</MarkerContent></Marker>;
  return null;
});

type TimelineItemProps = Omit<EventProps, "event"> & { item: ChatTimelineItem };
const TimelineItem = memo(function TimelineItem({ item, ...props }: TimelineItemProps) {
  const kind = text(item.event.kind);
  return <MessageScrollerItem key={item.key} messageId={item.key} scrollAnchor={kind === "user.message"}><EventCard event={item.event} {...props} /></MessageScrollerItem>;
});

type PendingAttachment = { id: string; name: string; mimeType: string; dataB64: string };
type ChatDraftState = { sessionId: string; text: string };
async function fileToAttachment(file: File): Promise<PendingAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { id: crypto.randomUUID(), name: file.name, mimeType: file.type, dataB64: btoa(binary) };
}

export function ChatPane({ session, onOpenGoal }: { session: SessionInfo; onOpenGoal?: () => void }) {
  const { t } = useLocale();
  const accumulator = useRef<ChatEventAccumulator | null>(null); if (!accumulator.current) accumulator.current = new ChatEventAccumulator();
  const [timeline, setTimeline] = useState(() => accumulator.current!.snapshot()); const cursor = useRef<number | undefined>(undefined);
  const [historyCursor, setHistoryCursor] = useState<ChatHistoryCursor | null>(null); const historyCursorRef = useRef<ChatHistoryCursor | null>(null);
  const timelineEndRef = useRef(0); timelineEndRef.current = timeline.nextOrdinal;
  const timelineViewport = useRef<HTMLDivElement | null>(null); const jumpToLatestRef = useRef(false);
  const [draftState, setDraftState] = useState<ChatDraftState>(() => ({ sessionId: session.id, text: loadChatDraft(session.id) }));
  const draftRef = useRef(draftState); draftRef.current = draftState;
  const draft = draftState.sessionId === session.id ? draftState.text : "";
  const setDraft = useCallback((next: string | ((current: string) => string)): void => {
    const current = draftRef.current.sessionId === session.id ? draftRef.current.text : "";
    const value = limitChatDraftText(typeof next === "function" ? next(current) : next);
    const state = { sessionId: session.id, text: value };
    draftRef.current = state;
    setDraftState(state);
  }, [session.id]);
  const sendingDraftRef = useRef<ChatDraftState | undefined>(undefined);
  const [sending, setSending] = useState(false); const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [skills, setSkills] = useState<SkillSuggestion[]>([]); const [modes, setModes] = useState<AgentModeCatalog>(); const [modeBusy, setModeBusy] = useState(false);
  const [error, setError] = useState<string>(); const [detail, setDetail] = useState<{ title: string; content: string; loading?: boolean }>(); const fileInput = useRef<HTMLInputElement>(null);
  const historyWindow = useMemo(() => getChatTimelineItemWindow(timeline.items, timeline.nextOrdinal, historyCursor?.end ?? null), [historyCursor, timeline]);
  const visibleItems = useMemo(() => timeline.items.slice(historyWindow.start, historyWindow.end), [historyWindow.end, historyWindow.start, timeline]);
  const selectHistoryCursor = useCallback((next: ChatHistoryCursor | null): void => { historyCursorRef.current = next; setHistoryCursor(next); }, []);
  const jumpToLatest = useCallback((): void => { jumpToLatestRef.current = true; selectHistoryCursor(null); }, [selectHistoryCursor]);
  const handleTimelineScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget;
    const current = historyCursorRef.current;
    const next = updateChatHistoryCursorFromScroll(current, isChatViewportNearEnd(element), timelineEndRef.current);
    if (next === current) return;
    if (current?.mode === "frozen" && next === null) jumpToLatestRef.current = true;
    selectHistoryCursor(next);
  }, [selectHistoryCursor]);
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
    persistChatDraft(current.sessionId, current.text);
    const next = { sessionId: session.id, text: loadChatDraft(session.id) };
    draftRef.current = next;
    setDraftState(next);
  }, [session.id]);
  useEffect(() => {
    if (draftState.sessionId !== session.id || sending) return;
    const timer = window.setTimeout(() => persistChatDraft(session.id, draftState.text), 180);
    return () => window.clearTimeout(timer);
  }, [draftState, sending, session.id]);
  useEffect(() => () => {
    const current = draftRef.current;
    const pending = sendingDraftRef.current;
    persistChatDraft(
      current.sessionId,
      current.text || (pending?.sessionId === current.sessionId ? pending.text : ""),
    );
  }, []);
  useEffect(() => { setTimeline(accumulator.current!.reset([])); cursor.current = undefined; jumpToLatestRef.current = false; selectHistoryCursor(null); setAttachments([]); setSkills([]); void window.prospero.getAgentModes(session.id).then(setModes).catch(() => setModes(undefined)); }, [selectHistoryCursor, session.id]);
  useEffect(() => { const match = draft.match(/(?:^|\s)\$([^\s]*)$/); if (!match) { setSkills([]); return; } const timer = window.setTimeout(() => void window.prospero.getSkillSuggestions(session.id, match[1] ?? "").then(setSkills).catch(() => setSkills([])), 160); return () => window.clearTimeout(timer); }, [draft, session.id]);
  useEffect(() => {
    let active = true; let timer: number | undefined; let errorDelay = 1_000; let pollFailed = false;
    const poll = async (): Promise<void> => { let nextDelay = 25; const startedAt = performance.now(); try { const frame = await window.prospero.getSessionView(session.id, cursor.current === undefined ? {} : { afterSeq: cursor.current, waitMs: 20_000 }); if (!active) return; nextDelay = getChatPollReconnectDelay(Boolean(frame), performance.now() - startedAt); if (frame) { const incoming = array(frame.events).map(record); if (text(frame.mode) === "delta") { const next = accumulator.current!.append(incoming); if (next) setTimeline(next); } else { setTimeline(accumulator.current!.reset(incoming)); jumpToLatestRef.current = false; selectHistoryCursor(null); } cursor.current = number(frame.evSeq, number(frame.seq)); setError(undefined); } else if (pollFailed) setError(undefined); pollFailed = false; errorDelay = 1_000; } catch (reason) { if (active) setError(displayError(reason)); pollFailed = true; nextDelay = errorDelay; errorDelay = Math.min(8_000, errorDelay * 2); } if (active) timer = window.setTimeout(() => void poll(), nextDelay); };
    void poll(); return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [selectHistoryCursor, session.id]);
  const send = async (): Promise<void> => {
    const value = draft.trim();
    if ((!value && !attachments.length) || sending) return;
    setSending(true);
    sendingDraftRef.current = { sessionId: session.id, text: draft };
    setDraft("");
    const queued = attachments;
    setAttachments([]);
    try {
      await window.prospero.interact(session.id, { type: "chat.send", text: value, attachments: queued.map(({ name, mimeType, dataB64 }) => ({ name, mimeType, dataB64 })) });
      sendingDraftRef.current = undefined;
      persistChatDraft(session.id, draftRef.current.text);
      setError(undefined);
    } catch (reason) {
      const failedDraft = sendingDraftRef.current?.text ?? value;
      sendingDraftRef.current = undefined;
      setDraft((current) => mergeFailedChatDraft(failedDraft, current));
      setAttachments(queued);
      setError(displayError(reason));
    } finally {
      setSending(false);
    }
  };
  const attach = async (files: FileList | null): Promise<void> => { if (!files) return; if (sending) { setError(t("请等待当前消息发送完成后再添加附件", "Wait for the current message to finish sending before attaching files")); if (fileInput.current) fileInput.current.value = ""; return; } const accepted = [...files].filter((file) => ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)); if (attachments.length + accepted.length > 6) { setError(t("每条消息最多上传 6 张图片", "You can upload up to 6 images per message")); return; } const oversized = accepted.find((file) => file.size > 6 * 1024 * 1024); if (oversized) { setError(`${oversized.name} ${t("超过 6 MB", "exceeds 6 MB")}`); return; } try { const converted = await Promise.all(accepted.map(fileToAttachment)); setAttachments((current) => [...current, ...converted]); } catch (reason) { setError(displayError(reason)); } if (fileInput.current) fileInput.current.value = ""; };
  const chooseSkill = (skill: SkillSuggestion): void => { setDraft((current) => current.replace(/(?:^|\s)\$[^\s]*$/, (match) => `${match.startsWith(" ") ? " " : ""}$${skill.value} `)); setSkills([]); };
  const setMode = async (mode: string): Promise<void> => { setModeBusy(true); try { const result = await window.prospero.setAgentMode(session.id, mode); setModes((current) => current ? { ...current, currentMode: result.currentMode } : current); } catch (reason) { setError(displayError(reason)); } finally { setModeBusy(false); } };
  const openOutput = useCallback(async (id: string, tool: string): Promise<void> => { setDetail({ title: `${tool} · ${t("完整输出", "Full output")}`, content: "", loading: true }); try { const result = await window.prospero.getToolOutput(session.id, id); setDetail({ title: `${tool} · ${t("完整输出", "Full output")}`, content: text(result.output, t("（无输出）", "(No output)")) }); } catch (reason) { setDetail(undefined); setError(displayError(reason)); } }, [session.id, t]);
  const openSubagent = useCallback(async (id: string, label: string): Promise<void> => { setDetail({ title: `${t("子 Agent", "Subagent")} · ${label}`, content: "", loading: true }); try { const result = await window.prospero.getSubagentEvents(session.id, id); const lines = collapseChatEventHistory(array(result.events).map(record)).map((event) => `${text(event.kind)}${text(event.text, text(event.summary, text(event.message, text(event.detail)))) ? `\n${text(event.text, text(event.summary, text(event.message, text(event.detail))))}` : ""}`); setDetail({ title: `${t("子 Agent", "Subagent")} · ${label}`, content: lines.join("\n\n") || t("（尚无事件）", "(No events yet)") }); } catch (reason) { setDetail(undefined); setError(displayError(reason)); } }, [session.id, t]);
  return <div className="flex size-full min-h-0 flex-col bg-background">
    <MessageScrollerProvider autoScroll><MessageScroller><MessageScrollerViewport ref={timelineViewport} onScroll={handleTimelineScroll} aria-label={t("会话消息时间线", "Conversation message timeline")}><MessageScrollerContent className="mx-auto w-full max-w-4xl px-6 py-8">{!timeline.items.length && <Empty className="my-auto"><EmptyHeader><EmptyMedia variant="icon"><Bot /></EmptyMedia><EmptyTitle>{t("开始与", "Start collaborating with")} {session.agent}</EmptyTitle><EmptyDescription>{t("消息、工具调用、审批、提问和子 Agent 过程会按时间线显示在这里。", "Messages, tool calls, approvals, questions, and subagent activity appear here in a timeline.")}</EmptyDescription></EmptyHeader></Empty>}{historyWindow.start > 0 && <div className="flex justify-center"><Button variant="outline" size="sm" onClick={() => selectHistoryCursor({ end: historyWindow.cursorStart, mode: "page" })}><ChevronDown className="rotate-180" data-icon="inline-start" />{t(`查看更早的 ${String(Math.min(CHAT_TIMELINE_WINDOW_SIZE, historyWindow.start))} 条记录`, `View ${String(Math.min(CHAT_TIMELINE_WINDOW_SIZE, historyWindow.start))} earlier events`)}</Button></div>}{visibleItems.map((item) => { const kind = text(item.event.kind); const isResolved = kind === "permission.request" ? hasChatResolution(timeline.resolutions, "permission.resolved", text(item.event.reqId)) : kind === "question.request" ? hasChatResolution(timeline.resolutions, "question.resolved", text(item.event.reqId)) : false; return <TimelineItem key={item.key} item={item} isResolved={isResolved} sessionId={session.id} onError={setError} openOutput={openOutput} openSubagent={openSubagent} />; })}{!historyWindow.isLatest && <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground"><span>{t(`当前显示 ${String(historyWindow.start + 1)}–${String(historyWindow.end)}，另有 ${String(historyWindow.newerCount)} 条较新记录`, `Showing ${String(historyWindow.start + 1)}–${String(historyWindow.end)} with ${String(historyWindow.newerCount)} newer events`)}</span><Button variant="outline" size="sm" onClick={() => { const nextEnd = Math.min(timeline.items.length, historyWindow.end + CHAT_TIMELINE_WINDOW_SIZE); if (nextEnd >= timeline.items.length) jumpToLatest(); else selectHistoryCursor({ end: timeline.items[nextEnd]?.ordinal ?? timeline.nextOrdinal, mode: "page" }); }}>{t("查看较新记录", "View newer events")}<ChevronDown data-icon="inline-end" /></Button><Button size="sm" onClick={jumpToLatest}>{t("回到最新", "Jump to latest")}</Button></div>}</MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton /></MessageScroller></MessageScrollerProvider>
    <div className="border-t bg-background/95 px-4 py-3 backdrop-blur"><div className="mx-auto flex max-w-4xl flex-col gap-2">{error && <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("会话操作失败", "Session action failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}{attachments.length > 0 && <AttachmentGroup>{attachments.map((item) => <Attachment state="idle" size="sm" key={item.id}><AttachmentMedia><FileImage /></AttachmentMedia><AttachmentContent><AttachmentTitle>{item.name}</AttachmentTitle><AttachmentDescription>{t("图片 · 等待发送", "Image · waiting to send")}</AttachmentDescription></AttachmentContent><AttachmentActions><AttachmentAction aria-label={`${t("移除", "Remove")} ${item.name}`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}><X /></AttachmentAction></AttachmentActions></Attachment>)}</AttachmentGroup>}
      <InputGroup className="h-auto rounded-xl bg-card shadow-sm"><InputGroupTextarea value={draft} maxLength={MAX_CHAT_DRAFT_LENGTH} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={t("发送消息；输入 $ 加载 Skill…", "Send a message; type $ to load a skill…")} rows={3} className="min-h-20" />{skills.length > 0 && <div className="absolute inset-x-2 bottom-full mb-2 flex max-h-56 flex-col gap-1 overflow-auto rounded-xl border bg-popover p-1 shadow-xl">{skills.map((skill) => <Button variant="ghost" className="h-auto justify-start" key={skill.value} onMouseDown={(event) => { event.preventDefault(); chooseSkill(skill); }}><span className="flex min-w-0 flex-col items-start gap-0.5"><strong>${skill.label ?? skill.value}</strong>{skill.detail && <small className="text-muted-foreground">{skill.detail}</small>}</span></Button>)}</div>}<InputGroupAddon align="block-end" className="justify-between gap-2 border-t"><div className="flex min-w-0 items-center gap-2">{modes && <ToggleGroup value={modes.currentMode ? [modes.currentMode] : []} onValueChange={(values) => values[0] && void setMode(values[0])} disabled={modeBusy} variant="outline" size="sm">{modes.modes.map((mode) => <ToggleGroupItem key={mode.id} value={mode.id} title={mode.description}>{mode.id === "plan" ? <ListChecks /> : <Bot />}{mode.label}</ToggleGroupItem>)}</ToggleGroup>}{onOpenGoal && <Button variant="outline" size="sm" onClick={onOpenGoal}><Target data-icon="inline-start" />{t("目标", "Goal")}</Button>}<InputGroupButton size="sm" disabled={sending} title={t("上传图片", "Upload images")} onClick={() => fileInput.current?.click()}><Paperclip data-icon="inline-start" />{t("附件", "Attach")}</InputGroupButton><input ref={fileInput} hidden type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => void attach(event.target.files)} /></div><Button onClick={() => void send()} disabled={(!draft.trim() && !attachments.length) || sending}>{sending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}{sending ? t("发送中", "Sending") : t("发送", "Send")}</Button></InputGroupAddon></InputGroup><p className="text-center text-xs text-muted-foreground">{t("Enter 发送 · Shift + Enter 换行 · 最多 6 张图片", "Enter to send · Shift + Enter for a new line · Up to 6 images")}</p></div></div>
    <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(undefined); }}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{detail?.title}</DialogTitle><DialogDescription>{t("内容按需从本机 daemon 读取，不会进入渲染进程持久存储。", "Content is read from the local daemon on demand and is not persisted by the renderer.")}</DialogDescription></DialogHeader>{detail?.loading ? <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Spinner />{t("正在读取…", "Loading…")}</div> : <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">{detail?.content}</pre>}<DialogFooter><Button variant="outline" onClick={() => setDetail(undefined)}>{t("关闭", "Close")}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
