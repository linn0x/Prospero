import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Activity, Archive, ArrowDownAZ, ArrowRight, Bot, Boxes, BookOpen, Brain, CheckCircle2, ChevronRight, CircleAlert,
  CircleStop, Clock3, Code2, Copy, FileCode2, FileDiff, Folder, FolderKanban, FolderOpen, FolderPlus, GitBranch,
  LayoutDashboard, ListChecks, LoaderCircle, Mail, MessageSquare, MoreHorizontal, Orbit, PanelsTopLeft,
  PanelRight, Pencil, Pin, PinOff, Plus, Search, Server, Settings, Smartphone, Sparkles, SquareTerminal,
  Trash2, WifiOff, Workflow, X,
} from "lucide-react";
import type { DesktopSnapshot, SessionCreateInput, SessionInfo, UsageReport } from "../../shared/types";
import { AgentLogo } from "./AgentLogo";
import { prefetchAccountUsage } from "./account-usage-cache";
import { displayError, shortPath, text } from "./state";
import { useLocale, type Language } from "./locale";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuLabel,
  ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarGroupAction, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem,
  SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
  SidebarProvider, SidebarRail, SidebarSeparator, SidebarTrigger,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** 宿主平台是静态的,取一次即可;用来让菜单里的系统字样跟着平台走。 */
const isMac = window.prospero.platform === "darwin";

const ChatPane = lazy(() => import("./ChatPane").then((module) => ({ default: module.ChatPane })));
const TerminalPane = lazy(() => import("./TerminalPane").then((module) => ({ default: module.TerminalPane })));
const OrchestrationPane = lazy(() => import("./OrchestrationPane").then((module) => ({ default: module.OrchestrationPane })));
const AccountsPane = lazy(() => import("./ManagementPanes").then((module) => ({ default: module.AccountsPane })));
const DevicesPane = lazy(() => import("./ManagementPanes").then((module) => ({ default: module.DevicesPane })));
const LogsPane = lazy(() => import("./ManagementPanes").then((module) => ({ default: module.LogsPane })));
const SettingsPane = lazy(() => import("./ManagementPanes").then((module) => ({ default: module.SettingsPane })));
const SkillsPane = lazy(() => import("./SkillsPane").then((module) => ({ default: module.SkillsPane })));

type View = "overview" | "mobile" | "workspaces" | "runs" | "providers" | "skills" | "diagnostics" | "settings";
type NavItem = { id: View; label: string; icon: ComponentType };

const primaryNav: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "mobile", label: "Mobile", icon: Smartphone },
  { id: "runs", label: "Runs", icon: Workflow },
];

const resourceNav: NavItem[] = [
  { id: "providers", label: "Agents", icon: Boxes },
  { id: "skills", label: "Skills", icon: BookOpen },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];

function getViewCopy(view: View, t: (zh: string, en: string) => string): { title: string; description: string } {
  return ({
    overview: { title: t("概览", "Overview"), description: t("需要处理的工作与当前运行状态", "Work requiring attention and current runtime status") },
    mobile: { title: t("移动端", "Mobile"), description: t("配对手机并管理远程访问权限", "Pair phones and manage remote access permissions") },
    workspaces: { title: t("工作台", "Workspaces"), description: t("项目、会话与持久工作上下文", "Projects, sessions, and persistent work context") },
    runs: { title: t("运行", "Runs"), description: t("看板、依赖图与执行时间线", "Board, dependency graph, and execution timeline") },
    providers: { title: "Agents", description: t("Agent、模型、账号与额度", "Agents, models, accounts, and usage") },
    skills: { title: "Skills", description: t("发现并管理工作区可用的技能", "Discover and manage skills available to each workspace") },
    diagnostics: { title: t("诊断", "Diagnostics"), description: t("结构化日志与运行诊断", "Structured logs and runtime diagnostics") },
    settings: { title: t("设置", "Settings"), description: t("桌面行为、安全与终端偏好", "Desktop behavior, security, and terminal preferences") },
  } as Record<View, { title: string; description: string }>)[view];
}

function navLabel(view: View, t: (zh: string, en: string) => string): string {
  return getViewCopy(view, t).title;
}

function projectForSession(projects: string[], session: SessionInfo): string | undefined {
  const cwd = session.cwd.toLocaleLowerCase();
  return [...projects].sort((a, b) => b.length - a.length).find((project) => {
    const normalized = project.toLocaleLowerCase();
    return cwd === normalized || cwd.startsWith(`${normalized}\\`) || cwd.startsWith(`${normalized}/`);
  });
}

function sessionLabel(session: SessionInfo): string {
  return session.displayTitle || session.preview || session.title || session.agent;
}

function StatusMark({ status }: { status: string }) {
  return <span className={cn("status-mark", `is-${status}`)} aria-hidden="true" />;
}

const sessionAgentIcons: Record<string, ComponentType> = {
  codex: Code2,
  claude: Brain,
  deepseek: Search,
  opencode: FileCode2,
  grok: Orbit,
  trae: PanelsTopLeft,
  shell: SquareTerminal,
};

function SessionAgentIcon({ agent, unread = false }: { agent: string; unread?: boolean }) {
  const Icon = sessionAgentIcons[agent.toLocaleLowerCase()] ?? Bot;
  return <span className={cn("session-agent-icon", unread && "is-unread")} aria-hidden="true"><Icon /></span>;
}

function relativeTime(value: unknown, language: Language): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return language === "zh" ? "刚刚" : "now";
  const minutes = Math.floor(Math.max(0, Date.now() - value) / 60_000);
  if (minutes < 1) return language === "zh" ? "刚刚" : "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d`;
}

