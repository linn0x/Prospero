import { useEffect, useMemo, useRef, useState } from "react";
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

const resolved = (events: JsonObject[], kind: string, reqId: string): boolean => events.some((event) => text(event.kind) === kind && text(event.reqId) === reqId);

function DiffBlock({ value }: { value: unknown }) {
  const { t } = useLocale();
  const diff = record(value);
  if (!text(diff.patch)) return null;
  return <Collapsible className="flex flex-col gap-2"><CollapsibleTrigger render={<Button variant="outline" size="sm" />}><ChevronDown data-icon="inline-start" />{text(diff.path, t("文件改动", "File changes"))}<Badge variant="secondary">+{number(diff.additions)} −{number(diff.deletions)}</Badge></CollapsibleTrigger><CollapsibleContent><pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">{text(diff.patch)}</pre></CollapsibleContent></Collapsible>;
}

function QuestionCard({ event, events, sessionId, onError }: { event: JsonObject; events: JsonObject[]; sessionId: string; onError: (message?: string) => void }) {
  const { t } = useLocale();
  const reqId = text(event.reqId);
  const isDone = resolved(events, "question.resolved", reqId);
  const questions = array(event.questions).map(record);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const canSubmit = questions.every((question) => (selections[text(question.id)] ?? []).length || (other[text(question.id)] ?? "").trim());
  const reply = async (cancelled = false): Promise<void> => {
    setBusy(true);
    try {
      const answers = cancelled ? [] : questions.map((question) => {
        const id = text(question.id); const custom = (other[id] ?? "").trim();
        return { questionId: id, values: [...(selections[id] ?? []), ...(custom ? [custom] : [])] };
      }).filter((answer) => answer.values.length);
      await window.prospero.interact(sessionId, { type: "question.respond", reqId, answers, ...(cancelled ? { cancelled: true } : {}) });
    } catch (reason) { onError(displayError(reason)); } finally { setBusy(false); }
  };
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><CircleAlert className="size-4" />{t("Agent 需要你的选择", "Agent needs your input")}</CardTitle><CardDescription>{t("完成以下问题后，Agent 会继续当前任务。", "Answer the questions below and the agent will continue.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">{questions.map((question) => {
    const id = text(question.id);
    return <section className="flex flex-col gap-3" key={id}>{text(question.header) && <Badge variant="outline" className="w-fit">{text(question.header)}</Badge>}<strong>{text(question.question)}</strong>{!isDone && <><ToggleGroup value={selections[id] ?? []} multiple={question.multiSelect === true} onValueChange={(values) => setSelections((current) => ({ ...current, [id]: values }))} variant="outline" className="grid grid-cols-1 gap-2 md:grid-cols-2">{array(question.options).map(record).map((option) => <ToggleGroupItem value={text(option.label)} key={text(option.label)} className="h-auto min-w-0 items-start justify-start py-3 text-left"><span className="flex min-w-0 flex-col gap-1"><b>{text(option.label)}</b><small className="text-muted-foreground">{text(option.description, text(option.preview))}</small></span></ToggleGroupItem>)}</ToggleGroup>{question.allowOther === true && <Input type={question.secret === true ? "password" : "text"} value={other[id] ?? ""} onChange={(input) => setOther((current) => ({ ...current, [id]: input.target.value }))} placeholder={t("其他回答", "Other answer")} autoComplete="off" />}</>}</section>;
  })}{isDone && <Badge variant="secondary" className="w-fit"><Check />{t("已回答", "Answered")}</Badge>}</CardContent>{!isDone && <CardFooter className="justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => void reply(true)}>{t("取消问题", "Cancel questions")}</Button><Button disabled={busy || !canSubmit} onClick={() => void reply()}>{busy && <Spinner data-icon="inline-start" />}{t("提交回答", "Submit answers")}</Button></CardFooter>}</Card>;
}

function ToolCard({ event, openOutput }: { event: JsonObject; openOutput: (id: string, tool: string) => void }) {
  const { t, status } = useLocale();
  const kind = text(event.kind); const state = text(event.state, kind === "tool.start" ? "running" : "success"); const callId = text(event.callId);
  return <Card size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><Code2 className="size-4" />{text(event.tool, t("工具调用", "Tool call"))}</CardTitle><CardDescription>{text(event.summary, state === "running" ? t("正在执行…", "Running…") : t("执行完成", "Completed"))}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><DiffBlock value={event.diff} />{kind === "tool.end" && event.hasMore === true && callId && <Button variant="outline" size="sm" className="w-fit" onClick={() => openOutput(callId, text(event.tool, t("工具输出", "Tool output")))}><ExternalLink data-icon="inline-start" />{t("查看完整输出", "View full output")}</Button>}</CardContent><CardFooter><Badge variant={state === "error" || state === "failed" ? "destructive" : "secondary"}>{status(state)}</Badge></CardFooter></Card>;
}

type EventProps = { event: JsonObject; events: JsonObject[]; sessionId: string; onError: (message?: string) => void; openOutput: (id: string, tool: string) => void; openSubagent: (id: string, label: string) => void };
function EventCard({ event, events, sessionId, onError, openOutput, openSubagent }: EventProps) {
  const { t, status } = useLocale();
  const kind = text(event.kind);
  if (kind === "user.message") return <Message align="end"><MessageAvatar><Avatar><AvatarFallback><UserRound className="size-4" /></AvatarFallback></Avatar></MessageAvatar><MessageContent><MessageHeader>{t("你", "You")}</MessageHeader><Bubble align="end"><BubbleContent className="whitespace-pre-wrap">{text(event.text)}</BubbleContent></Bubble></MessageContent></Message>;
  if (kind === "assistant.text") return <Message><MessageAvatar><Avatar><AvatarFallback><Bot className="size-4" /></AvatarFallback></Avatar></MessageAvatar><MessageContent><MessageHeader>Agent</MessageHeader><Bubble variant="ghost"><BubbleContent className="whitespace-pre-wrap text-[0.925rem] leading-7">{text(event.text)}</BubbleContent></Bubble></MessageContent></Message>;
  if (kind === "reasoning") return <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" />}><ChevronDown data-icon="inline-start" />{t("思考过程", "Reasoning")}</CollapsibleTrigger><CollapsibleContent><pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">{text(event.text)}</pre></CollapsibleContent></Collapsible>;
  if (kind === "tool.start" || kind === "tool.end") return <ToolCard event={event} openOutput={openOutput} />;
  if (kind === "permission.request") {
    const isDone = resolved(events, "permission.resolved", text(event.reqId));
    const reply = async (value: string): Promise<void> => { try { await window.prospero.interact(sessionId, { type: "permission.respond", reqId: text(event.reqId), reply: value }); } catch (reason) { onError(displayError(reason)); } };
    return <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldAlert className="size-4" />{text(event.summary, t("Agent 请求权限", "Agent requests permission"))}</CardTitle><CardDescription>{t("请确认这项操作是否可以继续。", "Confirm whether this operation may continue.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{array(event.resources).length > 0 && <pre className="rounded-lg bg-muted p-3 text-xs">{array(event.resources).map(String).join("\n")}</pre>}<DiffBlock value={event.diff} />{isDone && <Badge variant="secondary" className="w-fit"><Check />{t("已处理", "Resolved")}</Badge>}</CardContent>{!isDone && <CardFooter className="justify-end gap-2"><Button variant="destructive" onClick={() => void reply("reject")}>{t("拒绝", "Reject")}</Button><Button variant="outline" onClick={() => void reply("always")}>{t("本会话允许", "Allow for session")}</Button><Button onClick={() => void reply("once")}>{t("允许一次", "Allow once")}</Button></CardFooter>}</Card>;
  }
  if (kind === "permission.auto") return <Alert><ShieldAlert /><AlertTitle>{t("已按", "Automatically allowed by")} {text(event.policy, t("策略", "policy"))}</AlertTitle><AlertDescription>{text(event.summary)}</AlertDescription></Alert>;
  if (kind === "question.request") return <QuestionCard event={event} events={events} sessionId={sessionId} onError={onError} />;
  if (kind === "agent.error") return <Alert variant="destructive"><X /><AlertTitle>{t("Agent 运行错误", "Agent runtime error")}</AlertTitle><AlertDescription>{text(event.message)}</AlertDescription></Alert>;
  if (kind === "subagent.started" || kind === "subagent.updated") {
    const subagent = record(event.subagent); const id = text(subagent.id, text(event.subagentId)); const label = text(subagent.name, text(event.summary, id));
    return <Card size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><Bot className="size-4" />{t("子 Agent", "Subagent")}</CardTitle><CardDescription>{label}</CardDescription></CardHeader><CardContent>{id && <Button variant="outline" size="sm" onClick={() => openSubagent(id, label)}><ExternalLink data-icon="inline-start" />{t("查看执行详情", "View execution details")}</Button>}</CardContent><CardFooter><Badge variant="secondary">{status(text(subagent.status, text(event.status, "active")))}</Badge></CardFooter></Card>;
  }
  if (kind === "trajectory.record") return <Alert><Bot /><AlertTitle>{text(event.title)}</AlertTitle><AlertDescription>{text(event.detail)} · {text(event.phase)}</AlertDescription></Alert>;
  if (kind === "turn.end") return <Marker variant="separator"><MarkerIcon><Check /></MarkerIcon><MarkerContent>{text(event.finish) === "failed" ? t("本轮失败", "Turn failed") : text(event.finish) === "interrupted" ? t("本轮已停止", "Turn stopped") : t("本轮完成", "Turn complete")}{number(event.outputTokens) > 0 && ` · ${String(number(event.outputTokens))} tokens`}</MarkerContent></Marker>;
  return null;
}

function collapseEvents(events: JsonObject[]): JsonObject[] {
  const output: JsonObject[] = []; const textById = new Map<string, JsonObject>(); const reasoningById = new Map<string, JsonObject>(); const toolById = new Map<string, JsonObject>();
  for (const event of events) {
    const kind = text(event.kind);
    if (kind === "text.delta") { const id = text(event.textId, text(event.msgId)); const prior = textById.get(id); if (prior) prior.text = `${text(prior.text)}${text(event.delta)}`; else { const next = { ...event, kind: "assistant.text", text: text(event.delta) }; textById.set(id, next); output.push(next); } }
    else if (kind === "reasoning.delta") { const id = text(event.msgId); const prior = reasoningById.get(id); if (prior) prior.text = `${text(prior.text)}${text(event.delta)}`; else { const next = { ...event, kind: "reasoning", text: text(event.delta) }; reasoningById.set(id, next); output.push(next); } }
    else if (kind === "tool.start") { const next = { ...event }; toolById.set(text(event.callId), next); output.push(next); }
    else if (kind === "tool.end") { const prior = toolById.get(text(event.callId)); if (prior) Object.assign(prior, event, { kind: "tool.end", tool: prior.tool }); else output.push(event); }
    else output.push(event);
  }
  return output;
}

type PendingAttachment = { id: string; name: string; mimeType: string; dataB64: string };
async function fileToAttachment(file: File): Promise<PendingAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { id: crypto.randomUUID(), name: file.name, mimeType: file.type, dataB64: btoa(binary) };
}

export function ChatPane({ session, onOpenGoal }: { session: SessionInfo; onOpenGoal?: () => void }) {
  const { t } = useLocale();
  const [events, setEvents] = useState<JsonObject[]>([]); const cursor = useRef<number | undefined>(undefined);
  const [draft, setDraft] = useState(""); const [sending, setSending] = useState(false); const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [skills, setSkills] = useState<SkillSuggestion[]>([]); const [modes, setModes] = useState<AgentModeCatalog>(); const [modeBusy, setModeBusy] = useState(false);
  const [error, setError] = useState<string>(); const [detail, setDetail] = useState<{ title: string; content: string; loading?: boolean }>(); const fileInput = useRef<HTMLInputElement>(null);
  const rendered = useMemo(() => collapseEvents(events), [events]);
  useEffect(() => { setEvents([]); cursor.current = undefined; setAttachments([]); setSkills([]); void window.prospero.getAgentModes(session.id).then(setModes).catch(() => setModes(undefined)); }, [session.id]);
  useEffect(() => { const match = draft.match(/(?:^|\s)\$([^\s]*)$/); if (!match) { setSkills([]); return; } const timer = window.setTimeout(() => void window.prospero.getSkillSuggestions(session.id, match[1] ?? "").then(setSkills).catch(() => setSkills([])), 160); return () => window.clearTimeout(timer); }, [draft, session.id]);
  useEffect(() => {
    let active = true; let timer: number | undefined;
    const poll = async (): Promise<void> => { try { const frame = await window.prospero.getSessionView(session.id, cursor.current === undefined ? {} : { afterSeq: cursor.current }); if (!active) return; if (frame) { const incoming = array(frame.events).map(record); setEvents((current) => text(frame.mode) === "delta" ? [...current, ...incoming] : incoming); cursor.current = number(frame.evSeq, number(frame.seq)); setError(undefined); } } catch (reason) { if (active) setError(displayError(reason)); } if (active) timer = window.setTimeout(() => void poll(), 650); };
    void poll(); return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [session.id]);
  const send = async (): Promise<void> => { const value = draft.trim(); if ((!value && !attachments.length) || sending) return; setSending(true); setDraft(""); const queued = attachments; setAttachments([]); try { await window.prospero.interact(session.id, { type: "chat.send", text: value, attachments: queued.map(({ name, mimeType, dataB64 }) => ({ name, mimeType, dataB64 })) }); setError(undefined); } catch (reason) { setDraft(value); setAttachments(queued); setError(displayError(reason)); } finally { setSending(false); } };
  const attach = async (files: FileList | null): Promise<void> => { if (!files) return; const accepted = [...files].filter((file) => ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)); if (attachments.length + accepted.length > 6) { setError(t("每条消息最多上传 6 张图片", "You can upload up to 6 images per message")); return; } const oversized = accepted.find((file) => file.size > 6 * 1024 * 1024); if (oversized) { setError(`${oversized.name} ${t("超过 6 MB", "exceeds 6 MB")}`); return; } try { const converted = await Promise.all(accepted.map(fileToAttachment)); setAttachments((current) => [...current, ...converted]); } catch (reason) { setError(displayError(reason)); } if (fileInput.current) fileInput.current.value = ""; };
  const chooseSkill = (skill: SkillSuggestion): void => { setDraft((current) => current.replace(/(?:^|\s)\$[^\s]*$/, (match) => `${match.startsWith(" ") ? " " : ""}$${skill.value} `)); setSkills([]); };
  const setMode = async (mode: string): Promise<void> => { setModeBusy(true); try { const result = await window.prospero.setAgentMode(session.id, mode); setModes((current) => current ? { ...current, currentMode: result.currentMode } : current); } catch (reason) { setError(displayError(reason)); } finally { setModeBusy(false); } };
  const openOutput = async (id: string, tool: string): Promise<void> => { setDetail({ title: `${tool} · ${t("完整输出", "Full output")}`, content: "", loading: true }); try { const result = await window.prospero.getToolOutput(session.id, id); setDetail({ title: `${tool} · ${t("完整输出", "Full output")}`, content: text(result.output, t("（无输出）", "(No output)")) }); } catch (reason) { setDetail(undefined); setError(displayError(reason)); } };
  const openSubagent = async (id: string, label: string): Promise<void> => { setDetail({ title: `${t("子 Agent", "Subagent")} · ${label}`, content: "", loading: true }); try { const result = await window.prospero.getSubagentEvents(session.id, id); const lines = collapseEvents(array(result.events).map(record)).map((event) => `${text(event.kind)}${text(event.text, text(event.summary, text(event.message, text(event.detail)))) ? `\n${text(event.text, text(event.summary, text(event.message, text(event.detail))))}` : ""}`); setDetail({ title: `${t("子 Agent", "Subagent")} · ${label}`, content: lines.join("\n\n") || t("（尚无事件）", "(No events yet)") }); } catch (reason) { setDetail(undefined); setError(displayError(reason)); } };
  return <div className="flex size-full min-h-0 flex-col bg-background">
    <MessageScrollerProvider autoScroll><MessageScroller><MessageScrollerViewport><MessageScrollerContent className="mx-auto w-full max-w-4xl px-6 py-8">{!rendered.length && <Empty className="my-auto"><EmptyHeader><EmptyMedia variant="icon"><Bot /></EmptyMedia><EmptyTitle>{t("开始与", "Start collaborating with")} {session.agent}</EmptyTitle><EmptyDescription>{t("消息、工具调用、审批、提问和子 Agent 过程会按时间线显示在这里。", "Messages, tool calls, approvals, questions, and subagent activity appear here in a timeline.")}</EmptyDescription></EmptyHeader></Empty>}{rendered.map((event, index) => <MessageScrollerItem key={`${text(event.kind)}-${text(event.reqId, text(event.callId, String(index)))}`} messageId={`${text(event.kind)}-${String(index)}`} scrollAnchor={text(event.kind) === "user.message"}><EventCard event={event} events={events} sessionId={session.id} onError={setError} openOutput={(id, tool) => void openOutput(id, tool)} openSubagent={(id, label) => void openSubagent(id, label)} /></MessageScrollerItem>)}</MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton /></MessageScroller></MessageScrollerProvider>
    <div className="border-t bg-background/95 px-4 py-3 backdrop-blur"><div className="mx-auto flex max-w-4xl flex-col gap-2">{error && <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("会话操作失败", "Session action failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}{attachments.length > 0 && <AttachmentGroup>{attachments.map((item) => <Attachment state="idle" size="sm" key={item.id}><AttachmentMedia><FileImage /></AttachmentMedia><AttachmentContent><AttachmentTitle>{item.name}</AttachmentTitle><AttachmentDescription>{t("图片 · 等待发送", "Image · waiting to send")}</AttachmentDescription></AttachmentContent><AttachmentActions><AttachmentAction aria-label={`${t("移除", "Remove")} ${item.name}`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}><X /></AttachmentAction></AttachmentActions></Attachment>)}</AttachmentGroup>}
      <InputGroup className="h-auto rounded-xl bg-card shadow-sm"><InputGroupTextarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={t("发送消息；输入 $ 加载 Skill…", "Send a message; type $ to load a skill…")} rows={3} className="min-h-20" />{skills.length > 0 && <div className="absolute inset-x-2 bottom-full mb-2 flex max-h-56 flex-col gap-1 overflow-auto rounded-xl border bg-popover p-1 shadow-xl">{skills.map((skill) => <Button variant="ghost" className="h-auto justify-start" key={skill.value} onMouseDown={(event) => { event.preventDefault(); chooseSkill(skill); }}><span className="flex min-w-0 flex-col items-start gap-0.5"><strong>${skill.label ?? skill.value}</strong>{skill.detail && <small className="text-muted-foreground">{skill.detail}</small>}</span></Button>)}</div>}<InputGroupAddon align="block-end" className="justify-between gap-2 border-t"><div className="flex min-w-0 items-center gap-2">{modes && <ToggleGroup value={modes.currentMode ? [modes.currentMode] : []} onValueChange={(values) => values[0] && void setMode(values[0])} disabled={modeBusy} variant="outline" size="sm">{modes.modes.map((mode) => <ToggleGroupItem key={mode.id} value={mode.id} title={mode.description}>{mode.id === "plan" ? <ListChecks /> : <Bot />}{mode.label}</ToggleGroupItem>)}</ToggleGroup>}{onOpenGoal && <Button variant="outline" size="sm" onClick={onOpenGoal}><Target data-icon="inline-start" />{t("目标", "Goal")}</Button>}<InputGroupButton size="sm" title={t("上传图片", "Upload images")} onClick={() => fileInput.current?.click()}><Paperclip data-icon="inline-start" />{t("附件", "Attach")}</InputGroupButton><input ref={fileInput} hidden type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => void attach(event.target.files)} /></div><Button onClick={() => void send()} disabled={(!draft.trim() && !attachments.length) || sending}>{sending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}{sending ? t("发送中", "Sending") : t("发送", "Send")}</Button></InputGroupAddon></InputGroup><p className="text-center text-xs text-muted-foreground">{t("Enter 发送 · Shift + Enter 换行 · 最多 6 张图片", "Enter to send · Shift + Enter for a new line · Up to 6 images")}</p></div></div>
    <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(undefined); }}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{detail?.title}</DialogTitle><DialogDescription>{t("内容按需从本机 daemon 读取，不会进入渲染进程持久存储。", "Content is read from the local daemon on demand and is not persisted by the renderer.")}</DialogDescription></DialogHeader>{detail?.loading ? <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Spinner />{t("正在读取…", "Loading…")}</div> : <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">{detail?.content}</pre>}<DialogFooter><Button variant="outline" onClick={() => setDetail(undefined)}>{t("关闭", "Close")}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