function ShellSidebar({ snapshot, view, activeId, onView, onOpenSession, onNewSession, onTogglePin, onRenameProject, onRenameSession, onDuplicateSession, onSetUnread }: {
  snapshot: DesktopSnapshot;
  view: View;
  activeId: string | undefined;
  onView: (view: View) => void;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
  onTogglePin: (id: string) => void;
  onRenameProject: (path: string) => void;
  onRenameSession: (id: string) => void;
  onDuplicateSession: (session: SessionInfo) => void;
  onSetUnread: (id: string, unread: boolean) => void;
}) {
  const { language, t, status } = useLocale();
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(snapshot.projects));
  const knownProjects = useRef(new Set(snapshot.projects));
  useEffect(() => {
    setExpandedProjects((current) => {
      const available = new Set(snapshot.projects);
      const next = new Set([...current].filter((project) => available.has(project)));
      for (const project of snapshot.projects) if (!knownProjects.current.has(project)) next.add(project);
      return next;
    });
    knownProjects.current = new Set(snapshot.projects);
  }, [snapshot.projects]);
  const pinned = snapshot.pinnedSessionIds
    .map((id) => snapshot.daemon.sessions.find((session) => session.id === id))
    .filter((session): session is SessionInfo => Boolean(session));
  const sortedProjects = useMemo(() => {
    const originalIndex = new Map(snapshot.projects.map((project, index) => [project, index]));
    const projectName = (project: string): string => snapshot.projectAliases[project.toLocaleLowerCase()] || project.split(/[\\/]/).filter(Boolean).at(-1) || project;
    const activity = (project: string): number => snapshot.daemon.sessions.reduce((latest, session) => projectForSession([project], session) ? Math.max(latest, session.createdAt ?? 0) : latest, 0);
    return [...snapshot.projects].sort((left, right) => {
      const leftPinned = snapshot.pinnedProjectPaths.some((path) => path.toLocaleLowerCase() === left.toLocaleLowerCase());
      const rightPinned = snapshot.pinnedProjectPaths.some((path) => path.toLocaleLowerCase() === right.toLocaleLowerCase());
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (snapshot.settings.workspaceSort === "name") return projectName(left).localeCompare(projectName(right), language === "zh" ? "zh-CN" : "en-US", { sensitivity: "base" });
      return activity(right) - activity(left) || (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0);
    });
  }, [language, snapshot.daemon.sessions, snapshot.pinnedProjectPaths, snapshot.projectAliases, snapshot.projects, snapshot.settings.workspaceSort]);
  const renderNav = (items: NavItem[]) => items.map((item) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton isActive={view === item.id} tooltip={navLabel(item.id, t)} onClick={() => onView(item.id)}><item.icon /><span>{navLabel(item.id, t)}</span></SidebarMenuButton>
    </SidebarMenuItem>
  ));
  return <Sidebar collapsible="icon" className="prospero-sidebar">
    <SidebarHeader className="px-3 py-3"><div className="flex h-9 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center"><span className="brand-orb"><Sparkles /></span><div className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden"><strong className="text-sm tracking-tight">Prospero</strong><span className="text-[10px] text-sidebar-foreground/45">Agent Work OS</span></div><Button variant="ghost" size="icon-sm" className="ml-auto group-data-[collapsible=icon]:hidden" aria-label={t("新建会话", "New session")} onClick={onNewSession}><Plus /></Button></div></SidebarHeader>
    <SidebarContent>
      <SidebarGroup><SidebarGroupContent><SidebarMenu>{renderNav(primaryNav)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
      <SidebarSeparator />
      <SidebarGroup><SidebarGroupLabel>{t("置顶", "Pinned")}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>
        {pinned.map((session) => { const attention = (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0); return <SidebarMenuItem key={session.id}><SidebarMenuButton size="lg" tooltip={sessionLabel(session)} onClick={() => onOpenSession(session.id)}><SessionAgentIcon agent={session.agent} /><span className="flex min-w-0 flex-col gap-0.5"><span className="truncate text-xs font-medium">{sessionLabel(session)}</span><span className="truncate text-[10px] font-normal text-sidebar-foreground/45">{session.agent} · {attention ? t("需要输入", "Needs input") : status(session.status)} · {relativeTime(session.createdAt, language)}</span></span></SidebarMenuButton><SidebarMenuAction className="session-pin-action is-pinned" aria-pressed="true" aria-label={t(`取消置顶 ${sessionLabel(session)}`, `Unpin ${sessionLabel(session)}`)} onClick={() => onTogglePin(session.id)}><Pin /></SidebarMenuAction></SidebarMenuItem>; })}
        {pinned.length === 0 && <SidebarMenuItem><span className="block px-2 py-1 text-xs text-sidebar-foreground/45 group-data-[collapsible=icon]:hidden">{t("暂无置顶会话", "No pinned sessions")}</span></SidebarMenuItem>}
      </SidebarMenu></SidebarGroupContent></SidebarGroup>
      <SidebarSeparator />
      <Collapsible open={workspaceOpen} onOpenChange={setWorkspaceOpen} className="group/workspaces"><SidebarGroup className="workspace-sidebar-group"><SidebarGroupLabel render={<CollapsibleTrigger />}><span>{t("工作区", "Workspaces")}</span><ChevronRight className="workspace-group-chevron" /></SidebarGroupLabel><SidebarGroupAction className="right-10" aria-label={t("新增工作区", "Add workspace")} title={t("新增工作区", "Add workspace")} onClick={() => void window.prospero.chooseProject()}><Plus /></SidebarGroupAction><DropdownMenu><DropdownMenuTrigger render={<SidebarGroupAction data-testid="workspace-more" aria-label={t("工作区更多操作", "More workspace actions")} title={t("更多", "More")}><MoreHorizontal /></SidebarGroupAction>} /><DropdownMenuContent align="end" side="right"><DropdownMenuGroup><DropdownMenuLabel>{t("工作区", "Workspaces")}</DropdownMenuLabel><DropdownMenuItem onClick={() => void window.prospero.chooseProject()}><FolderPlus />{t("添加工作区", "Add workspace")}</DropdownMenuItem><DropdownMenuItem onClick={() => setExpandedProjects(new Set(snapshot.projects))}><FolderOpen />{t("全部展开", "Expand all")}</DropdownMenuItem><DropdownMenuItem onClick={() => setExpandedProjects(new Set())}><Folder />{t("全部折叠", "Collapse all")}</DropdownMenuItem></DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuLabel>{t("排序方式", "Sort by")}</DropdownMenuLabel><DropdownMenuRadioGroup value={snapshot.settings.workspaceSort} onValueChange={(value) => { if (value === "recent" || value === "name") void window.prospero.updateSettings({ workspaceSort: value }); }}><DropdownMenuRadioItem value="recent"><Clock3 />{t("最近使用", "Recent")}</DropdownMenuRadioItem><DropdownMenuRadioItem value="name"><ArrowDownAZ />{t("名称", "Name")}</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuGroup></DropdownMenuContent></DropdownMenu><CollapsibleContent><SidebarGroupContent><SidebarMenu>
        {sortedProjects.map((project) => {
          const sessions = snapshot.daemon.sessions.filter((session) => projectForSession([project], session));
          const fallback = project.split(/[\\/]/).filter(Boolean).at(-1) ?? project;
          const name = snapshot.projectAliases[project.toLocaleLowerCase()] || fallback;
          const projectPinned = snapshot.pinnedProjectPaths.some((path) => path.toLocaleLowerCase() === project.toLocaleLowerCase());
          const projectOpen = expandedProjects.has(project);
          return <Collapsible key={project} open={expandedProjects.has(project)} onOpenChange={(open) => setExpandedProjects((current) => { const next = new Set(current); if (open) next.add(project); else next.delete(project); return next; })} className="group/project">
            <SidebarMenuItem className="workspace-project-item">
              <CollapsibleTrigger render={<SidebarMenuButton className="workspace-project-button" tooltip={name} />}>{projectOpen ? <FolderOpen /> : <Folder /> }<span className="truncate">{name}</span>{projectPinned && <Pin className="workspace-project-pinned" />}<span className="workspace-session-count">{sessions.length}</span></CollapsibleTrigger>
              <DropdownMenu><DropdownMenuTrigger render={<button type="button" data-slot="workspace-project-more" data-testid="workspace-project-more" className="workspace-project-more" aria-label={t(`${name} 操作`, `${name} actions`)} title={t("更多", "More")}><MoreHorizontal /></button>} /><DropdownMenuContent align="start" side="right"><DropdownMenuGroup><DropdownMenuLabel>{name}</DropdownMenuLabel><DropdownMenuItem onClick={() => void window.prospero.setProjectPinned(project, !projectPinned)}>{projectPinned ? <PinOff /> : <Pin />}{projectPinned ? t("取消置顶", "Unpin") : t("置顶工作区", "Pin workspace")}</DropdownMenuItem><DropdownMenuItem onClick={() => onRenameProject(project)}><Pencil />{t("编辑名称", "Edit name")}</DropdownMenuItem><DropdownMenuItem onClick={() => void window.prospero.revealPath(project)}><FolderOpen />{t("在资源管理器中打开", "Open in Explorer")}</DropdownMenuItem></DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem variant="destructive" onClick={() => void window.prospero.forgetProject(project)}><Trash2 />{t("移除工作区", "Remove workspace")}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
              <CollapsibleContent><SidebarMenuSub>{sessions.map((session) => { const unread = snapshot.unreadSessionIds.includes(session.id); const sessionPinned = snapshot.pinnedSessionIds.includes(session.id); return <SidebarMenuSubItem key={session.id} className="workspace-session-item"><ContextMenu><ContextMenuTrigger render={<SidebarMenuSubButton className="workspace-session-link" isActive={view === "workspaces" && activeId === session.id} title={sessionLabel(session)} onClick={() => onOpenSession(session.id)} />}><SessionAgentIcon agent={session.agent} unread={unread} /><span>{sessionLabel(session)}</span></ContextMenuTrigger><ContextMenuContent><ContextMenuGroup><ContextMenuLabel>{sessionLabel(session)}</ContextMenuLabel><ContextMenuItem onClick={() => onSetUnread(session.id, !unread)}><Mail />{unread ? t("标记为已读", "Mark as read") : t("标记为未读", "Mark as unread")}</ContextMenuItem><ContextMenuItem onClick={() => onRenameSession(session.id)}><Pencil />{t("编辑名称", "Rename")}</ContextMenuItem><ContextMenuItem onClick={() => onDuplicateSession(session)}><Copy />{t("复制会话", "Duplicate session")}</ContextMenuItem></ContextMenuGroup><ContextMenuSeparator /><ContextMenuGroup><ContextMenuItem onClick={() => onTogglePin(session.id)}>{sessionPinned ? <PinOff /> : <Pin />}{sessionPinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}</ContextMenuItem><ContextMenuItem onClick={() => void window.prospero.revealPath(session.cwd)}><FolderOpen />{t("在资源管理器中打开", "Open in Explorer")}</ContextMenuItem></ContextMenuGroup></ContextMenuContent></ContextMenu><button type="button" data-testid="workspace-session-pin" className={cn("workspace-session-pin", sessionPinned && "is-pinned")} aria-pressed={sessionPinned} aria-label={sessionPinned ? t(`取消置顶 ${sessionLabel(session)}`, `Unpin ${sessionLabel(session)}`) : t(`置顶 ${sessionLabel(session)}`, `Pin ${sessionLabel(session)}`)} title={sessionPinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")} onClick={() => onTogglePin(session.id)}><Pin /></button></SidebarMenuSubItem>; })}</SidebarMenuSub></CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>;
        })}
        {snapshot.projects.length === 0 && <SidebarMenuItem><SidebarMenuButton onClick={() => void window.prospero.chooseProject()}><FolderPlus /><span>{t("添加工作区", "Add workspace")}</span></SidebarMenuButton></SidebarMenuItem>}
      </SidebarMenu></SidebarGroupContent></CollapsibleContent></SidebarGroup></Collapsible>
      <SidebarSeparator />
      <SidebarGroup><SidebarGroupLabel>{t("系统", "System")}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{renderNav(resourceNav)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="px-3 pb-3"><SidebarMenu>
      <SidebarMenuItem><SidebarMenuButton tooltip={t("Daemon 状态", "Daemon status")} onClick={() => snapshot.daemon.running ? onView("settings") : void window.prospero.startDaemon()}>{snapshot.daemon.starting ? <LoaderCircle className="daemon-spinner" /> : snapshot.daemon.running ? <Server /> : <WifiOff />}<span className="flex min-w-0 flex-col gap-0.5"><span className="text-xs font-medium">Daemon {snapshot.daemon.running ? t("在线", "online") : snapshot.daemon.starting ? t("启动中", "starting") : t("离线", "offline")}</span><span className="text-[10px] font-normal text-sidebar-foreground/45">{snapshot.daemon.running ? `127.0.0.1:${String(snapshot.daemon.port)}` : snapshot.daemon.startupStage || t("点击启动", "Click to start")}</span></span></SidebarMenuButton></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton isActive={view === "settings"} tooltip={t("设置", "Settings")} onClick={() => onView("settings")}><Settings /><span>{t("设置", "Settings")}</span></SidebarMenuButton></SidebarMenuItem>
    </SidebarMenu></SidebarFooter><SidebarRail />
  </Sidebar>;
}

function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: React.ReactNode }) {
  return <header className="view-heading"><div className="flex min-w-0 flex-col gap-1">{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="view-actions">{actions}</div>}</header>;
}

function AttentionCard({ icon: Icon, title, description, status, action }: { icon: ComponentType; title: string; description: string; status: string; action?: React.ReactNode }) {
  return <div className="attention-row"><span className={cn("attention-icon", `tone-${status}`)}><Icon /></span><div className="min-w-0 flex-1"><strong>{title}</strong><p>{description}</p></div>{action ?? <ChevronRight className="text-muted-foreground" />}</div>;
}

function OverviewPane({ snapshot, onOpenSession, onOpenRuns, onNewSession }: { snapshot: DesktopSnapshot; onOpenSession: (id: string) => void; onOpenRuns: () => void; onNewSession: () => void }) {
  const { t, status } = useLocale();
  const activeSessions = snapshot.daemon.sessions.filter((session) => ["running", "starting", "waiting_approval", "waiting_input"].includes(session.status));
  const failedTasks = snapshot.orchestration.tasks.filter((task) => ["failed", "blocked"].includes(text(task["status"])));
  const pendingGates = snapshot.orchestration.gates.filter((gate) => text(gate["status"]) === "pending");
  const activeRun = snapshot.orchestration.runs.find((run) => text(run["status"]) === "active") ?? snapshot.orchestration.runs[0];
  const runId = text(activeRun?.["id"]);
  const runTasks = snapshot.orchestration.tasks.filter((task) => text(task["runId"]) === runId);
  const doneCount = runTasks.filter((task) => ["done", "completed", "succeeded"].includes(text(task["status"]))).length;
  const progress = runTasks.length ? Math.round((doneCount / runTasks.length) * 100) : 0;
  const attentionCount = pendingGates.length + failedTasks.length + activeSessions.reduce((sum, session) => sum + (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0), 0) + (snapshot.daemon.running ? 0 : 1);
  return <div className="view-scroll"><div className="view-container overview-view">
    <PageHeading eyebrow={t("指挥中心", "COMMAND CENTER")} title={t("概览", "Overview")} description={t("所有需要你决策、恢复或继续推进的工作。", "Everything that needs a decision, recovery, or another push.")} actions={<Button onClick={onNewSession}><Plus data-icon="inline-start" />{t("新建会话", "New session")}</Button>} />
    <div className="overview-grid">
      <Card className="attention-card-shell"><CardHeader><div className="flex items-center justify-between gap-3"><div><CardTitle>{t("需要你处理", "Needs your attention")}</CardTitle><CardDescription>{t("先处理会阻塞 Agent 的事项", "Resolve anything blocking an agent first")}</CardDescription></div><Badge variant={attentionCount ? "secondary" : "outline"}>{attentionCount}</Badge></div></CardHeader><CardContent className="flex flex-col gap-1">
        {!snapshot.daemon.running && <AttentionCard icon={WifiOff} title={t("本地服务离线", "Local service is offline")} description={snapshot.daemon.lastError || t("启动 daemon 后才能继续本地任务", "Start the daemon to continue local work")} status="danger" action={<Button size="sm" onClick={() => void window.prospero.startDaemon()}>{t("启动", "Start")}</Button>} />}
        {pendingGates.slice(0, 2).map((gate) => <AttentionCard key={text(gate["id"])} icon={ListChecks} title={text(gate["question"], t("审批请求", "Gate request"))} description={t("Run 正在等待你的决定", "The run is waiting for your decision")} status="warning" action={<Button variant="outline" size="sm" onClick={onOpenRuns}>{t("处理", "Review")}</Button>} />)}
        {failedTasks.slice(0, 2).map((task) => <AttentionCard key={text(task["id"])} icon={CircleAlert} title={text(task["title"], t("任务失败", "Task failed"))} description={`${status(text(task["status"]))} · ${t("打开 Run 查看上下文", "Open the run for context")}`} status="danger" action={<Button variant="outline" size="sm" onClick={onOpenRuns}>{t("查看", "View")}</Button>} />)}
        {activeSessions.filter((session) => (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0) > 0).slice(0, 2).map((session) => <AttentionCard key={session.id} icon={MessageSquare} title={sessionLabel(session)} description={t(`${session.agent} 需要输入后才能继续`, `${session.agent} needs input to continue`)} status="warning" action={<Button variant="outline" size="sm" onClick={() => onOpenSession(session.id)}>{t("回复", "Reply")}</Button>} />)}
        {attentionCount === 0 && <div className="calm-empty"><CheckCircle2 /><div><strong>{t("一切顺利", "All clear")}</strong><p>{t("当前没有待审批、失败或离线事件。", "No approvals, failures, or offline events need attention.")}</p></div></div>}
      </CardContent>{attentionCount > 0 && <CardFooter><Button variant="ghost" size="sm" onClick={onOpenRuns}>{t("查看运行", "View runs")} <ArrowRight data-icon="inline-end" /></Button></CardFooter>}</Card>
      <Card className="run-focus-card"><CardHeader><div className="flex items-center justify-between gap-3"><Badge variant="outline">{t("当前运行", "CURRENT RUN")}</Badge>{activeRun && <Badge variant="secondary">{status(text(activeRun["status"]))}</Badge>}</div><CardTitle>{text(activeRun?.["objective"], t("还没有正在运行的 Run", "No active run yet"))}</CardTitle><CardDescription>{activeRun ? t(`${String(doneCount)} / ${String(runTasks.length)} 个任务已完成`, `${String(doneCount)} of ${String(runTasks.length)} tasks complete`) : t("从运行页创建目标并拆分任务", "Create a goal in Runs and break it into tasks")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-5"><div className="flex flex-col gap-2"><div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("运行进度", "Run progress")}</span><strong>{progress}%</strong></div><Progress value={progress} /></div><div className="run-task-preview">{runTasks.slice(0, 4).map((task) => <div key={text(task["id"])}><StatusMark status={text(task["status"])} /><span className="truncate">{text(task["title"])}</span><small>{status(text(task["status"]))}</small></div>)}{runTasks.length === 0 && <p className="text-sm text-muted-foreground">{t("任务会在这里形成一条轻量工作流。", "Tasks will form a lightweight workflow here.")}</p>}</div></CardContent><CardFooter><Button variant="outline" onClick={onOpenRuns}>{t("打开运行", "Open run")} <ArrowRight data-icon="inline-end" /></Button></CardFooter></Card>
      <Card className="active-work-card"><CardHeader><div className="flex items-center justify-between gap-3"><div><CardTitle>{t("活跃工作", "Active work")}</CardTitle><CardDescription>{t("正在工作的 Agent 与最近上下文", "Active agents and recent context")}</CardDescription></div><Badge variant="outline">{activeSessions.length}</Badge></div></CardHeader><CardContent className="active-agent-list">{activeSessions.slice(0, 5).map((session) => <button key={session.id} onClick={() => onOpenSession(session.id)}><Avatar><AvatarFallback><AgentLogo agent={session.agent} size={18} /></AvatarFallback></Avatar><span className="min-w-0 flex-1"><strong className="truncate">{sessionLabel(session)}</strong><small><StatusMark status={session.status} />{session.agent} · {status(session.status)} · {shortPath(session.cwd)}</small></span><ChevronRight /></button>)}{activeSessions.length === 0 && <div className="calm-empty"><Bot /><div><strong>{t("没有活跃 Agent", "No active agents")}</strong><p>{t("新建会话后会显示在这里。", "New sessions will appear here.")}</p></div></div>}</CardContent></Card>
    </div>
    <section className="recent-section"><div className="section-heading"><div><h2>{t("最近的工作区", "Recent workspaces")}</h2><p>{t("回到上次离开的项目与会话", "Return to projects and sessions where you left off")}</p></div><Button variant="ghost" size="sm" onClick={() => void window.prospero.chooseProject()}><FolderPlus data-icon="inline-start" />{t("添加工作区", "Add workspace")}</Button></div><div className="workspace-cards">{snapshot.projects.slice(0, 4).map((project) => { const sessions = snapshot.daemon.sessions.filter((session) => projectForSession([project], session)); const name = project.split(/[\\/]/).filter(Boolean).at(-1) ?? project; return <Card size="sm" key={project}><CardHeader><div className="workspace-symbol"><FolderKanban /></div><CardTitle>{name}</CardTitle><CardDescription title={project}>{shortPath(project)}</CardDescription></CardHeader><CardFooter><span>{sessions.length} {t("个会话", "sessions")}</span><Button variant="ghost" size="icon-sm" aria-label={t(`打开 ${name}`, `Open ${name}`)} onClick={() => sessions[0] ? onOpenSession(sessions[0].id) : undefined}><ArrowRight /></Button></CardFooter></Card>; })}{snapshot.projects.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><FolderPlus /></EmptyMedia><EmptyTitle>{t("添加第一个工作区", "Add your first workspace")}</EmptyTitle><EmptyDescription>{t("选择本地项目后开始与 Agent 协作。", "Choose a local project to start collaborating with an agent.")}</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => void window.prospero.chooseProject()}>{t("选择文件夹", "Choose folder")}</Button></EmptyContent></Empty>}</div></section>
  </div></div>;
}

function InboxPane({ snapshot, onOpenSession, onOpenRuns }: { snapshot: DesktopSnapshot; onOpenSession: (id: string) => void; onOpenRuns: () => void }) {
  const { t, status } = useLocale();
  const gates = snapshot.orchestration.gates.filter((gate) => text(gate["status"]) === "pending");
  const taskIssues = snapshot.orchestration.tasks.filter((task) => ["failed", "blocked"].includes(text(task["status"])));
  const sessionIssues = snapshot.daemon.sessions.filter((session) => (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0) > 0);
  const total = gates.length + taskIssues.length + sessionIssues.length + (snapshot.daemon.running ? 0 : 1);
  return <div className="view-scroll"><div className="view-container inbox-view"><PageHeading eyebrow={t("行动队列", "ACTION QUEUE")} title={t("收件箱", "Inbox")} description={t("这里只保留需要你采取行动的事件，普通动态不会淹没决策。", "Only actionable events appear here, so routine activity never hides a decision.")} actions={<Badge variant="secondary">{total} {t("项待处理", "open")}</Badge>} /><div className="inbox-list">
    {!snapshot.daemon.running && <Card className="inbox-item tone-danger"><CardHeader><div className="inbox-item-head"><span className="attention-icon tone-danger"><WifiOff /></span><div><CardTitle>{t("运行环境已断开", "Runtime disconnected")}</CardTitle><CardDescription>Prospero daemon · {t("本机 Windows", "This Windows PC")}</CardDescription></div><Badge variant="destructive">{t("离线", "Offline")}</Badge></div></CardHeader><CardContent><p>{snapshot.daemon.lastError || t("本地运行环境不可用，当前会话暂时无法继续执行。", "The local runtime is unavailable, so active sessions cannot continue.")}</p></CardContent><CardFooter><Button onClick={() => void window.prospero.startDaemon()}>{t("重新连接", "Reconnect")}</Button></CardFooter></Card>}
    {gates.map((gate) => <Card className="inbox-item tone-warning" key={text(gate["id"])}><CardHeader><div className="inbox-item-head"><span className="attention-icon tone-warning"><ListChecks /></span><div><CardTitle>{text(gate["question"], t("请求审批", "Review requested"))}</CardTitle><CardDescription>{t("审批请求", "Gate request")} · {text(gate["runId"]).slice(0, 8)}</CardDescription></div><Badge variant="secondary">{t("需要决定", "Needs decision")}</Badge></div></CardHeader>{text(gate["reason"]) && <CardContent><p>{text(gate["reason"])}</p></CardContent>}<CardFooter className="flex-wrap">{Array.isArray(gate["options"]) ? (gate["options"] as unknown[]).map(String).map((option, index) => <Button key={option} variant={index === 0 ? "default" : "outline"} size="sm" onClick={() => void window.prospero.resolveGate(text(gate["id"]), option)}>{option}</Button>) : <Button size="sm" onClick={onOpenRuns}>{t("打开运行", "Open run")}</Button>}</CardFooter></Card>)}
    {sessionIssues.map((session) => <Card className="inbox-item tone-warning" key={session.id}><CardHeader><div className="inbox-item-head"><span className="attention-icon tone-warning"><MessageSquare /></span><div><CardTitle>{sessionLabel(session)}</CardTitle><CardDescription>{session.agent} · {shortPath(session.cwd)}</CardDescription></div><Badge variant="secondary">{t("需要输入", "Needs input")}</Badge></div></CardHeader><CardContent><p>{(session.pendingPermissions ?? 0) > 0 ? t(`${String(session.pendingPermissions)} 个权限请求等待处理`, `${String(session.pendingPermissions)} permission requests awaiting review`) : t(`${String(session.pendingQuestions ?? 0)} 个问题等待回复`, `${String(session.pendingQuestions ?? 0)} questions awaiting a reply`)}</p></CardContent><CardFooter><Button size="sm" onClick={() => onOpenSession(session.id)}>{t("打开会话", "Open session")}</Button></CardFooter></Card>)}
    {taskIssues.map((task) => <Card className="inbox-item tone-danger" key={text(task["id"])}><CardHeader><div className="inbox-item-head"><span className="attention-icon tone-danger"><CircleAlert /></span><div><CardTitle>{text(task["title"], t("任务失败", "Task failed"))}</CardTitle><CardDescription>{t("任务", "Task")} · {status(text(task["status"]))}</CardDescription></div><Badge variant="destructive">{status(text(task["status"]))}</Badge></div></CardHeader><CardContent><p>{text(task["spec"], t("打开对应 Run 查看失败上下文与执行结果。", "Open the related run for failure context and results."))}</p></CardContent><CardFooter><Button variant="outline" size="sm" onClick={onOpenRuns}>{t("查看运行", "View run")}</Button>{text(task["status"]) === "failed" && <Button size="sm" onClick={() => void window.prospero.orchestrationAction("task.retry", { operationId: crypto.randomUUID(), taskId: text(task["id"]) })}>{t("重试", "Retry")}</Button>}</CardFooter></Card>)}
    {total === 0 && <Empty className="inbox-empty"><EmptyHeader><EmptyMedia variant="icon"><Archive /></EmptyMedia><EmptyTitle>{t("收件箱已清空", "Inbox is clear")}</EmptyTitle><EmptyDescription>{t("当前没有需要你审批、回复或恢复的工作。", "Nothing needs your approval, reply, or recovery.")}</EmptyDescription></EmptyHeader></Empty>}
  </div></div></div>;
}

function AgentsPane({ snapshot, onOpenSession, onNewSession }: { snapshot: DesktopSnapshot; onOpenSession: (id: string) => void; onNewSession: () => void }) {
  const { t, status } = useLocale();
  const ids = [...new Set([...snapshot.daemon.sessions.map((session) => session.agent), ...snapshot.accounts.map((account) => text(account["agent"])).filter(Boolean)])];
  const agents = ids.length ? ids : ["codex", "claude", "opencode"];
  return <div className="view-scroll"><div className="view-container"><PageHeading eyebrow={t("AI 协作者", "AI COLLABORATORS")} title={t("协作者", "Agents")} description={t("Agent 是可复用的工作角色；账号、模型来源和执行环境在各自页面管理。", "Agents are reusable roles; accounts, providers, and runtimes are managed separately.")} actions={<Button onClick={onNewSession}><Plus data-icon="inline-start" />{t("运行 Agent", "Run agent")}</Button>} /><div className="agent-grid">{agents.map((agent) => { const sessions = snapshot.daemon.sessions.filter((session) => session.agent === agent); const active = sessions.filter((session) => ["running", "starting", "waiting_input", "waiting_approval"].includes(session.status)); const account = snapshot.accounts.find((item) => text(item["agent"]) === agent); return <Card key={agent} className="agent-card"><CardHeader><div className="agent-card-identity"><Avatar className="size-11"><AvatarFallback><AgentLogo agent={agent} size={25} /></AvatarFallback></Avatar><div><CardTitle className="capitalize">{agent}</CardTitle><CardDescription>{agent === "codex" ? t("编码、重构与仓库工作", "Coding, refactoring, and repository work") : agent === "claude" ? t("分析、写作与复杂推理", "Analysis, writing, and complex reasoning") : t("本地 Agent 协作者", "Local agent collaborator")}</CardDescription></div><StatusMark status={active.length ? "running" : "completed"} /></div></CardHeader><CardContent><dl className="agent-facts"><div><dt>{t("默认模型", "Default model")}</dt><dd>{text(account?.["model"], t("Agent 默认", "Agent default"))}</dd></div><div><dt>{t("权限", "Permission")}</dt><dd>{sessions[0]?.approvalPolicy || "standard"}</dd></div><div><dt>{t("活跃任务", "Active tasks")}</dt><dd>{active.length}</dd></div><div><dt>{t("最近运行", "Recent runs")}</dt><dd>{sessions.length}</dd></div></dl>{active.slice(0, 2).map((session) => <button className="agent-active-task" key={session.id} onClick={() => onOpenSession(session.id)}><StatusMark status={session.status} /><span className="truncate">{sessionLabel(session)}</span><ChevronRight /></button>)}</CardContent><CardFooter><Badge variant={text(account?.["status"]) === "signed_in" ? "secondary" : "outline"}>{account ? status(text(account["status"])) : t("使用本地环境", "Uses local environment")}</Badge><Button variant="ghost" size="sm" disabled={!sessions[0]} onClick={() => sessions[0] && onOpenSession(sessions[0].id)}>{t("打开", "Open")}</Button></CardFooter></Card>; })}</div></div></div>;
}

function WorkspaceContextPane({ session, snapshot }: { session: SessionInfo; snapshot: DesktopSnapshot }) {
  const { t, status } = useLocale();
  const [usage, setUsage] = useState<UsageReport>();
  useEffect(() => { setUsage(undefined); void window.prospero.getUsage(session.id).then(setUsage).catch(() => setUsage(undefined)); }, [session.id]);
  const dispatch = snapshot.orchestration.dispatches.find((item) => text(item["sessionId"]) === session.id);
  const task = dispatch ? snapshot.orchestration.tasks.find((item) => text(item["id"]) === text(dispatch["taskId"])) : undefined;
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  return <Tabs defaultValue="task" className="context-pane-tabs"><div className="pane-tabbar"><TabsList variant="line"><TabsTrigger value="task">{t("任务", "Task")}</TabsTrigger><TabsTrigger value="diff">Diff</TabsTrigger><TabsTrigger value="execution">{t("执行", "Execution")}</TabsTrigger></TabsList></div>
    <TabsContent value="task" className="context-pane-content">{task ? <><div className="context-pane-heading"><Badge variant="secondary">{status(text(task["status"]))}</Badge><h2>{text(task["title"])}</h2><p>{text(task["spec"])}</p></div><Separator /><dl className="detail-list"><div><dt>Agent</dt><dd>{session.agent}</dd></div><div><dt>{t("运行环境", "Runtime")}</dt><dd>{t("本机 Windows", "This Windows PC")}</dd></div><div><dt>{t("分支", "Branch")}</dt><dd className="font-mono">{text(dispatch?.["branch"], "workspace")}</dd></div><div><dt>Worktree</dt><dd className="truncate font-mono" title={text(dispatch?.["worktreePath"])}>{shortPath(text(dispatch?.["worktreePath"], session.cwd))}</dd></div><div><dt>{t("依赖", "Dependencies")}</dt><dd>{Array.isArray(task["deps"]) ? task["deps"].length : 0}</dd></div></dl></> : <Empty><EmptyHeader><EmptyMedia variant="icon"><ListChecks /></EmptyMedia><EmptyTitle>{t("未关联任务", "No linked task")}</EmptyTitle><EmptyDescription>{t("这个会话尚未绑定到编排任务，仍可作为独立工作上下文使用。", "This session is not linked to an orchestration task and can still be used independently.")}</EmptyDescription></EmptyHeader></Empty>}</TabsContent>
    <TabsContent value="diff" className="context-pane-content"><div className="context-pane-heading"><Badge variant="outline">{t("变更文件", "CHANGED FILES")}</Badge><h2>{t("工作树差异", "Working tree diff")}</h2><p>{t("Diff 是独立 Pane，不再嵌入 Conversation。", "Diff is an independent pane rather than part of the conversation.")}</p></div><div className="diff-placeholder"><FileDiff /><strong>{task ? t("等待 daemon 提供结构化变更摘要", "Waiting for a structured change summary") : t("暂无任务 Diff", "No task diff available")}</strong><p>{t("打开相关 worktree 可查看当前文件变更。", "Open the related worktree to inspect current file changes.")}</p>{text(dispatch?.["worktreePath"]) && <Button variant="outline" size="sm" onClick={() => void window.prospero.revealPath(text(dispatch?.["worktreePath"]))}><FolderOpen data-icon="inline-start" />{t("打开工作树", "Open worktree")}</Button>}</div></TabsContent>
    <TabsContent value="execution" className="context-pane-content"><div className="context-pane-heading"><Badge variant="outline">{t("执行", "EXECUTION")}</Badge><h2>{t("会话运行环境", "Session runtime")}</h2><p>{t("会话、模型、额度与运行位置。", "Session, model, usage, and execution location.")}</p></div><dl className="detail-list"><div><dt>{t("状态", "Status")}</dt><dd><StatusMark status={session.status} />{status(session.status)}</dd></div><div><dt>{t("模式", "Mode")}</dt><dd>{session.kind === "pty" ? t("PTY 终端", "PTY terminal") : t("结构化会话", "Structured conversation")}</dd></div><div><dt>{t("审批", "Approval")}</dt><dd>{session.approvalPolicy || "standard"}</dd></div><div><dt>Tokens</dt><dd>{tokens.toLocaleString()}</dd></div><div><dt>{t("会话", "Session")}</dt><dd className="font-mono">{session.id.slice(0, 10)}…</dd></div></dl><div className="context-actions"><Button variant="outline" size="sm" onClick={() => void window.prospero.openWindowsTerminal(session.cwd)}><SquareTerminal data-icon="inline-start" />Windows Terminal</Button><Button variant="outline" size="sm" onClick={() => void window.prospero.revealPath(session.cwd)}><FolderOpen data-icon="inline-start" />Explorer</Button></div></TabsContent>
  </Tabs>;
}

function WorkspacePane({ snapshot, activeId, openIds, onActivate, onClose, onNewSession, onTogglePin }: { snapshot: DesktopSnapshot; activeId: string | undefined; openIds: string[]; onActivate: (id: string) => void; onClose: (id: string) => void; onNewSession: (project?: string) => void; onTogglePin: (id: string) => void }) {
  const { t, status } = useLocale();
  const [showContext, setShowContext] = useState(true);
  const [contextSheet, setContextSheet] = useState(false);
  const active = snapshot.daemon.sessions.find((session) => session.id === activeId);
  return <div className="workspace-view workspace-view-single">
    <div className="pane-workspace"><div className="workspace-tabbar"><div className="workspace-tabs" role="tablist">{openIds.map((id) => { const session = snapshot.daemon.sessions.find((item) => item.id === id); if (!session) return null; const pinned = snapshot.pinnedSessionIds.includes(id); return <div key={id} className={cn("workspace-tab", id === activeId && "is-active")} role="tab" aria-selected={id === activeId}><button type="button" className="workspace-tab-main" onClick={() => onActivate(id)}><SessionAgentIcon agent={session.agent} /><span className="truncate">{sessionLabel(session)}</span></button><button type="button" data-testid="workspace-tab-pin" className={cn("workspace-tab-action", pinned && "is-pinned")} aria-pressed={pinned} aria-label={pinned ? t(`取消置顶 ${sessionLabel(session)}`, `Unpin ${sessionLabel(session)}`) : t(`置顶 ${sessionLabel(session)}`, `Pin ${sessionLabel(session)}`)} onClick={() => onTogglePin(id)}><Pin /></button><button type="button" data-testid="workspace-tab-close" className="workspace-tab-action" aria-label={t(`关闭 ${sessionLabel(session)}`, `Close ${sessionLabel(session)}`)} onClick={() => onClose(id)}><X /></button></div>; })}</div></div>
    {active ? <><header className="pane-toolbar"><div className="agent-identity"><Avatar><AvatarFallback><AgentLogo agent={active.agent} size={18} /></AvatarFallback></Avatar><div><strong>{sessionLabel(active)}</strong><small><StatusMark status={active.status} />{status(active.status)} · {shortPath(active.cwd)}</small></div></div><div className="pane-toolbar-actions"><Badge variant="outline"><GitBranch />{shortPath(active.cwd)}</Badge><Button variant="ghost" size="icon-sm" aria-label={t("停止当前轮次", "Stop current turn")} onClick={() => void window.prospero.interruptSession(active.id)}><CircleStop /></Button><Button variant="ghost" size="icon-sm" aria-label={t("切换上下文 Pane", "Toggle context pane")} className="context-pane-toggle" onClick={() => setShowContext((current) => !current)}><PanelRight /></Button><Button variant="ghost" size="icon-sm" aria-label={t("打开上下文", "Open context")} className="context-sheet-trigger" onClick={() => setContextSheet(true)}><PanelRight /></Button><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("会话操作", "Session actions")} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuLabel>{t("会话", "Session")}</DropdownMenuLabel><DropdownMenuItem onClick={() => void window.prospero.revealPath(active.cwd)}><FolderOpen />{isMac ? t("在访达中显示", "Reveal in Finder") : t("在资源管理器中打开", "Open in Explorer")}</DropdownMenuItem><DropdownMenuItem onClick={() => void window.prospero.openWindowsTerminal(active.cwd)}><SquareTerminal />{isMac ? t("终端", "Terminal") : "Windows Terminal"}</DropdownMenuItem></DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem variant="destructive" onClick={() => void window.prospero.killSession(active.id)}><X />{t("结束会话", "End session")}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></div></header><div className={cn("pane-grid", !showContext && "context-hidden")}><main className="primary-pane"><div className="pane-tabbar pane-tabbar-static"><span>{active.kind === "pty" ? t("终端", "Terminal") : t("对话", "Conversation")}</span><Badge variant="outline">{active.agent}</Badge></div><div className="pane-content">{active.kind === "pty" ? <TerminalPane session={active} fontFamily={snapshot.settings.terminalFontFamily} fontSize={snapshot.settings.terminalFontSize} /> : <ChatPane session={active} onOpenGoal={() => undefined} />}</div></main>{showContext && <aside className="secondary-pane"><WorkspaceContextPane session={active} snapshot={snapshot} /></aside>}</div><Sheet open={contextSheet} onOpenChange={setContextSheet}><SheetContent side="right" className="w-[min(520px,92vw)] sm:max-w-xl"><SheetHeader><SheetTitle>{t("任务上下文", "Task context")}</SheetTitle><SheetDescription>{t("任务、Diff 与执行信息", "Task, diff, and execution details")}</SheetDescription></SheetHeader><WorkspaceContextPane session={active} snapshot={snapshot} /></SheetContent></Sheet></> : <Empty className="workspace-empty"><EmptyHeader><EmptyMedia variant="icon"><FolderKanban /></EmptyMedia><EmptyTitle>{t("选择工作上下文", "Choose a work context")}</EmptyTitle><EmptyDescription>{t("打开已有会话，或在项目中创建新的 Agent 会话。", "Open an existing session or create a new agent session in a project.")}</EmptyDescription></EmptyHeader><EmptyContent className="flex gap-2"><Button onClick={() => onNewSession()}><Plus data-icon="inline-start" />{t("新建会话", "New session")}</Button><Button variant="outline" onClick={() => void window.prospero.chooseProject()}><FolderPlus data-icon="inline-start" />{t("添加工作区", "Add workspace")}</Button></EmptyContent></Empty>}
    </div>
  </div>;
}

function ProjectRenameDialog({ project, currentName, open, onOpenChange }: { project: string | undefined; currentName: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setName(currentName); setError(undefined); } }, [open, currentName]);
  const save = async (): Promise<void> => {
    if (!project) return;
    setBusy(true);
    setError(undefined);
    try { await window.prospero.renameProject(project, name); onOpenChange(false); }
    catch (reason) { setError(displayError(reason)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{t("编辑工作区名称", "Edit workspace name")}</DialogTitle><DialogDescription>{t("只修改 Prospero 中显示的名称，不会重命名磁盘目录。", "This changes only the name shown in Prospero, not the folder on disk.")}</DialogDescription></DialogHeader>{error && <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("无法保存", "Unable to save")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}<Field><FieldLabel htmlFor="workspace-name">{t("显示名称", "Display name")}</FieldLabel><Input id="workspace-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void save(); }} /><FieldDescription className="truncate" title={project}>{project}</FieldDescription></Field><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t("取消", "Cancel")}</Button><Button disabled={busy || !name.trim()} onClick={() => void save()}>{busy && <Spinner data-icon="inline-start" />}{t("保存", "Save")}</Button></DialogFooter></DialogContent></Dialog>;
}

function SessionRenameDialog({ session, open, onOpenChange }: { session: SessionInfo | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setName(session ? sessionLabel(session) : ""); setError(undefined); } }, [open, session]);
  const save = async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    try { await window.prospero.renameSession(session.id, name); onOpenChange(false); }
    catch (reason) { setError(displayError(reason)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{t("编辑会话名称", "Rename session")}</DialogTitle><DialogDescription>{t("名称只影响 Prospero 中的显示，不会改变会话内容。", "This changes only the name shown in Prospero, not the session content.")}</DialogDescription></DialogHeader>{error && <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("无法保存", "Unable to save")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}<Field><FieldLabel htmlFor="session-name">{t("显示名称", "Display name")}</FieldLabel><Input id="session-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void save(); }} /><FieldDescription className="truncate" title={session?.cwd}>{session?.cwd}</FieldDescription></Field><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t("取消", "Cancel")}</Button><Button disabled={busy || !name.trim()} onClick={() => void save()}>{busy && <Spinner data-icon="inline-start" />}{t("保存", "Save")}</Button></DialogFooter></DialogContent></Dialog>;
}

function NewSessionDialog({ snapshot, project, open, onOpenChange, onCreated }: { snapshot: DesktopSnapshot; project: string | undefined; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (session: SessionInfo) => void }) {
  const { t } = useLocale();
  const [input, setInput] = useState<SessionCreateInput>({ cwd: project || snapshot.projects[0] || "", agent: "codex", kind: "structured", approvalPolicy: "standard" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) setInput((current) => ({ ...current, cwd: project || current.cwd || snapshot.projects[0] || "" })); }, [open, project, snapshot.projects]);
  const supportsStructured = ["codex", "claude", "deepseek", "opencode"].includes(input.agent);
  const create = async (): Promise<void> => { setBusy(true); setError(undefined); try { onCreated(await window.prospero.createSession(input)); onOpenChange(false); } catch (reason) { setError(displayError(reason)); } finally { setBusy(false); } };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{t("新建 Agent 会话", "New agent session")}</DialogTitle><DialogDescription>{t("选择工作区、Agent 与运行方式。模型和账号使用 Provider 中配置的默认值。", "Choose a workspace, agent, and run mode. Model and account defaults come from Providers.")}</DialogDescription></DialogHeader>{error && <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("无法创建会话", "Unable to create session")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}<FieldGroup>
    <Field><FieldLabel htmlFor="session-project">{t("工作区", "Workspace")}</FieldLabel><NativeSelect id="session-project" value={input.cwd} onChange={(event) => setInput({ ...input, cwd: event.target.value })}><NativeSelectOption value="" disabled>{t("选择项目", "Choose project")}</NativeSelectOption>{snapshot.projects.map((item) => <NativeSelectOption value={item} key={item}>{item.split(/[\\/]/).filter(Boolean).at(-1)}</NativeSelectOption>)}</NativeSelect><FieldDescription>{t("会话的工作目录与持久上下文。", "The session working directory and persistent context.")}</FieldDescription></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="session-agent">Agent</FieldLabel><NativeSelect id="session-agent" value={input.agent} onChange={(event) => { const agent = event.target.value as SessionCreateInput["agent"]; setInput({ ...input, agent, ...(!["codex", "claude", "deepseek", "opencode"].includes(agent) ? { kind: "pty" as const } : {}) }); }}><NativeSelectOption value="codex">Codex</NativeSelectOption><NativeSelectOption value="claude">Claude</NativeSelectOption><NativeSelectOption value="deepseek">DeepSeek</NativeSelectOption><NativeSelectOption value="opencode">OpenCode</NativeSelectOption><NativeSelectOption value="grok">Grok</NativeSelectOption><NativeSelectOption value="trae">Trae</NativeSelectOption><NativeSelectOption value="shell">Shell</NativeSelectOption></NativeSelect></Field><Field><FieldLabel htmlFor="session-kind">{t("Pane 类型", "Pane type")}</FieldLabel><NativeSelect id="session-kind" value={input.kind} onChange={(event) => setInput({ ...input, kind: event.target.value as SessionCreateInput["kind"] })}><NativeSelectOption value="structured" disabled={!supportsStructured}>{t("对话", "Conversation")}</NativeSelectOption><NativeSelectOption value="pty">{t("终端", "Terminal")}</NativeSelectOption></NativeSelect></Field></div>
    <Field><FieldLabel htmlFor="session-approval">{t("权限配置", "Permission profile")}</FieldLabel><NativeSelect id="session-approval" value={input.approvalPolicy} onChange={(event) => setInput({ ...input, approvalPolicy: event.target.value as SessionCreateInput["approvalPolicy"] })}><NativeSelectOption value="strict">Strict</NativeSelectOption><NativeSelectOption value="standard">Standard</NativeSelectOption><NativeSelectOption value="yolo">YOLO</NativeSelectOption></NativeSelect><FieldDescription>{t("Standard 会在高风险操作前请求确认。", "Standard asks for confirmation before high-risk actions.")}</FieldDescription></Field>
  </FieldGroup><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t("取消", "Cancel")}</Button><Button disabled={busy || !input.cwd} onClick={() => void create()}>{busy ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}{busy ? t("正在创建", "Creating") : t("创建会话", "Create session")}</Button></DialogFooter></DialogContent></Dialog>;
}

function CommandDialog({ open, onOpenChange, mode, snapshot, onView, onOpenSession, onNewSession }: { open: boolean; onOpenChange: (open: boolean) => void; mode: "command" | "quick"; snapshot: DesktopSnapshot; onView: (view: View) => void; onOpenSession: (id: string) => void; onNewSession: () => void }) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  const actions = [...primaryNav.map((item) => ({ key: item.id, label: t(`打开${navLabel(item.id, t)}`, `Open ${navLabel(item.id, t)}`), detail: t("导航", "Navigation"), icon: item.icon, run: () => onView(item.id) })), ...resourceNav.map((item) => ({ key: item.id, label: t(`打开${navLabel(item.id, t)}`, `Open ${navLabel(item.id, t)}`), detail: t("导航", "Navigation"), icon: item.icon, run: () => onView(item.id) })), { key: "settings", label: t("打开设置", "Open Settings"), detail: t("导航", "Navigation"), icon: Settings, run: () => onView("settings" as const) }, { key: "new", label: t("新建会话", "New Session"), detail: t("动作", "Action"), icon: Plus, run: onNewSession }];
  const quick = [...snapshot.projects.map((project) => ({ key: project, label: project.split(/[\\/]/).filter(Boolean).at(-1) ?? project, detail: shortPath(project), icon: FolderKanban, run: () => onView("workspaces" as const) })), ...snapshot.daemon.sessions.map((session) => ({ key: session.id, label: sessionLabel(session), detail: `${session.agent} · ${shortPath(session.cwd)}`, icon: session.kind === "pty" ? SquareTerminal : MessageSquare, run: () => onOpenSession(session.id) }))];
  const options = (mode === "command" ? actions : quick).filter((item) => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="command-dialog sm:max-w-xl"><DialogHeader className="sr-only"><DialogTitle>{mode === "command" ? t("指挥中心", "Command Center") : t("快速打开", "Quick Open")}</DialogTitle><DialogDescription>{mode === "command" ? t("执行 Prospero 动作", "Run a Prospero action") : t("快速打开工作区、会话或任务", "Open a workspace, session, or task")}</DialogDescription></DialogHeader><InputGroup className="command-search"><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === "command" ? t("输入命令…", "Type a command…") : t("打开工作区、会话或任务…", "Open workspace, session, or task…")} /><InputGroupAddon align="inline-end"><kbd>Esc</kbd></InputGroupAddon></InputGroup><div className="command-results">{options.map((item) => <Button variant="ghost" key={item.key} onClick={() => { item.run(); onOpenChange(false); }}><item.icon data-icon="inline-start" /><span><strong>{item.label}</strong><small>{item.detail}</small></span><ChevronRight data-icon="inline-end" /></Button>)}{options.length === 0 && <p>{t("没有匹配结果", "No matching results")}</p>}</div></DialogContent></Dialog>;
}

export function App({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { t } = useLocale();
  const [view, setView] = useState<View>("overview");
  const [openIds, setOpenIds] = useState<string[]>(() => { try { const stored = JSON.parse(localStorage.getItem("prospero.openSessions") || "[]") as unknown; return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []; } catch { return []; } });
  const [activeId, setActiveId] = useState<string>();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionProject, setNewSessionProject] = useState<string>();
  const [editingProject, setEditingProject] = useState<string>();
  const [editingSession, setEditingSession] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [launcher, setLauncher] = useState<"command" | "quick">();
  const validOpenIds = useMemo(() => openIds.filter((id) => snapshot.daemon.sessions.some((session) => session.id === id)), [openIds, snapshot.daemon.sessions]);
  const activeSession = snapshot.daemon.sessions.find((session) => session.id === activeId);
  const accountUsageKey = snapshot.accounts.map((account) => `${text(account["id"])}:${text(account["status"])}`).join("|");
  useEffect(() => { localStorage.setItem("prospero.openSessions", JSON.stringify(validOpenIds)); }, [validOpenIds]);
  useEffect(() => { if (activeId && !snapshot.daemon.sessions.some((session) => session.id === activeId)) setActiveId(validOpenIds[0]); }, [snapshot.daemon.sessions, activeId, validOpenIds]);
  useEffect(() => { const systemTheme = window.matchMedia("(prefers-color-scheme: dark)"); const apply = (): void => { document.documentElement.dataset.theme = snapshot.settings.theme; document.documentElement.classList.toggle("dark", snapshot.settings.theme === "dark" || (snapshot.settings.theme === "system" && systemTheme.matches)); }; apply(); systemTheme.addEventListener("change", apply); return () => systemTheme.removeEventListener("change", apply); }, [snapshot.settings.theme]);
  useEffect(() => { if (snapshot.daemon.running && accountUsageKey) prefetchAccountUsage(); }, [snapshot.daemon.running, accountUsageKey]);
  useEffect(() => { const onKeyDown = (event: KeyboardEvent): void => { if (!(event.ctrlKey || event.metaKey)) return; if (event.key.toLocaleLowerCase() === "k") { event.preventDefault(); setLauncher("command"); } if (event.key.toLocaleLowerCase() === "p") { event.preventDefault(); setLauncher("quick"); } if (event.key.toLocaleLowerCase() === "n") { event.preventDefault(); setNewSessionProject(undefined); setNewSessionOpen(true); } }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, []);
  const openSession = (id: string): void => { setOpenIds((current) => current.includes(id) ? current : [...current, id]); setActiveId(id); setView("workspaces"); if (snapshot.unreadSessionIds.includes(id)) void window.prospero.setSessionUnread(id, false); };
  const closeSession = (id: string): void => { const index = validOpenIds.indexOf(id); const next = validOpenIds.filter((item) => item !== id); setOpenIds(next); if (activeId === id) setActiveId(next[Math.max(0, index - 1)]); };
  const openNewSession = (project?: string): void => { setNewSessionProject(project); setNewSessionOpen(true); };
  const togglePin = (id: string): void => { void window.prospero.setSessionPinned(id, !snapshot.pinnedSessionIds.includes(id)); };
  const duplicateSession = (session: SessionInfo): void => {
    void (async () => {
      const supportedAgents: SessionCreateInput["agent"][] = ["codex", "claude", "deepseek", "opencode", "grok", "trae", "shell"];
      const agent = supportedAgents.includes(session.agent as SessionCreateInput["agent"]) ? session.agent as SessionCreateInput["agent"] : "shell";
      const project = projectForSession(snapshot.projects, session) ?? snapshot.projects[0];
      if (!project) return;
      const approvalPolicy = session.approvalPolicy === "strict" || session.approvalPolicy === "yolo" ? session.approvalPolicy : "standard";
      const kind = session.kind === "structured" && ["codex", "claude", "deepseek", "opencode"].includes(agent) ? "structured" : "pty";
      const created = await window.prospero.createSession({ cwd: project, agent, kind, approvalPolicy });
      await window.prospero.renameSession(created.id, t(`${sessionLabel(session)} 副本`, `${sessionLabel(session)} Copy`));
      openSession(created.id);
    })().catch((reason) => console.error("Unable to duplicate session", reason));
  };
  const page = getViewCopy(view, t);
  return <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} style={{ "--sidebar-width": "15rem", "--sidebar-width-icon": "3.5rem" } as React.CSSProperties} className="prospero-shell">
    <ShellSidebar snapshot={snapshot} view={view} activeId={activeId} onView={setView} onOpenSession={openSession} onNewSession={() => openNewSession()} onTogglePin={togglePin} onRenameProject={setEditingProject} onRenameSession={setEditingSession} onDuplicateSession={duplicateSession} onSetUnread={(id, unread) => void window.prospero.setSessionUnread(id, unread)} />
    <SidebarInset className="prospero-main"><header className="desktop-topbar"><div className="topbar-context"><SidebarTrigger /><div><strong>{activeSession && view === "workspaces" ? sessionLabel(activeSession) : page.title}</strong><span>{activeSession && view === "workspaces" ? shortPath(activeSession.cwd) : page.description}</span></div></div><div className="topbar-actions"><Button variant="outline" className="search-trigger" onClick={() => setLauncher("command")}><Search data-icon="inline-start" /><span>{t("搜索或运行命令", "Search or run a command")}</span><kbd>Ctrl K</kbd></Button><Button onClick={() => openNewSession()}><Plus data-icon="inline-start" />{t("新建会话", "New session")}</Button></div></header>
      <div className="main-viewport"><Suspense fallback={<div className="boot-screen"><Spinner /><span>Loading workspace…</span></div>}>
        {view === "overview" ? <OverviewPane snapshot={snapshot} onOpenSession={openSession} onOpenRuns={() => setView("runs")} onNewSession={() => openNewSession()} /> : view === "mobile" ? <DevicesPane snapshot={snapshot} /> : view === "workspaces" ? <WorkspacePane snapshot={snapshot} activeId={activeId} openIds={validOpenIds} onActivate={(id) => openSession(id)} onClose={closeSession} onNewSession={openNewSession} onTogglePin={togglePin} /> : view === "runs" ? <OrchestrationPane snapshot={snapshot} onOpenSession={openSession} /> : view === "providers" ? <AccountsPane snapshot={snapshot} onOpenSession={openSession} /> : view === "skills" ? <SkillsPane snapshot={snapshot} /> : view === "diagnostics" ? <LogsPane snapshot={snapshot} /> : <SettingsPane snapshot={snapshot} />}
      </Suspense></div></SidebarInset>
    <NewSessionDialog snapshot={snapshot} project={newSessionProject} open={newSessionOpen} onOpenChange={setNewSessionOpen} onCreated={(session) => openSession(session.id)} />
    <ProjectRenameDialog project={editingProject} currentName={editingProject ? snapshot.projectAliases[editingProject.toLocaleLowerCase()] || editingProject.split(/[\\/]/).filter(Boolean).at(-1) || editingProject : ""} open={Boolean(editingProject)} onOpenChange={(open) => { if (!open) setEditingProject(undefined); }} />
    <SessionRenameDialog session={snapshot.daemon.sessions.find((session) => session.id === editingSession)} open={Boolean(editingSession)} onOpenChange={(open) => { if (!open) setEditingSession(undefined); }} />
    <CommandDialog open={Boolean(launcher)} onOpenChange={(open) => { if (!open) setLauncher(undefined); }} mode={launcher ?? "command"} snapshot={snapshot} onView={setView} onOpenSession={openSession} onNewSession={() => openNewSession()} />
  </SidebarProvider>;
}
