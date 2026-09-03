import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowDownAZ,
  ArrowRight,
  BookOpen,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Clock3,
  Copy,
  FileDiff,
  Folder,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Mail,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Smartphone,
  SquareTerminal,
  Trash2,
  WifiOff,
  Workflow,
  X,
} from "lucide-react";
import type {
  AgentModel,
  DesktopSnapshot,
  JsonObject,
  SessionCreateInput,
  SessionInfo,
  SessionPage,
  UsageAccount,
  UsageReport,
} from "../../shared/types";
import { AgentLogo } from "./AgentLogo";
import {
  getCachedAccountUsage,
  loadAccountUsage,
  prefetchAccountUsage,
} from "./account-usage-cache";
import { displayError, shortPath, text } from "./state";
import { useLocale, type Language } from "./locale";
import {
  EXPANDED_PROJECTS_STORAGE_KEY,
  SIDEBAR_SESSION_PREVIEW_LIMIT,
  adaptiveSidebarOpen,
  filterSessionsByQuery,
  mostRelevantProject,
  nextSidebarSessionLimit,
  parseExpandedProjects,
  projectForSession,
  sortProjectsByRecentActivity,
  sortSidebarSessions,
} from "./workspace-sidebar-state";
import {
  defaultSessionLaunchAccountId,
  sessionLaunchAccounts,
  sessionLaunchWorkspaces,
} from "../../shared/session-launch-options";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** Host platform is static and controls native menu labels and shortcuts. */
const isMac = window.prospero.platform === "darwin";
const COMPACT_SIDEBAR_BREAKPOINT = 1200;
const SIDEBAR_OPEN_STORAGE_KEY = "prospero.sidebarOpen";
const SIDEBAR_PROJECT_PREVIEW_LIMIT = 24;
const SIDEBAR_PROJECT_PAGE_SIZE = 24;
const SIDEBAR_PINNED_PREVIEW_LIMIT = 24;
const SIDEBAR_SEARCH_PAGE_SIZE = 60;
const SIDEBAR_SEARCH_VISIBLE_LIMIT = 120;
const HYDRATED_SESSION_CACHE_LIMIT = 120;

function readSidebarOpenPreference(): boolean | undefined {
  try {
    const value = localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    return value === "true" ? true : value === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

const ChatPane = lazy(() =>
  import("./ChatPane").then((module) => ({ default: module.ChatPane })),
);
const TerminalPane = lazy(() =>
  import("./TerminalPane").then((module) => ({ default: module.TerminalPane })),
);
const OrchestrationPane = lazy(() =>
  import("./OrchestrationPane").then((module) => ({
    default: module.OrchestrationPane,
  })),
);
const AccountsPane = lazy(() =>
  import("./ManagementPanes").then((module) => ({
    default: module.AccountsPane,
  })),
);
const DevicesPane = lazy(() =>
  import("./ManagementPanes").then((module) => ({
    default: module.DevicesPane,
  })),
);
const LogsPane = lazy(() =>
  import("./ManagementPanes").then((module) => ({ default: module.LogsPane })),
);
const SettingsPane = lazy(() =>
  import("./ManagementPanes").then((module) => ({
    default: module.SettingsPane,
  })),
);
const SkillsPane = lazy(() =>
  import("./SkillsPane").then((module) => ({ default: module.SkillsPane })),
);

type View =
  | "overview"
  | "inbox"
  | "mobile"
  | "workspaces"
  | "runs"
  | "providers"
  | "skills"
  | "diagnostics"
  | "settings";
type NavItem = { id: View; label: string; icon: ComponentType };

const primaryNav: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "inbox", label: "Inbox", icon: Mail },
  { id: "mobile", label: "Mobile", icon: Smartphone },
  { id: "runs", label: "Runs", icon: Workflow },
];

const resourceNav: NavItem[] = [
  { id: "providers", label: "Agents", icon: Boxes },
  { id: "skills", label: "Skills", icon: BookOpen },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];

function getViewCopy(
  view: View,
  t: (zh: string, en: string) => string,
): { title: string; description: string } {
  return (
    {
      overview: {
        title: t("概览", "Overview"),
        description: t(
          "需要处理的工作与当前运行状态",
          "Work requiring attention and current runtime status",
        ),
      },
      inbox: {
        title: t("收件箱", "Inbox"),
        description: t(
          "审批、回复与失败恢复",
          "Approvals, replies, and failure recovery",
        ),
      },
      mobile: {
        title: t("移动端", "Mobile"),
        description: t(
          "配对手机并管理远程访问权限",
          "Pair phones and manage remote access permissions",
        ),
      },
      workspaces: {
        title: t("工作台", "Workspaces"),
        description: t(
          "项目、会话与持久工作上下文",
          "Projects, sessions, and persistent work context",
        ),
      },
      runs: {
        title: t("运行", "Runs"),
        description: t(
          "看板、依赖图与执行时间线",
          "Board, dependency graph, and execution timeline",
        ),
      },
      providers: {
        title: "Agents",
        description: t(
          "Agent、模型、账号与额度",
          "Agents, models, accounts, and usage",
        ),
      },
      skills: {
        title: "Skills",
        description: t(
          "发现并管理工作区可用的技能",
          "Discover and manage skills available to each workspace",
        ),
      },
      diagnostics: {
        title: t("诊断", "Diagnostics"),
        description: t(
          "结构化日志与运行诊断",
          "Structured logs and runtime diagnostics",
        ),
      },
      settings: {
        title: t("设置", "Settings"),
        description: t(
          "桌面行为、安全与终端偏好",
          "Desktop behavior, security, and terminal preferences",
        ),
      },
    } as Record<View, { title: string; description: string }>
  )[view];
}

function navLabel(view: View, t: (zh: string, en: string) => string): string {
  return getViewCopy(view, t).title;
}

function sessionLabel(session: SessionInfo): string {
  return (
    session.displayTitle || session.title || session.preview || session.agent
  );
}

function StatusMark({ status }: { status: string }) {
  return (
    <span className={cn("status-mark", `is-${status}`)} aria-hidden="true" />
  );
}

function SessionAgentIcon({
  agent,
  unread = false,
}: {
  agent: string;
  unread?: boolean;
}) {
  return (
    <span
      className={cn("session-agent-icon", unread && "is-unread")}
      aria-hidden="true"
    >
      <AgentLogo agent={agent} size={15} decorative />
    </span>
  );
}

type SidebarSessionHandlers = {
  onOpenSession: (id: string, session?: SessionInfo) => void;
  onTogglePin: (id: string) => void;
  onRenameSession: (id: string) => void;
  onDuplicateSession: (session: SessionInfo) => void;
  onSetUnread: (id: string, unread: boolean) => void;
  onToggleArchive: (id: string) => void;
};

type PinnedSessionRowProps = Pick<
  SidebarSessionHandlers,
  "onOpenSession" | "onTogglePin"
> & {
  session: SessionInfo;
};

/**
 * Pinned rows remain independently mounted from the workspace preview.  This
 * keeps a pinned session reachable even when its project has hundreds of
 * historical sessions that are no longer part of the live snapshot.
 */
const PinnedSessionRow = memo(function PinnedSessionRow({
  session,
  onOpenSession,
  onTogglePin,
}: PinnedSessionRowProps) {
  const { language, t, status } = useLocale();
  const attention =
    (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        tooltip={sessionLabel(session)}
        onClick={() => onOpenSession(session.id, session)}
      >
        <SessionAgentIcon agent={session.agent} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs font-medium">
            {sessionLabel(session)}
          </span>
          <span className="truncate text-[10px] font-normal text-sidebar-foreground/45">
            {session.agent} · {" "}
            {attention ? t("需要输入", "Needs input") : status(session.status)} · {" "}
            {relativeTime(session.createdAt, language)}
          </span>
        </span>
      </SidebarMenuButton>
      <SidebarMenuAction
        showOnHover
        className="session-pin-action is-pinned"
        aria-pressed="true"
        aria-label={t(
          `取消置顶 ${sessionLabel(session)}`,
          `Unpin ${sessionLabel(session)}`,
        )}
        onClick={() => onTogglePin(session.id)}
      >
        <Pin className="rotate-45" fill="currentColor" />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}, sidebarSessionRowEqual);

type WorkspaceSessionRowProps = SidebarSessionHandlers & {
  session: SessionInfo;
  active: boolean;
  unread: boolean;
  pinned: boolean;
  archived: boolean;
};

/**
 * Individual session rows are intentionally memoized.  Snapshot transport may
 * refresh an unrelated daemon field every second; preserving these DOM nodes
 * avoids re-running all menu/context-menu work for every visible session.
 */
const WorkspaceSessionRow = memo(function WorkspaceSessionRow({
  session,
  active,
  unread,
  pinned,
  archived,
  onOpenSession,
  onTogglePin,
  onRenameSession,
  onDuplicateSession,
  onSetUnread,
  onToggleArchive,
}: WorkspaceSessionRowProps) {
  const { language, t, status } = useLocale();
  return (
    <SidebarMenuSubItem className="workspace-session-item">
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuSubButton
              className="workspace-session-link"
              isActive={active}
              title={sessionLabel(session)}
              onClick={() => onOpenSession(session.id, session)}
            />
          }
        >
          <SessionAgentIcon agent={session.agent} unread={unread} />
          <span className="workspace-session-copy">
            <strong>{sessionLabel(session)}</strong>
            <small>
              <StatusMark status={session.status} />
              {status(session.status)} · {relativeTime(session.createdAt, language)}
            </small>
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuLabel>{sessionLabel(session)}</ContextMenuLabel>
            <ContextMenuItem onClick={() => onSetUnread(session.id, !unread)}>
              <Mail />
              {unread
                ? t("标记为已读", "Mark as read")
                : t("标记为未读", "Mark as unread")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRenameSession(session.id)}>
              <Pencil />
              {t("编辑名称", "Rename")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onDuplicateSession(session)}>
              <Copy />
              {t("复制会话", "Duplicate session")}
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem onClick={() => onTogglePin(session.id)}>
              {pinned ? <PinOff /> : <Pin />}
              {pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
            </ContextMenuItem>
          <ContextMenuItem onClick={() => onToggleArchive(session.id)}>
            {archived ? <ArchiveRestore /> : <Archive />}
            {archived ? t("取消归档", "Unarchive") : t("归档", "Archive")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem onClick={() => void window.prospero.interruptSession(session.id)}>
              <CircleStop />
              {t("停止本轮", "Stop current turn")}
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => void window.prospero.killSession(session.id)}
            >
              <X />
              {t("结束会话", "End session")}
            </ContextMenuItem>
          </ContextMenuGroup>
            <ContextMenuItem
              onClick={() => void window.prospero.revealPath(session.cwd)}
            >
              <FolderOpen />
              {isMac
                ? t("在访达中显示", "Reveal in Finder")
                : t("在资源管理器中打开", "Open in Explorer")}
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      <button
        type="button"
        data-slot="workspace-session-pin"
        data-testid="workspace-session-pin"
        className={cn("workspace-session-pin", pinned && "is-pinned")}
        aria-pressed={pinned}
        aria-label={
          pinned
            ? t(
                `取消置顶 ${sessionLabel(session)}`,
                `Unpin ${sessionLabel(session)}`,
              )
            : t(`置顶 ${sessionLabel(session)}`, `Pin ${sessionLabel(session)}`)
        }
        title={pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
        onClick={() => onTogglePin(session.id)}
      >
        <Pin aria-hidden="true" />
      </button>
    </SidebarMenuSubItem>
  );
}, sidebarSessionRowEqual);

function sidebarSessionRowEqual(
  previous: Readonly<PinnedSessionRowProps | WorkspaceSessionRowProps>,
  next: Readonly<PinnedSessionRowProps | WorkspaceSessionRowProps>,
): boolean {
  const left = previous.session;
  const right = next.session;
  if (
    left.id !== right.id ||
    left.agent !== right.agent ||
    left.kind !== right.kind ||
    left.title !== right.title ||
    left.displayTitle !== right.displayTitle ||
    left.preview !== right.preview ||
    left.cwd !== right.cwd ||
    left.status !== right.status ||
    left.createdAt !== right.createdAt ||
    left.pendingPermissions !== right.pendingPermissions ||
    left.pendingQuestions !== right.pendingQuestions
  )
    return false;

  if ("active" in previous && "active" in next) {
    if (
      previous.active !== next.active ||
      previous.unread !== next.unread ||
      previous.pinned !== next.pinned
    )
      return false;
  }

  return (
    previous.onOpenSession === next.onOpenSession &&
    previous.onTogglePin === next.onTogglePin &&
    (!("onRenameSession" in previous) ||
      ("onRenameSession" in next &&
        previous.onRenameSession === next.onRenameSession &&
        previous.onDuplicateSession === next.onDuplicateSession &&
        previous.onSetUnread === next.onSetUnread))
  );
}

function relativeTime(value: unknown, language: Language): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    return language === "zh" ? "刚刚" : "now";
  const minutes = Math.floor(Math.max(0, Date.now() - value) / 60_000);
  if (minutes < 1) return language === "zh" ? "刚刚" : "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${String(hours)}h`
    : `${String(Math.floor(hours / 24))}d`;
}

function DaemonAgentsCard({
  snapshot,
  usage,
  loading,
}: {
  snapshot: DesktopSnapshot;
  usage: UsageAccount[];
  loading: boolean;
}) {
  const { t, status } = useLocale();
  const terminalStates = new Set(["done", "died", "failed", "error", "cancelled", "completed"]);
  const online = snapshot.daemon.sessions.filter((session) => !terminalStates.has(session.status));
  const agents = [...new Set(online.map((session) => session.agent))];
  return (
    <Card size="sm" className="border-0 bg-transparent shadow-none ring-0">
      <CardHeader>
        <CardTitle>{t("在线 Agent", "Online agents")}</CardTitle>
        <CardDescription>
          {snapshot.daemon.running
            ? t(`${String(online.length)} 个活跃会话`, `${String(online.length)} active sessions`)
            : t("Daemon 当前离线", "Daemon is offline")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {agents.map((agent) => {
          const sessions = online.filter((session) => session.agent === agent);
          const accountUsage = usage.find((item) => item.agent === agent && item.available) ?? usage.find((item) => item.agent === agent);
          const window = accountUsage?.windows[0];
          const remaining = window
            ? Math.max(0, Math.round(100 - window.utilization))
            : accountUsage?.spendRemainingPercent !== undefined
              ? Math.max(0, Math.round(accountUsage.spendRemainingPercent))
              : undefined;
          return (
            <div className="daemon-agent-row" key={agent}>
              <Avatar>
                <AvatarFallback><AgentLogo agent={agent} size={16} decorative /></AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate capitalize">{agent}</strong>
                  <Badge variant="outline">{sessions.length}</Badge>
                </div>
                <span className="truncate text-[10px] text-muted-foreground">
                  {status(sessions[0]?.status ?? "running")} · {remaining !== undefined
                    ? t(`${String(remaining)}% 可用`, `${String(remaining)}% available`)
                    : loading
                      ? t("读取额度中…", "Loading usage…")
                      : accountUsage?.reason ?? t("额度不可用", "Usage unavailable")}
                </span>
                {remaining !== undefined && <Progress value={remaining} className="h-1" />}
              </div>
            </div>
          );
        })}
        {agents.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">
            {snapshot.daemon.running
              ? t("当前没有在线 Agent。", "No agents are online.")
              : t("启动 Daemon 后会在这里显示 Agent 与额度。", "Start the daemon to see agents and usage here.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ShellSidebar({
  snapshot,
  view,
  activeId,
  onView,
  onOpenSession,
  onNewSession,
  onTogglePin,
  onToggleArchive,
  onRenameProject,
  onRenameSession,
  onDuplicateSession,
  onSetUnread,
}: {
  snapshot: DesktopSnapshot;
  view: View;
  activeId: string | undefined;
  onView: (view: View) => void;
  onOpenSession: (id: string, session?: SessionInfo) => void;
  onNewSession: (project?: string) => void;
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onRenameProject: (path: string) => void;
  onRenameSession: (id: string) => void;
  onDuplicateSession: (session: SessionInfo) => void;
  onSetUnread: (id: string, unread: boolean) => void;
}) {
  const { language, t, status } = useLocale();
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback((): void => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  const selectView = useCallback((next: View): void => {
    onView(next);
    closeMobileSidebar();
  }, [closeMobileSidebar, onView]);
  const selectSession = useCallback((id: string, session?: SessionInfo): void => {
    onOpenSession(id, session);
    closeMobileSidebar();
  }, [closeMobileSidebar, onOpenSession]);
  const newSession = useCallback((project?: string): void => {
    onNewSession(project);
    closeMobileSidebar();
  }, [closeMobileSidebar, onNewSession]);
  const chooseProject = useCallback((): void => {
    void window.prospero.chooseProject()
      .then((path) => {
        if (path) closeMobileSidebar();
      })
      .catch(() => undefined);
  }, [closeMobileSidebar]);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [sessionQuery, setSessionQuery] = useState("");
  const deferredSessionQuery = useDeferredValue(sessionQuery.trim());
  const [searchPage, setSearchPage] = useState<SessionPage>();
  const [searchPageQuery, setSearchPageQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLimit, setSearchLimit] = useState(SIDEBAR_SEARCH_PAGE_SIZE);
  const [pinnedPage, setPinnedPage] = useState<SessionPage>();
  const [pinnedLoading, setPinnedLoading] = useState(false);
  const [projectLimit, setProjectLimit] = useState(
    SIDEBAR_PROJECT_PREVIEW_LIMIT,
  );
  const [pinnedLimit, setPinnedLimit] = useState(
    SIDEBAR_PINNED_PREVIEW_LIMIT,
  );
  const [daemonUsage, setDaemonUsage] = useState<UsageAccount[]>(getCachedAccountUsage);
  const [daemonUsageLoading, setDaemonUsageLoading] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => {
      let restored: string[] | undefined;
      try {
        restored = parseExpandedProjects(
          localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY),
          snapshot.projects,
        );
      } catch {
        // Storage can be unavailable in hardened or ephemeral renderer contexts.
      }
      const fallback = mostRelevantProject(
        snapshot.projects,
        snapshot.daemon.sessions,
        snapshot.pinnedProjectPaths,
        activeId,
      );
      return new Set(restored ?? (fallback ? [fallback] : []));
    },
  );
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>(
    {},
  );
  const knownProjects = useRef(new Set(snapshot.projects));
  const normalizedSessionQuery = deferredSessionQuery.toLocaleLowerCase();
  const handleDaemonCardOpen = (open: boolean): void => {
    if (!open || !snapshot.daemon.running) return;
    setDaemonUsage(getCachedAccountUsage());
    setDaemonUsageLoading(true);
    void loadAccountUsage(false)
      .then(setDaemonUsage)
      .catch(() => setDaemonUsage(getCachedAccountUsage()))
      .finally(() => setDaemonUsageLoading(false));
  };
  useEffect(() => {
    setExpandedProjects((current) => {
      const available = new Set(snapshot.projects);
      const next = new Set(
        [...current].filter((project) => available.has(project)),
      );
      const added = snapshot.projects.filter(
        (project) => !knownProjects.current.has(project),
      );
      if (added.length > 0) {
        const relevantAdded = mostRelevantProject(
          added,
          snapshot.daemon.sessions,
          snapshot.pinnedProjectPaths,
          activeId,
        );
        if (relevantAdded) next.add(relevantAdded);
      }
      if (
        next.size === current.size &&
        [...next].every((project) => current.has(project))
      )
        return current;
      return next;
    });
    knownProjects.current = new Set(snapshot.projects);
  }, [
    activeId,
    snapshot.daemon.sessions,
    snapshot.pinnedProjectPaths,
    snapshot.projects,
  ]);
  useEffect(() => {
    try {
      localStorage.setItem(
        EXPANDED_PROJECTS_STORAGE_KEY,
        JSON.stringify([...expandedProjects]),
      );
    } catch {
      // Expansion is still usable for the lifetime of this renderer.
    }
  }, [expandedProjects]);
  useEffect(() => {
    if (!activeId) return;
    const activeSession = snapshot.daemon.sessions.find(
      (session) => session.id === activeId,
    );
    const activeProject = activeSession
      ? projectForSession(snapshot.projects, activeSession)
      : undefined;
    if (!activeProject) return;
    setExpandedProjects((current) => {
      if (current.has(activeProject)) return current;
      return new Set([...current, activeProject]);
    });
  }, [activeId, snapshot.daemon.sessions, snapshot.projects]);
  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, SessionInfo[]>(
      snapshot.projects.map((project) => [project, []]),
    );
    for (const session of snapshot.daemon.sessions) {
      const project = projectForSession(snapshot.projects, session);
      if (project) grouped.get(project)?.push(session);
    }
    for (const [project, sessions] of grouped) {
      grouped.set(
        project,
        sortSidebarSessions(
          sessions,
          activeId,
          snapshot.pinnedSessionIds,
          snapshot.unreadSessionIds,
        ),
      );
    }
    return grouped;
  }, [
    activeId,
    snapshot.daemon.sessions,
    snapshot.pinnedSessionIds,
    snapshot.projects,
    snapshot.unreadSessionIds,
  ]);
  const sessionsById = useMemo(
    () =>
      new Map(
        snapshot.daemon.sessions.map((session) => [session.id, session]),
      ),
    [snapshot.daemon.sessions],
  );
  const pinnedSessionKey = snapshot.pinnedSessionIds.join("\u0000");
  const pinnedSessionRequestIds = useMemo(
    () => snapshot.pinnedSessionIds.slice(0, 100),
    [pinnedSessionKey],
  );
  useEffect(() => {
    if (snapshot.pinnedSessionIds.length === 0) {
      setPinnedPage(undefined);
      setPinnedLoading(false);
      return;
    }
    let cancelled = false;
    setPinnedPage(undefined);
    setPinnedLoading(true);
    void window.prospero
      .listSessions({
        ids: pinnedSessionRequestIds,
        limit: SIDEBAR_PINNED_PREVIEW_LIMIT,
      })
      .then((page) => {
        if (!cancelled) setPinnedPage(page);
      })
      .catch(() => {
        // The bounded live snapshot still provides pinned active/recent rows
        // while the daemon is reconnecting.
        if (!cancelled) setPinnedPage(undefined);
      })
      .finally(() => {
        if (!cancelled) setPinnedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pinnedSessionKey, pinnedSessionRequestIds]);
  useEffect(() => {
    if (!deferredSessionQuery) {
      setSearchPage(undefined);
      setSearchPageQuery("");
      setSearchLoading(false);
      setSearchLimit(SIDEBAR_SEARCH_PAGE_SIZE);
      return;
    }
    let cancelled = false;
    setSearchLimit(SIDEBAR_SEARCH_PAGE_SIZE);
    setSearchLoading(true);
    void window.prospero
      .listSessions({
        query: deferredSessionQuery,
        limit: SIDEBAR_SEARCH_PAGE_SIZE,
      })
      .then((page) => {
        if (!cancelled) {
          setSearchPage(page);
          setSearchPageQuery(deferredSessionQuery);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSearchPage(undefined);
          setSearchPageQuery(deferredSessionQuery);
        }
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deferredSessionQuery]);
  const pinned = useMemo(() => {
    const byId = new Map(sessionsById);
    for (const session of pinnedPage?.items ?? []) byId.set(session.id, session);
    return snapshot.pinnedSessionIds
      .map((id) => byId.get(id))
      .filter((session): session is SessionInfo => Boolean(session));
  }, [pinnedPage?.items, sessionsById, snapshot.pinnedSessionIds]);
  const searchSessions = useMemo(() => {
    if (!normalizedSessionQuery) return [];
    const byId = new Map<string, SessionInfo>();
    for (const session of searchPageQuery === deferredSessionQuery
      ? searchPage?.items ?? []
      : []) {
      byId.set(session.id, session);
    }
    // Retain local active/attention sessions immediately while the first
    // history page is in flight. The daemon page will replace duplicates.
    for (const session of filterSessionsByQuery(
      snapshot.daemon.sessions,
      normalizedSessionQuery,
      SIDEBAR_SEARCH_PAGE_SIZE,
    )) {
      byId.set(session.id, session);
    }
    return sortSidebarSessions(
      [...byId.values()],
      activeId,
      snapshot.pinnedSessionIds,
      snapshot.unreadSessionIds,
    );
  }, [
    activeId,
    deferredSessionQuery,
    normalizedSessionQuery,
    searchPage?.items,
    searchPageQuery,
    snapshot.daemon.sessions,
    snapshot.pinnedSessionIds,
    snapshot.unreadSessionIds,
  ]);
  const visibleSearchSessions = searchSessions.slice(0, searchLimit);
  const searchResultTotal =
    searchPageQuery === deferredSessionQuery
      ? searchPage?.total ?? searchSessions.length
      : searchSessions.length;
  const sortedProjects = useMemo(() => {
    const originalIndex = new Map(
      snapshot.projects.map((project, index) => [project, index]),
    );
    const projectName = (project: string): string =>
      snapshot.projectAliases[project.toLocaleLowerCase()] ||
      project.split(/[\\/]/).filter(Boolean).at(-1) ||
      project;
    const activity = (project: string): number =>
      (sessionsByProject.get(project) ?? []).reduce(
        (latest, session) => Math.max(latest, session.createdAt ?? 0),
        0,
      );
    return [...snapshot.projects].sort((left, right) => {
      const leftPinned = snapshot.pinnedProjectPaths.some(
        (path) => path.toLocaleLowerCase() === left.toLocaleLowerCase(),
      );
      const rightPinned = snapshot.pinnedProjectPaths.some(
        (path) => path.toLocaleLowerCase() === right.toLocaleLowerCase(),
      );
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (snapshot.settings.workspaceSort === "name")
        return projectName(left).localeCompare(
          projectName(right),
          language === "zh" ? "zh-CN" : "en-US",
          { sensitivity: "base" },
        );
      return (
        activity(right) - activity(left) ||
        (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0)
      );
    });
  }, [
    language,
    snapshot.pinnedProjectPaths,
    snapshot.projectAliases,
    snapshot.projects,
    snapshot.settings.workspaceSort,
    sessionsByProject,
  ]);
  const importantProjects = useMemo(() => {
    const importantIds = new Set<string>([
      ...(activeId ? [activeId] : []),
      ...snapshot.pinnedSessionIds,
      ...snapshot.unreadSessionIds,
    ]);
    for (const session of snapshot.daemon.sessions) {
      if (
        (session.pendingPermissions ?? 0) +
          (session.pendingQuestions ?? 0) >
          0 ||
        ["running", "starting", "waiting_approval", "waiting_input"].includes(
          session.status,
        )
      )
        importantIds.add(session.id);
    }
    const projects = new Set<string>();
    for (const id of importantIds) {
      const session = sessionsById.get(id) ?? pinned.find((item) => item.id === id);
      if (!session) continue;
      const project = projectForSession(snapshot.projects, session);
      if (project) projects.add(project);
    }
    return projects;
  }, [
    activeId,
    pinned,
    sessionsById,
    snapshot.daemon.sessions,
    snapshot.pinnedSessionIds,
    snapshot.projects,
    snapshot.unreadSessionIds,
  ]);
  const visibleProjects = useMemo(() => {
    const important = sortedProjects.filter((project) =>
      importantProjects.has(project),
    );
    const remaining = sortedProjects.filter(
      (project) => !importantProjects.has(project),
    );
    const selected = new Set([
      ...important,
      ...remaining.slice(
        0,
        Math.max(0, projectLimit - important.length),
      ),
    ]);
    return sortedProjects.filter((project) => selected.has(project));
  }, [importantProjects, projectLimit, sortedProjects]);
  const hiddenProjectCount = Math.max(0, sortedProjects.length - visibleProjects.length);
  const loadMorePinned = useCallback(() => {
    if (!pinnedPage?.nextCursor || pinnedLoading) return;
    setPinnedLoading(true);
    setPinnedLimit((current) => current + SIDEBAR_PINNED_PREVIEW_LIMIT);
    void window.prospero
      .listSessions({
        ids: pinnedSessionRequestIds,
        cursor: pinnedPage.nextCursor,
        limit: SIDEBAR_PINNED_PREVIEW_LIMIT,
      })
      .then((next) =>
        setPinnedPage((current) =>
          current
            ? {
                ...next,
                items: [...current.items, ...next.items],
              }
            : next,
        ),
      )
      .finally(() => setPinnedLoading(false));
  }, [pinnedLoading, pinnedPage?.nextCursor, pinnedSessionRequestIds]);
  const loadMoreSearch = useCallback(() => {
    if (
      !searchPage?.nextCursor ||
      searchLoading ||
      searchPageQuery !== deferredSessionQuery
    )
      return;
    setSearchLoading(true);
    setSearchLimit((current) =>
      Math.min(SIDEBAR_SEARCH_VISIBLE_LIMIT, current + SIDEBAR_SEARCH_PAGE_SIZE),
    );
    void window.prospero
      .listSessions({
        query: deferredSessionQuery,
        cursor: searchPage.nextCursor,
        limit: SIDEBAR_SEARCH_PAGE_SIZE,
      })
      .then((next) =>
        setSearchPage((current) =>
          current
            ? { ...next, items: [...current.items, ...next.items] }
            : next,
        ),
      )
      .finally(() => setSearchLoading(false));
  }, [
    deferredSessionQuery,
    searchLoading,
    searchPage?.nextCursor,
    searchPageQuery,
  ]);
  const renderNav = (items: NavItem[]) =>
    items.map((item) => (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton
          isActive={view === item.id}
          tooltip={navLabel(item.id, t)}
          onClick={() => selectView(item.id)}
        >
          <item.icon />
          <span>{navLabel(item.id, t)}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ));
  return (
    <Sidebar collapsible="icon" className="prospero-sidebar">
      {/* 品牌区已去掉,但这个头部不能删:macOS 上它负责给红黄绿让出高度
          (见 styles.css 里 data-platform="darwin" 的规则),同时它也是窗口的
          拖拽区 —— 标题栏是隐藏的,没有它窗口就拖不动。 */}
      <SidebarHeader className="p-0" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{renderNav(primaryNav)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>{t("工具", "Tools")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderNav(resourceNav)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {snapshot.pinnedSessionIds.length > 0 && <>
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>
              {t("置顶", "Pinned")}
              {snapshot.daemon.sessionSummary?.truncated && (
                <span className="workspace-session-count">
                  {pinned.length}/{snapshot.pinnedSessionIds.length}
                </span>
              )}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinned.slice(0, pinnedLimit).map((session) => (
                  <PinnedSessionRow
                    key={session.id}
                    session={session}
                    onOpenSession={selectSession}
                    onTogglePin={onTogglePin}
                  />
                ))}
                {pinned.length === 0 && pinnedLoading && (
                  <SidebarMenuItem className="workspace-search-summary" aria-live="polite">
                    <Spinner />
                    <span>{t("正在载入置顶会话…", "Loading pinned sessions…")}</span>
                  </SidebarMenuItem>
                )}
                {(pinned.length > pinnedLimit || pinnedPage?.nextCursor) && (
                  <SidebarMenuItem className="workspace-session-more-item">
                    <button
                      type="button"
                      data-slot="workspace-session-more"
                      className="workspace-session-more"
                      aria-label={t(
                        `显示更多置顶会话`,
                        "Show more pinned sessions",
                      )}
                      onClick={() => {
                        if (pinned.length > pinnedLimit)
                          setPinnedLimit((current) =>
                            current + SIDEBAR_PINNED_PREVIEW_LIMIT,
                          );
                        else loadMorePinned();
                      }}
                    >
                      {pinnedLoading ? <Spinner /> : <ChevronRight aria-hidden="true" />}
                      <span>
                        {t("显示更多置顶会话", "Show more pinned sessions")}
                      </span>
                    </button>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </>}
        <SidebarSeparator />
        <Collapsible
          open={workspaceOpen}
          onOpenChange={setWorkspaceOpen}
          className="group/workspaces"
        >
          <SidebarGroup className="workspace-sidebar-group">
            <SidebarGroupLabel render={<CollapsibleTrigger />}>
              <span>{t("工作区", "Workspaces")}</span>
              <ChevronRight className="workspace-group-chevron" />
            </SidebarGroupLabel>
            <SidebarGroupAction
              className="right-10"
              aria-label={t("新增工作区", "Add workspace")}
              title={t("新增工作区", "Add workspace")}
              onClick={chooseProject}
            >
              <Plus />
            </SidebarGroupAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarGroupAction
                    data-testid="workspace-more"
                    aria-label={t("工作区更多操作", "More workspace actions")}
                    title={t("更多", "More")}
                  >
                    <MoreHorizontal />
                  </SidebarGroupAction>
                }
              />
              <DropdownMenuContent align="end" side="right">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    {t("工作区", "Workspaces")}
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={chooseProject}
                  >
                    <FolderPlus />
                    {t("添加工作区", "Add workspace")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      setExpandedProjects(new Set(snapshot.projects))
                    }
                  >
                    <FolderOpen />
                    {t("全部展开", "Expand all")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setExpandedProjects(new Set())}
                  >
                    <Folder />
                    {t("全部折叠", "Collapse all")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    {t("排序方式", "Sort by")}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={snapshot.settings.workspaceSort}
                    onValueChange={(value) => {
                      if (value === "recent" || value === "name")
                        void window.prospero.updateSettings({
                          workspaceSort: value,
                        });
                    }}
                  >
                    <DropdownMenuRadioItem value="recent">
                      <Clock3 />
                      {t("最近使用", "Recent")}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name">
                      <ArrowDownAZ />
                      {t("名称", "Name")}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="workspace-session-search">
              <Search aria-hidden="true" />
              <Input
                type="search"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder={t("搜索会话、状态或路径", "Search sessions, status, or path")}
                aria-label={t("搜索会话", "Search sessions")}
              />
            </div>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {normalizedSessionQuery ? (
                    <>
                      <SidebarMenuItem className="workspace-search-summary" aria-live="polite">
                        <span>
                          {searchLoading
                            ? t("正在搜索会话…", "Searching sessions…")
                            : t(
                                `找到 ${String(searchResultTotal)} 个会话`,
                                `Found ${String(searchResultTotal)} sessions`,
                              )}
                        </span>
                      </SidebarMenuItem>
                      <SidebarMenuSub>
                        {visibleSearchSessions.map((session) => (
                          <WorkspaceSessionRow
                            key={session.id}
                            session={session}
                            active={view === "workspaces" && activeId === session.id}
                            unread={snapshot.unreadSessionIds.includes(session.id)}
                            archived={snapshot.archivedSessionIds.includes(session.id)}
                            onToggleArchive={onToggleArchive}
                            pinned={snapshot.pinnedSessionIds.includes(session.id)}
                            onOpenSession={selectSession}
                            onTogglePin={onTogglePin}
                            onRenameSession={onRenameSession}
                            onDuplicateSession={onDuplicateSession}
                            onSetUnread={onSetUnread}
                          />
                        ))}
                        {searchSessions.length === 0 && !searchLoading && (
                          <SidebarMenuSubItem className="workspace-search-empty">
                            {t("没有匹配的会话", "No matching sessions")}
                          </SidebarMenuSubItem>
                        )}
                        {(searchSessions.length > visibleSearchSessions.length ||
                          (searchPage?.nextCursor &&
                            searchPageQuery === deferredSessionQuery &&
                            searchLimit < SIDEBAR_SEARCH_VISIBLE_LIMIT)) && (
                            <SidebarMenuSubItem className="workspace-session-more-item">
                              <button
                                type="button"
                                data-slot="workspace-session-more"
                                className="workspace-session-more"
                                aria-label={t("显示更多搜索结果", "Show more search results")}
                                onClick={() => {
                                  if (
                                    searchSessions.length >
                                    visibleSearchSessions.length
                                  )
                                    setSearchLimit((current) =>
                                      Math.min(
                                        SIDEBAR_SEARCH_VISIBLE_LIMIT,
                                        current + SIDEBAR_SEARCH_PAGE_SIZE,
                                      ),
                                    );
                                  else loadMoreSearch();
                                }}
                              >
                                {searchLoading ? <Spinner /> : <ChevronRight aria-hidden="true" />}
                                <span>{t("显示更多搜索结果", "Show more search results")}</span>
                              </button>
                            </SidebarMenuSubItem>
                          )}
                      </SidebarMenuSub>
                    </>
                  ) : (
                  visibleProjects.map((project) => {
                    const sessions = sessionsByProject.get(project) ?? [];
                    // 归档的会话从主列表收起。搜索时不过滤 —— 明确搜某个东西的人
                    // 是想找到它,而不是被"你把它归档过"挡回来。
                    const matchingSessions = filterSessionsByQuery(
                      normalizedSessionQuery
                        ? sessions
                        : sessions.filter(
                            (item) => !snapshot.archivedSessionIds.includes(item.id),
                          ),
                      normalizedSessionQuery,
                    );
                    if (normalizedSessionQuery && matchingSessions.length === 0)
                      return null;
                    const fallback =
                      project.split(/[\\/]/).filter(Boolean).at(-1) ?? project;
                    const name =
                      snapshot.projectAliases[project.toLocaleLowerCase()] ||
                      fallback;
                    const projectPinned = snapshot.pinnedProjectPaths.some(
                      (path) =>
                        path.toLocaleLowerCase() ===
                        project.toLocaleLowerCase(),
                    );
                    const projectOpen = expandedProjects.has(project);
                    const sessionLimit = Math.min(
                      matchingSessions.length,
                      sessionLimits[project] ?? SIDEBAR_SESSION_PREVIEW_LIMIT,
                    );
                    const showsAllSessions = sessionLimit >= matchingSessions.length;
                    const visibleSessions = matchingSessions.slice(0, sessionLimit);
                    const hiddenSessionCount = matchingSessions.length - sessionLimit;
                    const nextSessionCount = Math.min(
                      hiddenSessionCount,
                      24,
                    );
                    return (
                      <Collapsible
                        key={project}
                        open={expandedProjects.has(project)}
                        onOpenChange={(open) =>
                          setExpandedProjects((current) => {
                            const next = new Set(current);
                            if (open) next.add(project);
                            else next.delete(project);
                            return next;
                          })
                        }
                        className="group/project"
                      >
                        <SidebarMenuItem className="workspace-project-item">
                          <ContextMenu>
                          <ContextMenuTrigger
                            render={<div className="workspace-project-context" />}
                          >
                          <CollapsibleTrigger
                            render={
                              <SidebarMenuButton
                                className="workspace-project-button"
                                tooltip={name}
                              />
                            }
                          >
                            {projectOpen ? <FolderOpen /> : <Folder />}
                            <span className="truncate">{name}</span>
                            {projectPinned && (
                              <Pin className="workspace-project-pinned" />
                            )}
                            <span className="workspace-session-count">
                              {normalizedSessionQuery
                                ? `${String(matchingSessions.length)}/${String(sessions.length)}`
                                : sessions.length}
                            </span>
                          </CollapsibleTrigger>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuGroup>
                              <ContextMenuLabel>{name}</ContextMenuLabel>
                              <ContextMenuItem onClick={() => newSession(project)}>
                                <Plus />
                                {t("新建会话", "New session")}
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => void window.prospero.revealPath(project)}>
                                <FolderOpen />
                                {isMac ? t("在访达中显示", "Reveal in Finder") : t("在资源管理器中打开", "Open in Explorer")}
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => void window.prospero.openWindowsTerminal(project)}>
                                <SquareTerminal />
                                {isMac ? t("在终端中打开", "Open in Terminal") : "Windows Terminal"}
                              </ContextMenuItem>
                            </ContextMenuGroup>
                            <ContextMenuSeparator />
                            <ContextMenuGroup>
                              <ContextMenuItem onClick={() => onRenameProject(project)}>
                                <Pencil />
                                {t("编辑名称", "Edit name")}
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => void window.prospero.setProjectPinned(project, !projectPinned)}>
                                {projectPinned ? <PinOff /> : <Pin />}
                                {projectPinned ? t("取消置顶", "Unpin") : t("置顶工作区", "Pin workspace")}
                              </ContextMenuItem>
                              <ContextMenuItem variant="destructive" onClick={() => void window.prospero.forgetProject(project)}>
                                <X />
                                {t("从列表移除", "Remove from list")}
                              </ContextMenuItem>
                            </ContextMenuGroup>
                          </ContextMenuContent>
                          </ContextMenu>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <button
                                  type="button"
                                  data-slot="workspace-project-more"
                                  data-testid="workspace-project-more"
                                  className="workspace-project-more"
                                  aria-label={t(
                                    `${name} 操作`,
                                    `${name} actions`,
                                  )}
                                  title={t("更多", "More")}
                                >
                                  <MoreHorizontal />
                                </button>
                              }
                            />
                            <DropdownMenuContent align="start" side="right">
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>{name}</DropdownMenuLabel>
                                <DropdownMenuItem
                                  onClick={() =>
                                    void window.prospero.setProjectPinned(
                                      project,
                                      !projectPinned,
                                    )
                                  }
                                >
                                  {projectPinned ? <PinOff /> : <Pin />}
                                  {projectPinned
                                    ? t("取消置顶", "Unpin")
                                    : t("置顶工作区", "Pin workspace")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => onRenameProject(project)}
                                >
                                  <Pencil />
                                  {t("编辑名称", "Edit name")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    void window.prospero.revealPath(project)
                                  }
                                >
                                  <FolderOpen />
                                  {isMac
                                    ? t("在访达中显示", "Reveal in Finder")
                                    : t("在资源管理器中打开", "Open in Explorer")}
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() =>
                                    void window.prospero.forgetProject(project)
                                  }
                                >
                                  <Trash2 />
                                  {t("移除工作区", "Remove workspace")}
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <CollapsibleContent>
                            <SidebarMenuSub>
                              {visibleSessions.map((session) => (
                                <WorkspaceSessionRow
                                  key={session.id}
                                  session={session}
                                  active={
                                    view === "workspaces" && activeId === session.id
                                  }
                                  unread={snapshot.unreadSessionIds.includes(
                                    session.id,
                                  )}
                                  archived={snapshot.archivedSessionIds.includes(
                                    session.id,
                                  )}
                                  onToggleArchive={onToggleArchive}
                                  pinned={snapshot.pinnedSessionIds.includes(
                                    session.id,
                                  )}
                                  onOpenSession={selectSession}
                                  onTogglePin={onTogglePin}
                                  onRenameSession={onRenameSession}
                                  onDuplicateSession={onDuplicateSession}
                                  onSetUnread={onSetUnread}
                                />
                              ))}
                              {matchingSessions.length >
                                SIDEBAR_SESSION_PREVIEW_LIMIT && (
                                <SidebarMenuSubItem className="workspace-session-more-item">
                                  <button
                                    type="button"
                                    data-slot="workspace-session-more"
                                    className="workspace-session-more"
                                    aria-expanded={showsAllSessions}
                                    aria-label={
                                      showsAllSessions
                                        ? t(
                                            `收起 ${name} 的会话`,
                                            `Show fewer sessions in ${name}`,
                                          )
                                        : t(
                                            `在 ${name} 中再显示 ${String(nextSessionCount)} 个会话，剩余 ${String(hiddenSessionCount)} 个`,
                                            `Show ${String(nextSessionCount)} more sessions in ${name}; ${String(hiddenSessionCount)} remaining`,
                                          )
                                    }
                                    onClick={() =>
                                      setSessionLimits((current) => ({
                                        ...current,
                                        [project]: nextSidebarSessionLimit(
                                          sessionLimit,
                                          matchingSessions.length,
                                        ),
                                      }))
                                    }
                                  >
                                    <ChevronRight aria-hidden="true" />
                                    <span>
                                      {showsAllSessions
                                        ? t("收起会话", "Show fewer")
                                        : t(
                                            `再显示 ${String(nextSessionCount)} 个 · 剩余 ${String(hiddenSessionCount)}`,
                                            `Show ${String(nextSessionCount)} more · ${String(hiddenSessionCount)} remaining`,
                                          )}
                                    </span>
                                  </button>
                                </SidebarMenuSubItem>
                              )}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </SidebarMenuItem>
                      </Collapsible>
                    );
                  })
                  )}
                  {!normalizedSessionQuery && hiddenProjectCount > 0 && (
                    <SidebarMenuItem className="workspace-session-more-item">
                      <button
                        type="button"
                        data-slot="workspace-session-more"
                        className="workspace-session-more"
                        aria-label={t(
                          `显示更多工作区，剩余 ${String(hiddenProjectCount)}`,
                          `Show more workspaces; ${String(hiddenProjectCount)} remaining`,
                        )}
                        onClick={() =>
                          setProjectLimit((current) =>
                            current + SIDEBAR_PROJECT_PAGE_SIZE,
                          )
                        }
                      >
                        <ChevronRight aria-hidden="true" />
                        <span>
                          {t(
                            `显示更多工作区 · 剩余 ${String(hiddenProjectCount)}`,
                            `Show more workspaces · ${String(hiddenProjectCount)} remaining`,
                          )}
                        </span>
                      </button>
                    </SidebarMenuItem>
                  )}
                  {snapshot.projects.length === 0 && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={chooseProject}
                      >
                        <FolderPlus />
                        <span>{t("添加工作区", "Add workspace")}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      </SidebarContent>
      <SidebarFooter className="px-3 pb-3">
        <SidebarMenu className="sidebar-footer-actions">
          <SidebarMenuItem>
            <HoverCard onOpenChange={handleDaemonCardOpen}>
              <HoverCardTrigger
                delay={180}
                closeDelay={160}
                render={
                  <SidebarMenuButton
                    data-testid="sidebar-daemon"
                    aria-label={t("Daemon 状态", "Daemon status")}
                    onClick={() =>
                      snapshot.daemon.running
                        ? selectView("settings")
                        : void window.prospero.startDaemon()
                    }
                  />
                }
              >
                {snapshot.daemon.starting ? (
                  <LoaderCircle className="daemon-spinner" />
                ) : (
                  <span className={cn("sidebar-daemon-dot", snapshot.daemon.running ? "online" : "offline")} />
                )}
                <span>{snapshot.daemon.starting ? t("启动中", "Starting") : "Daemon"}</span>
              </HoverCardTrigger>
              <HoverCardContent side="right" align="end" sideOffset={10} className="w-80 p-0">
                <DaemonAgentsCard snapshot={snapshot} usage={daemonUsage} loading={daemonUsageLoading} />
              </HoverCardContent>
            </HoverCard>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={view === "settings"}
              tooltip={t("设置", "Settings")}
              onClick={() => selectView("settings")}
            >
              <Settings />
              <span>{t("设置", "Settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="view-heading">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </header>
  );
}

function AttentionCard({
  icon: Icon,
  title,
  description,
  status,
  action,
}: {
  icon: ComponentType;
  title: string;
  description: string;
  status: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="attention-row">
      <span className={cn("attention-icon", `tone-${status}`)}>
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {action ?? <ChevronRight className="text-muted-foreground" />}
    </div>
  );
}

function OverviewPane({
  snapshot,
  onOpenSession,
  onOpenInbox,
  onOpenRuns,
  onOpenWorkspaces,
  onNewSession,
}: {
  snapshot: DesktopSnapshot;
  onOpenSession: (id: string) => void;
  onOpenInbox: () => void;
  onOpenRuns: () => void;
  onOpenWorkspaces: () => void;
  onNewSession: (project: string) => void;
}) {
  const { t, status } = useLocale();
  const activeSessions = snapshot.daemon.sessions.filter((session) =>
    ["running", "starting", "waiting_approval", "waiting_input"].includes(
      session.status,
    ),
  );
  const failedTasks = snapshot.orchestration.tasks.filter((task) =>
    ["failed", "blocked"].includes(text(task["status"])),
  );
  const pendingGates = snapshot.orchestration.gates.filter(
    (gate) => text(gate["status"]) === "pending",
  );
  const activeRun =
    snapshot.orchestration.runs.find(
      (run) => text(run["status"]) === "active",
    ) ?? snapshot.orchestration.runs[0];
  const runId = text(activeRun?.["id"]);
  const runTasks = snapshot.orchestration.tasks.filter(
    (task) => text(task["runId"]) === runId,
  );
  const doneCount = runTasks.filter((task) =>
    ["done", "completed", "succeeded"].includes(text(task["status"])),
  ).length;
  const progress = runTasks.length
    ? Math.round((doneCount / runTasks.length) * 100)
    : 0;
  const attentionCount =
    pendingGates.length +
    failedTasks.length +
    activeSessions.reduce(
      (sum, session) =>
        sum +
        (session.pendingPermissions ?? 0) +
        (session.pendingQuestions ?? 0),
      0,
    ) +
    (snapshot.daemon.running ? 0 : 1);
  const orderedActiveSessions = sortSidebarSessions(
    activeSessions,
    undefined,
    snapshot.pinnedSessionIds,
    snapshot.unreadSessionIds,
  );
  const recentProjects = sortProjectsByRecentActivity(
    snapshot.projects,
    snapshot.daemon.sessions,
  ).slice(0, 4);
  return (
    <div className="view-scroll">
      <div className="view-container overview-view">
        <h1 className="sr-only">{t("概览", "Overview")}</h1>
        <div className="overview-grid">
          <Card className="attention-card-shell">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>
                    {t("需要你处理", "Needs your attention")}
                  </CardTitle>
                  <CardDescription>
                    {t(
                      "先处理会阻塞 Agent 的事项",
                      "Resolve anything blocking an agent first",
                    )}
                  </CardDescription>
                </div>
                <Badge variant={attentionCount ? "secondary" : "outline"}>
                  {attentionCount}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {!snapshot.daemon.running && (
                <AttentionCard
                  icon={WifiOff}
                  title={t("本地服务离线", "Local service is offline")}
                  description={
                    snapshot.daemon.lastError ||
                    t(
                      "启动 daemon 后才能继续本地任务",
                      "Start the daemon to continue local work",
                    )
                  }
                  status="danger"
                  action={
                    <Button
                      size="sm"
                      onClick={() => void window.prospero.startDaemon()}
                    >
                      {t("启动", "Start")}
                    </Button>
                  }
                />
              )}
              {pendingGates.slice(0, 2).map((gate) => (
                <AttentionCard
                  key={text(gate["id"])}
                  icon={ListChecks}
                  title={text(gate["question"], t("审批请求", "Gate request"))}
                  description={t(
                    "Run 正在等待你的决定",
                    "The run is waiting for your decision",
                  )}
                  status="warning"
                  action={
                    <Button variant="outline" size="sm" onClick={onOpenRuns}>
                      {t("处理", "Review")}
                    </Button>
                  }
                />
              ))}
              {failedTasks.slice(0, 2).map((task) => (
                <AttentionCard
                  key={text(task["id"])}
                  icon={CircleAlert}
                  title={text(task["title"], t("任务失败", "Task failed"))}
                  description={`${status(text(task["status"]))} · ${t("打开 Run 查看上下文", "Open the run for context")}`}
                  status="danger"
                  action={
                    <Button variant="outline" size="sm" onClick={onOpenRuns}>
                      {t("查看", "View")}
                    </Button>
                  }
                />
              ))}
              {activeSessions
                .filter(
                  (session) =>
                    (session.pendingPermissions ?? 0) +
                      (session.pendingQuestions ?? 0) >
                    0,
                )
                .slice(0, 2)
                .map((session) => (
                  <AttentionCard
                    key={session.id}
                    icon={MessageSquare}
                    title={sessionLabel(session)}
                    description={t(
                      `${session.agent} 需要输入后才能继续`,
                      `${session.agent} needs input to continue`,
                    )}
                    status="warning"
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenSession(session.id)}
                      >
                        {t("回复", "Reply")}
                      </Button>
                    }
                  />
                ))}
              {attentionCount === 0 && (
                <div className="calm-empty">
                  <CheckCircle2 />
                  <div>
                    <strong>{t("一切顺利", "All clear")}</strong>
                    <p>
                      {t(
                        "当前没有待审批、失败或离线事件。",
                        "No approvals, failures, or offline events need attention.",
                      )}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
            {attentionCount > 0 && (
              <CardFooter>
                <Button variant="ghost" size="sm" onClick={onOpenInbox}>
                  {t("打开收件箱", "Open inbox")}{" "}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </CardFooter>
            )}
          </Card>
          <Card className="run-focus-card">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <Badge variant="outline">{t("当前运行", "CURRENT RUN")}</Badge>
                {activeRun && (
                  <Badge variant="secondary">
                    {status(text(activeRun["status"]))}
                  </Badge>
                )}
              </div>
              <CardTitle>
                {text(
                  activeRun?.["objective"],
                  t("还没有正在运行的 Run", "No active run yet"),
                )}
              </CardTitle>
              <CardDescription>
                {activeRun
                  ? t(
                      `${String(doneCount)} / ${String(runTasks.length)} 个任务已完成`,
                      `${String(doneCount)} of ${String(runTasks.length)} tasks complete`,
                    )
                  : t(
                      "从运行页创建目标并拆分任务",
                      "Create a goal in Runs and break it into tasks",
                    )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {t("运行进度", "Run progress")}
                  </span>
                  <strong>{progress}%</strong>
                </div>
                <Progress value={progress} />
              </div>
              <div className="run-task-preview">
                {runTasks.slice(0, 4).map((task) => (
                  <div key={text(task["id"])}>
                    <StatusMark status={text(task["status"])} />
                    <span className="truncate">{text(task["title"])}</span>
                    <small>{status(text(task["status"]))}</small>
                  </div>
                ))}
                {runTasks.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "任务会在这里形成一条轻量工作流。",
                      "Tasks will form a lightweight workflow here.",
                    )}
                  </p>
                )}
              </div>
            </CardContent>
            <CardFooter>
              <Button variant="outline" onClick={onOpenRuns}>
                {t("打开运行", "Open run")}{" "}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardFooter>
          </Card>
          <Card className="active-work-card">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>{t("活跃工作", "Active work")}</CardTitle>
                  <CardDescription>
                    {t(
                      "正在工作的 Agent 与最近上下文",
                      "Active agents and recent context",
                    )}
                  </CardDescription>
                </div>
                <Badge variant="outline">{activeSessions.length}</Badge>
              </div>
            </CardHeader>
            <CardContent className="active-agent-list">
              {orderedActiveSessions.slice(0, 6).map((session) => (
                <button
                  key={session.id}
                  onClick={() => onOpenSession(session.id)}
                >
                  <Avatar>
                    <AvatarFallback>
                      <AgentLogo agent={session.agent} size={18} />
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1">
                    <strong className="truncate">
                      {sessionLabel(session)}
                    </strong>
                    <small>
                      <StatusMark status={session.status} />
                      {session.agent} · {status(session.status)} ·{" "}
                      {shortPath(session.cwd)}
                    </small>
                  </span>
                  <ChevronRight />
                </button>
              ))}
              {activeSessions.length === 0 && (
                <div className="calm-empty">
                  <Bot />
                  <div>
                    <strong>{t("没有活跃 Agent", "No active agents")}</strong>
                    <p>
                      {t(
                        "新建会话后会显示在这里。",
                        "New sessions will appear here.",
                      )}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
            {activeSessions.length > 6 && (
              <CardFooter>
                <Button variant="ghost" size="sm" onClick={onOpenWorkspaces}>
                  {t("打开工作台", "Open workspaces")}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </CardFooter>
            )}
          </Card>
        </div>
        <section className="recent-section">
          <div className="section-heading">
            <div>
              <h2>{t("最近的工作区", "Recent workspaces")}</h2>
              <p>
                {t(
                  "回到上次离开的项目与会话",
                  "Return to projects and sessions where you left off",
                )}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void window.prospero.chooseProject()}
            >
              <FolderPlus data-icon="inline-start" />
              {t("添加工作区", "Add workspace")}
            </Button>
          </div>
          <div className="workspace-cards">
            {recentProjects.map((project) => {
              const sessions = snapshot.daemon.sessions
                .filter((session) => projectForSession([project], session))
                .sort(
                  (left, right) =>
                    (right.createdAt ?? 0) - (left.createdAt ?? 0),
                );
              const name =
                project.split(/[\\/]/).filter(Boolean).at(-1) ?? project;
              return (
                <Card size="sm" key={project}>
                  <CardHeader>
                    <div className="workspace-symbol">
                      <FolderKanban />
                    </div>
                    <CardTitle>{name}</CardTitle>
                    <CardDescription title={project}>
                      {shortPath(project)}
                    </CardDescription>
                  </CardHeader>
                  <CardFooter>
                    <span>
                      {sessions.length} {t("个会话", "sessions")}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t(`打开 ${name}`, `Open ${name}`)}
                      onClick={() =>
                        sessions[0]
                          ? onOpenSession(sessions[0].id)
                          : onNewSession(project)
                      }
                    >
                      <ArrowRight />
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
            {snapshot.projects.length === 0 && (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderPlus />
                  </EmptyMedia>
                  <EmptyTitle>
                    {t("添加第一个工作区", "Add your first workspace")}
                  </EmptyTitle>
                  <EmptyDescription>
                    {t(
                      "选择本地项目后开始与 Agent 协作。",
                      "Choose a local project to start collaborating with an agent.",
                    )}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => void window.prospero.chooseProject()}>
                    {t("选择文件夹", "Choose folder")}
                  </Button>
                </EmptyContent>
              </Empty>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function InboxPane({
  snapshot,
  onOpenSession,
  onOpenRuns,
}: {
  snapshot: DesktopSnapshot;
  onOpenSession: (id: string) => void;
  onOpenRuns: () => void;
}) {
  const { t, status } = useLocale();
  const [gateDecisions, setGateDecisions] = useState<Record<string, string>>(
    {},
  );
  const gateSubmissionRef = useRef(new Set<string>());
  const [gateSubmissions, setGateSubmissions] = useState<Record<string, string>>({});
  const [gateErrors, setGateErrors] = useState<Record<string, string>>({});
  const gates = snapshot.orchestration.gates.filter(
    (gate) => text(gate["status"]) === "pending",
  );
  const taskIssues = snapshot.orchestration.tasks.filter((task) =>
    ["failed", "blocked"].includes(text(task["status"])),
  );
  const sessionIssues = snapshot.daemon.sessions.filter(
    (session) =>
      (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0) > 0,
  );
  const total =
    gates.length +
    taskIssues.length +
    sessionIssues.length +
    (snapshot.daemon.running ? 0 : 1);
  const resolveInboxGate = async (gateId: string, decision: string): Promise<void> => {
    if (gateSubmissionRef.current.has(gateId)) return;
    gateSubmissionRef.current.add(gateId);
    setGateSubmissions((current) => ({ ...current, [gateId]: decision }));
    setGateErrors((current) => {
      const next = { ...current };
      delete next[gateId];
      return next;
    });
    try {
      await window.prospero.resolveGate(gateId, decision);
      setGateDecisions((current) => ({ ...current, [gateId]: "" }));
    } catch (reason) {
      setGateErrors((current) => ({ ...current, [gateId]: displayError(reason) }));
    } finally {
      gateSubmissionRef.current.delete(gateId);
      setGateSubmissions((current) => {
        const next = { ...current };
        delete next[gateId];
        return next;
      });
    }
  };
  const gateActions = (gate: JsonObject): React.ReactNode => {
    const gateId = text(gate["id"]);
    const options = Array.isArray(gate["options"])
      ? (gate["options"] as unknown[]).map(String)
      : [];
    const submitting = gateSubmissions[gateId];
    const error = gateErrors[gateId];
    if (options.length > 0) {
      return <>
        {options.map((option) => (
          <Button
            key={option}
            variant="outline"
            size="sm"
            disabled={Boolean(submitting)}
            onClick={() => void resolveInboxGate(gateId, option)}
          >
            {submitting === option && <Spinner data-icon="inline-start" />}
            {option}
          </Button>
        ))}
        {error && <span className="w-full text-xs text-destructive" role="alert">{error}</span>}
      </>;
    }
    const decision = gateDecisions[gateId] ?? "";
    return (
      <>
        <div className="gate-freeform-row">
          <Input
            value={decision}
            maxLength={20_000}
            disabled={Boolean(submitting)}
            aria-label={t("输入 Gate 决定", "Enter gate decision")}
            placeholder={t("输入决定", "Enter a decision")}
            onChange={(event) =>
              setGateDecisions((current) => ({
                ...current,
                [gateId]: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !decision.trim() || submitting) return;
              event.preventDefault();
              void resolveInboxGate(gateId, decision.trim());
            }}
          />
          <Button
            size="sm"
            disabled={!decision.trim() || Boolean(submitting)}
            onClick={() => void resolveInboxGate(gateId, decision.trim())}
          >
            {submitting && <Spinner data-icon="inline-start" />}
            {submitting ? t("提交中…", "Submitting…") : t("确认", "Confirm")}
          </Button>
        </div>
        {error && <span className="w-full text-xs text-destructive" role="alert">{error}</span>}
      </>
    );
  };
  return (
    <div className="view-scroll">
      <div className="view-container inbox-view">
        <PageHeading
          eyebrow={t("行动队列", "ACTION QUEUE")}
          title={t("收件箱", "Inbox")}
          description={t(
            "这里只保留需要你采取行动的事件，普通动态不会淹没决策。",
            "Only actionable events appear here, so routine activity never hides a decision.",
          )}
          actions={
            <Badge variant="secondary">
              {total} {t("项待处理", "open")}
            </Badge>
          }
        />
        <div className="inbox-list">
          {!snapshot.daemon.running && (
            <Card className="inbox-item tone-danger">
              <CardHeader>
                <div className="inbox-item-head">
                  <span className="attention-icon tone-danger">
                    <WifiOff />
                  </span>
                  <div>
                    <CardTitle>
                      {t("运行环境已断开", "Runtime disconnected")}
                    </CardTitle>
                    <CardDescription>
                      Prospero daemon · {isMac ? t("此 Mac", "This Mac") : t("本机 Windows", "This Windows PC")}
                    </CardDescription>
                  </div>
                  <Badge variant="destructive">{t("离线", "Offline")}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p>
                  {snapshot.daemon.lastError ||
                    t(
                      "本地运行环境不可用，当前会话暂时无法继续执行。",
                      "The local runtime is unavailable, so active sessions cannot continue.",
                    )}
                </p>
              </CardContent>
              <CardFooter>
                <Button onClick={() => void window.prospero.startDaemon()}>
                  {t("重新连接", "Reconnect")}
                </Button>
              </CardFooter>
            </Card>
          )}
          {gates.map((gate) => (
            <Card className="inbox-item tone-warning" key={text(gate["id"])}>
              <CardHeader>
                <div className="inbox-item-head">
                  <span className="attention-icon tone-warning">
                    <ListChecks />
                  </span>
                  <div>
                    <CardTitle>
                      {text(
                        gate["question"],
                        t("请求审批", "Review requested"),
                      )}
                    </CardTitle>
                    <CardDescription>
                      {t("审批请求", "Gate request")} ·{" "}
                      {text(gate["runId"]).slice(0, 8)}
                    </CardDescription>
                  </div>
                  <Badge variant="secondary">
                    {t("需要决定", "Needs decision")}
                  </Badge>
                </div>
              </CardHeader>
              {text(gate["reason"]) && (
                <CardContent>
                  <p>{text(gate["reason"])}</p>
                </CardContent>
              )}
              <CardFooter className="flex-wrap">
                {gateActions(gate)}
                <Button variant="ghost" size="sm" onClick={onOpenRuns}>
                  {t("打开运行", "Open run")}
                </Button>
              </CardFooter>
            </Card>
          ))}
          {sessionIssues.map((session) => (
            <Card className="inbox-item tone-warning" key={session.id}>
              <CardHeader>
                <div className="inbox-item-head">
                  <span className="attention-icon tone-warning">
                    <MessageSquare />
                  </span>
                  <div>
                    <CardTitle>{sessionLabel(session)}</CardTitle>
                    <CardDescription>
                      {session.agent} · {shortPath(session.cwd)}
                    </CardDescription>
                  </div>
                  <Badge variant="secondary">
                    {t("需要输入", "Needs input")}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p>
                  {(session.pendingPermissions ?? 0) > 0
                    ? t(
                        `${String(session.pendingPermissions)} 个权限请求等待处理`,
                        `${String(session.pendingPermissions)} permission requests awaiting review`,
                      )
                    : t(
                        `${String(session.pendingQuestions ?? 0)} 个问题等待回复`,
                        `${String(session.pendingQuestions ?? 0)} questions awaiting a reply`,
                      )}
                </p>
              </CardContent>
              <CardFooter>
                <Button size="sm" onClick={() => onOpenSession(session.id)}>
                  {t("打开会话", "Open session")}
                </Button>
              </CardFooter>
            </Card>
          ))}
          {taskIssues.map((task) => (
            <Card className="inbox-item tone-danger" key={text(task["id"])}>
              <CardHeader>
                <div className="inbox-item-head">
                  <span className="attention-icon tone-danger">
                    <CircleAlert />
                  </span>
                  <div>
                    <CardTitle>
                      {text(task["title"], t("任务失败", "Task failed"))}
                    </CardTitle>
                    <CardDescription>
                      {t("任务", "Task")} · {status(text(task["status"]))}
                    </CardDescription>
                  </div>
                  <Badge variant="destructive">
                    {status(text(task["status"]))}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p>
                  {text(
                    task["spec"],
                    t(
                      "打开对应 Run 查看失败上下文与执行结果。",
                      "Open the related run for failure context and results.",
                    ),
                  )}
                </p>
              </CardContent>
              <CardFooter>
                <Button variant="outline" size="sm" onClick={onOpenRuns}>
                  {t("查看运行", "View run")}
                </Button>
                {text(task["status"]) === "failed" && (
                  <Button
                    size="sm"
                    onClick={() =>
                      void window.prospero.orchestrationAction("task.retry", {
                        operationId: crypto.randomUUID(),
                        taskId: text(task["id"]),
                      })
                    }
                  >
                    {t("重试", "Retry")}
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
          {total === 0 && (
            <Empty className="inbox-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Archive />
                </EmptyMedia>
                <EmptyTitle>{t("收件箱已清空", "Inbox is clear")}</EmptyTitle>
                <EmptyDescription>
                  {t(
                    "当前没有需要你审批、回复或恢复的工作。",
                    "Nothing needs your approval, reply, or recovery.",
                  )}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentsPane({
  snapshot,
  onOpenSession,
  onNewSession,
}: {
  snapshot: DesktopSnapshot;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
}) {
  const { t, status } = useLocale();
  const ids = [
    ...new Set([
      ...snapshot.daemon.sessions.map((session) => session.agent),
      ...snapshot.accounts
        .map((account) => text(account["agent"]))
        .filter(Boolean),
    ]),
  ];
  const agents = ids.length ? ids : ["codex", "claude", "opencode"];
  return (
    <div className="view-scroll">
      <div className="view-container">
        <PageHeading
          eyebrow={t("AI 协作者", "AI COLLABORATORS")}
          title={t("协作者", "Agents")}
          description={t(
            "Agent 是可复用的工作角色；账号、模型来源和执行环境在各自页面管理。",
            "Agents are reusable roles; accounts, providers, and runtimes are managed separately.",
          )}
          actions={
            <Button onClick={onNewSession}>
              <Plus data-icon="inline-start" />
              {t("运行 Agent", "Run agent")}
            </Button>
          }
        />
        <div className="agent-grid">
          {agents.map((agent) => {
            const sessions = snapshot.daemon.sessions.filter(
              (session) => session.agent === agent,
            );
            const active = sessions.filter((session) =>
              [
                "running",
                "starting",
                "waiting_input",
                "waiting_approval",
              ].includes(session.status),
            );
            const account = snapshot.accounts.find(
              (item) => text(item["agent"]) === agent,
            );
            return (
              <Card key={agent} className="agent-card">
                <CardHeader>
                  <div className="agent-card-identity">
                    <Avatar className="size-11">
                      <AvatarFallback>
                        <AgentLogo agent={agent} size={25} />
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <CardTitle className="capitalize">{agent}</CardTitle>
                      <CardDescription>
                        {agent === "codex"
                          ? t(
                              "编码、重构与仓库工作",
                              "Coding, refactoring, and repository work",
                            )
                          : agent === "claude"
                            ? t(
                                "分析、写作与复杂推理",
                                "Analysis, writing, and complex reasoning",
                              )
                            : t(
                                "本地 Agent 协作者",
                                "Local agent collaborator",
                              )}
                      </CardDescription>
                    </div>
                    <StatusMark
                      status={active.length ? "running" : "completed"}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <dl className="agent-facts">
                    <div>
                      <dt>{t("默认模型", "Default model")}</dt>
                      <dd>
                        {text(
                          account?.["model"],
                          t("Agent 默认", "Agent default"),
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("权限", "Permission")}</dt>
                      <dd>{sessions[0]?.approvalPolicy || "standard"}</dd>
                    </div>
                    <div>
                      <dt>{t("活跃任务", "Active tasks")}</dt>
                      <dd>{active.length}</dd>
                    </div>
                    <div>
                      <dt>{t("最近运行", "Recent runs")}</dt>
                      <dd>{sessions.length}</dd>
                    </div>
                  </dl>
                  {active.slice(0, 2).map((session) => (
                    <button
                      className="agent-active-task"
                      key={session.id}
                      onClick={() => onOpenSession(session.id)}
                    >
                      <StatusMark status={session.status} />
                      <span className="truncate">{sessionLabel(session)}</span>
                      <ChevronRight />
                    </button>
                  ))}
                </CardContent>
                <CardFooter>
                  <Badge
                    variant={
                      text(account?.["status"]) === "signed_in"
                        ? "secondary"
                        : "outline"
                    }
                  >
                    {account
                      ? status(text(account["status"]))
                      : t("使用本地环境", "Uses local environment")}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!sessions[0]}
                    onClick={() => sessions[0] && onOpenSession(sessions[0].id)}
                  >
                    {t("打开", "Open")}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WorkspaceContextPane({
  session,
  snapshot,
}: {
  session: SessionInfo;
  snapshot: DesktopSnapshot;
}) {
  const { t, status } = useLocale();
  const [usage, setUsage] = useState<UsageReport>();
  useEffect(() => {
    setUsage(undefined);
    void window.prospero
      .getUsage(session.id)
      .then(setUsage)
      .catch(() => setUsage(undefined));
  }, [session.id]);
  const dispatch = snapshot.orchestration.dispatches.find(
    (item) => text(item["sessionId"]) === session.id,
  );
  const task = dispatch
    ? snapshot.orchestration.tasks.find(
        (item) => text(item["id"]) === text(dispatch["taskId"]),
      )
    : undefined;
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  return (
    <Tabs defaultValue="task" className="context-pane-tabs">
      <div className="pane-tabbar">
        <TabsList variant="line">
          <TabsTrigger value="task">{t("任务", "Task")}</TabsTrigger>
          <TabsTrigger value="diff">Diff</TabsTrigger>
          <TabsTrigger value="execution">{t("执行", "Execution")}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="task" className="context-pane-content">
        {task ? (
          <>
            <div className="context-pane-heading">
              <Badge variant="secondary">{status(text(task["status"]))}</Badge>
              <h2>{text(task["title"])}</h2>
              <p>{text(task["spec"])}</p>
            </div>
            <Separator />
            <dl className="detail-list">
              <div>
                <dt>Agent</dt>
                <dd>{session.agent}</dd>
              </div>
              <div>
                <dt>{t("运行环境", "Runtime")}</dt>
                <dd>{isMac ? t("此 Mac", "This Mac") : t("本机 Windows", "This Windows PC")}</dd>
              </div>
              <div>
                <dt>{t("分支", "Branch")}</dt>
                <dd className="font-mono">
                  {text(dispatch?.["branch"], "workspace")}
                </dd>
              </div>
              <div>
                <dt>Worktree</dt>
                <dd
                  className="truncate font-mono"
                  title={text(dispatch?.["worktreePath"])}
                >
                  {shortPath(text(dispatch?.["worktreePath"], session.cwd))}
                </dd>
              </div>
              <div>
                <dt>{t("依赖", "Dependencies")}</dt>
                <dd>{Array.isArray(task["deps"]) ? task["deps"].length : 0}</dd>
              </div>
            </dl>
          </>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ListChecks />
              </EmptyMedia>
              <EmptyTitle>{t("未关联任务", "No linked task")}</EmptyTitle>
              <EmptyDescription>
                {t(
                  "这个会话尚未绑定到编排任务，仍可作为独立工作上下文使用。",
                  "This session is not linked to an orchestration task and can still be used independently.",
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </TabsContent>
      <TabsContent value="diff" className="context-pane-content">
        <div className="context-pane-heading">
          <Badge variant="outline">{t("变更文件", "CHANGED FILES")}</Badge>
          <h2>{t("工作树差异", "Working tree diff")}</h2>
          <p>
            {t(
              "Diff 是独立 Pane，不再嵌入 Conversation。",
              "Diff is an independent pane rather than part of the conversation.",
            )}
          </p>
        </div>
        <div className="diff-placeholder">
          <FileDiff />
          <strong>
            {task
              ? t(
                  "等待 daemon 提供结构化变更摘要",
                  "Waiting for a structured change summary",
                )
              : t("暂无任务 Diff", "No task diff available")}
          </strong>
          <p>
            {t(
              "打开相关 worktree 可查看当前文件变更。",
              "Open the related worktree to inspect current file changes.",
            )}
          </p>
          {text(dispatch?.["worktreePath"]) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.prospero.revealPath(
                  text(dispatch?.["worktreePath"]),
                )
              }
            >
              <FolderOpen data-icon="inline-start" />
              {t("打开工作树", "Open worktree")}
            </Button>
          )}
        </div>
      </TabsContent>
      <TabsContent value="execution" className="context-pane-content">
        <div className="context-pane-heading">
          <Badge variant="outline">{t("执行", "EXECUTION")}</Badge>
          <h2>{t("会话运行环境", "Session runtime")}</h2>
          <p>
            {t(
              "会话、模型、额度与运行位置。",
              "Session, model, usage, and execution location.",
            )}
          </p>
        </div>
        <dl className="detail-list">
          <div>
            <dt>{t("状态", "Status")}</dt>
            <dd>
              <StatusMark status={session.status} />
              {status(session.status)}
            </dd>
          </div>
          <div>
            <dt>{t("模式", "Mode")}</dt>
            <dd>
              {session.kind === "pty"
                ? t("PTY 终端", "PTY terminal")
                : t("结构化会话", "Structured conversation")}
            </dd>
          </div>
          <div>
            <dt>{t("审批", "Approval")}</dt>
            <dd>{session.approvalPolicy || "standard"}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{tokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>{t("会话", "Session")}</dt>
            <dd className="font-mono">{session.id.slice(0, 10)}…</dd>
          </div>
        </dl>
        <div className="context-actions">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void window.prospero.openWindowsTerminal(session.cwd)
            }
          >
            <SquareTerminal data-icon="inline-start" />
            {isMac ? t("终端", "Terminal") : "Windows Terminal"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.prospero.revealPath(session.cwd)}
          >
            <FolderOpen data-icon="inline-start" />
            {isMac ? t("在访达中显示", "Reveal in Finder") : "Explorer"}
          </Button>
        </div>
      </TabsContent>
    </Tabs>
  );
}

function WorkspacePane({
  snapshot,
  activeId,
  openIds,
  onActivate,
  onClose,
  onNewSession,
  onOpenRun,
  onTogglePin,
  focus,
}: {
  snapshot: DesktopSnapshot;
  activeId: string | undefined;
  openIds: string[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewSession: (project?: string) => void;
  onOpenRun: (runId?: string) => void;
  onTogglePin: (id: string) => void;
  focus: boolean;
}) {
  const { t, status } = useLocale();
  const [showContext, setShowContext] = useState(false);
  const contextVisible = showContext && !focus;
  const [contextSheet, setContextSheet] = useState(false);
  const active = snapshot.daemon.sessions.find(
    (session) => session.id === activeId,
  );
  const activeDispatch = active
    ? snapshot.orchestration.dispatches.find(
        (dispatch) => text(dispatch["sessionId"]) === active.id,
      )
    : undefined;
  return (
    <div className="workspace-view workspace-view-single">
      <div className="pane-workspace">
        <div className="workspace-tabbar">
          {!focus && <div className="workspace-tabs" role="tablist">
            {openIds.map((id) => {
              const session = snapshot.daemon.sessions.find(
                (item) => item.id === id,
              );
              if (!session) return null;
              const pinned = snapshot.pinnedSessionIds.includes(id);
              return (
                <div
                  key={id}
                  className={cn(
                    "workspace-tab",
                    id === activeId && "is-active",
                  )}
                >
                  <button
                    type="button"
                    data-slot="workspace-tab-main"
                    className="workspace-tab-main"
                    role="tab"
                    aria-selected={id === activeId}
                    tabIndex={id === activeId ? 0 : -1}
                    onClick={() => onActivate(id)}
                  >
                    <SessionAgentIcon agent={session.agent} />
                    <span className="truncate">{sessionLabel(session)}</span>
                  </button>
                  <button
                    type="button"
                    data-slot="workspace-tab-pin"
                    data-testid="workspace-tab-pin"
                    className={cn(
                      "workspace-tab-action",
                      pinned && "is-pinned",
                    )}
                    aria-pressed={pinned}
                    aria-label={
                      pinned
                        ? t(
                            `取消置顶 ${sessionLabel(session)}`,
                            `Unpin ${sessionLabel(session)}`,
                          )
                        : t(
                            `置顶 ${sessionLabel(session)}`,
                            `Pin ${sessionLabel(session)}`,
                          )
                    }
                    onClick={() => onTogglePin(id)}
                  >
                    <Pin aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    data-slot="workspace-tab-close"
                    data-testid="workspace-tab-close"
                    className="workspace-tab-action"
                    aria-label={t(
                      `关闭 ${sessionLabel(session)}`,
                      `Close ${sessionLabel(session)}`,
                    )}
                    onClick={() => onClose(id)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>}
        </div>
        {active ? (
          <>
            {!focus && <header className="pane-toolbar">
              <div className="agent-identity">
                <Avatar>
                  <AvatarFallback>
                    <AgentLogo agent={active.agent} size={18} />
                  </AvatarFallback>
                </Avatar>
                <div>
                  <strong>{sessionLabel(active)}</strong>
                  <small>
                    <StatusMark status={active.status} />
                    {status(active.status)} · {shortPath(active.cwd)}
                  </small>
                </div>
              </div>
              <div className="pane-toolbar-actions">
                <Badge variant="outline">
                  <GitBranch />
                  {shortPath(active.cwd)}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("停止当前轮次", "Stop current turn")}
                  onClick={() =>
                    void window.prospero.interruptSession(active.id)
                  }
                >
                  <CircleStop />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("切换上下文 Pane", "Toggle context pane")}
                  className="context-pane-toggle"
                  onClick={() => setShowContext((current) => !current)}
                >
                  <PanelRight />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("打开上下文", "Open context")}
                  className="context-sheet-trigger"
                  onClick={() => setContextSheet(true)}
                >
                  <PanelRight />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("会话操作", "Session actions")}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>
                        {t("会话", "Session")}
                      </DropdownMenuLabel>
                      <DropdownMenuItem
                        onClick={() =>
                          void window.prospero.revealPath(active.cwd)
                        }
                      >
                        <FolderOpen />
                        {isMac
                          ? t("在访达中显示", "Reveal in Finder")
                          : t("在资源管理器中打开", "Open in Explorer")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          void window.prospero.openWindowsTerminal(active.cwd)
                        }
                      >
                        <SquareTerminal />
                        {isMac ? t("终端", "Terminal") : "Windows Terminal"}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          void window.prospero.killSession(active.id)
                        }
                      >
                        <X />
                        {t("结束会话", "End session")}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>}
            <div className={cn("pane-grid", !contextVisible && "context-hidden")}>
              <main className="primary-pane">
                <div className="pane-tabbar pane-tabbar-static">
                  <span>
                    {active.kind === "pty"
                      ? t("终端", "Terminal")
                      : t("对话", "Conversation")}
                  </span>
                  <Badge variant="outline">{active.agent}</Badge>
                </div>
                <div className="pane-content">
                  {active.kind === "pty" ? (
                    <TerminalPane
                      session={active}
                      fontFamily={snapshot.settings.terminalFontFamily}
                      fontSize={snapshot.settings.terminalFontSize}
                    />
                  ) : (
                    <ChatPane
                      key={active.id}
                      session={active}
                      onOpenGoal={() => onOpenRun(text(activeDispatch?.["runId"]) || undefined)}
                    />
                  )}
                </div>
              </main>
              {contextVisible && (
                <aside className="secondary-pane">
                  <WorkspaceContextPane session={active} snapshot={snapshot} />
                </aside>
              )}
            </div>
            <Sheet open={contextSheet} onOpenChange={setContextSheet}>
              <SheetContent
                side="right"
                className="w-[min(520px,92vw)] sm:max-w-xl"
              >
                <SheetHeader>
                  <SheetTitle>{t("任务上下文", "Task context")}</SheetTitle>
                  <SheetDescription>
                    {t(
                      "任务、Diff 与执行信息",
                      "Task, diff, and execution details",
                    )}
                  </SheetDescription>
                </SheetHeader>
                <WorkspaceContextPane session={active} snapshot={snapshot} />
              </SheetContent>
            </Sheet>
          </>
        ) : (
          <Empty className="workspace-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderKanban />
              </EmptyMedia>
              <EmptyTitle>
                {t("选择工作上下文", "Choose a work context")}
              </EmptyTitle>
              <EmptyDescription>
                {t(
                  "打开已有会话，或在项目中创建新的 Agent 会话。",
                  "Open an existing session or create a new agent session in a project.",
                )}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex gap-2">
              <Button onClick={() => onNewSession()}>
                <Plus data-icon="inline-start" />
                {t("新建会话", "New session")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void window.prospero.chooseProject()}
              >
                <FolderPlus data-icon="inline-start" />
                {t("添加工作区", "Add workspace")}
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </div>
    </div>
  );
}

function ProjectRenameDialog({
  project,
  currentName,
  open,
  onOpenChange,
}: {
  project: string | undefined;
  currentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setName(currentName);
      setError(undefined);
    }
  }, [open, currentName]);
  const save = async (): Promise<void> => {
    if (!project) return;
    setBusy(true);
    setError(undefined);
    try {
      await window.prospero.renameProject(project, name);
      onOpenChange(false);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("编辑工作区名称", "Edit workspace name")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "只修改 Prospero 中显示的名称，不会重命名磁盘目录。",
              "This changes only the name shown in Prospero, not the folder on disk.",
            )}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>{t("无法保存", "Unable to save")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="workspace-name">
            {t("显示名称", "Display name")}
          </FieldLabel>
          <Input
            id="workspace-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
          <FieldDescription className="truncate" title={project}>
            {project}
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("保存", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SessionRenameDialog({
  session,
  open,
  onOpenChange,
}: {
  session: SessionInfo | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setName(session ? sessionLabel(session) : "");
      setError(undefined);
    }
  }, [open, session]);
  const save = async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    try {
      await window.prospero.renameSession(session.id, name);
      onOpenChange(false);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("编辑会话名称", "Rename session")}</DialogTitle>
          <DialogDescription>
            {t(
              "名称只影响 Prospero 中的显示，不会改变会话内容。",
              "This changes only the name shown in Prospero, not the session content.",
            )}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>{t("无法保存", "Unable to save")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="session-name">
            {t("显示名称", "Display name")}
          </FieldLabel>
          <Input
            id="session-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
          <FieldDescription className="truncate" title={session?.cwd}>
            {session?.cwd}
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("保存", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewSessionDialog({
  snapshot,
  project,
  open,
  onOpenChange,
  onCreated,
}: {
  snapshot: DesktopSnapshot;
  project: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: SessionInfo) => void;
}) {
  const { t, status } = useLocale();
  const [input, setInput] = useState<SessionCreateInput>({
    cwd: project || snapshot.projects[0] || "",
    agent: "codex",
    kind: "structured",
    approvalPolicy: "standard",
    accountId: defaultSessionLaunchAccountId(snapshot.accounts, "codex"),
  });
  const [busy, setBusy] = useState(false);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const [error, setError] = useState<string>();
  const [launchModels, setLaunchModels] = useState<AgentModel[]>([]);
  const [launchModelsLoading, setLaunchModelsLoading] = useState(false);
  const [launchModelsError, setLaunchModelsError] = useState<string>();
  const launchWorkspaces = useMemo(
    () => sessionLaunchWorkspaces(snapshot),
    [snapshot],
  );
  const launchAccounts = useMemo(
    () => sessionLaunchAccounts(snapshot.accounts, input.agent),
    [input.agent, snapshot.accounts],
  );
  const selectedAccount = launchAccounts.find(
    (account) => account.id === input.accountId,
  );
  const selectedWorkspace = launchWorkspaces.find(
    (workspace) => workspace.path === input.cwd,
  );
  const selectedLaunchModel = launchModels.find(
    (model) => model.id === input.model,
  );
  // 对话框打开时刷新一次账号。主进程在 daemon 就绪时已经灌过一份,但 daemon
  // 可能是后启动的,账号也可能在别处刚被创建/删除 —— 这里兜住那些情况。
  useEffect(() => {
    if (!open) return;
    void window.prospero
      .accountAction({ type: "agent.accounts.list", requestId: crypto.randomUUID() })
      .catch(() => undefined);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setInput((current) => {
      const workspacePaths = new Set(
        launchWorkspaces.map((workspace) => workspace.path),
      );
      const cwd = project && workspacePaths.has(project)
        ? project
        : workspacePaths.has(current.cwd)
          ? current.cwd
          : launchWorkspaces[0]?.path ?? "";
      const accounts = sessionLaunchAccounts(snapshot.accounts, current.agent);
      const accountId = accounts.some((account) => account.id === current.accountId)
        ? current.accountId
        : defaultSessionLaunchAccountId(snapshot.accounts, current.agent);
      if (cwd === current.cwd && accountId === current.accountId) return current;
      return { ...current, cwd, accountId, model: undefined, effort: undefined };
    });
  }, [launchWorkspaces, open, project, snapshot.accounts]);
  const supportsStructured = [
    "codex",
    "claude",
    "deepseek",
    "opencode",
  ].includes(input.agent);
  const supportsLaunchModels =
    input.kind === "structured" &&
    (input.agent === "codex" ||
      input.agent === "claude" ||
      input.agent === "deepseek");
  useEffect(() => {
    if (!open || !supportsLaunchModels) {
      setLaunchModels([]);
      setLaunchModelsLoading(false);
      setLaunchModelsError(undefined);
      return;
    }
    let cancelled = false;
    const agent = input.agent as "codex" | "claude" | "deepseek";
    const accountId = input.accountId;
    setLaunchModels([]);
    setLaunchModelsLoading(true);
    setLaunchModelsError(undefined);
    void window.prospero
      .getLaunchModels(agent, accountId)
      .then((catalog) => {
        if (cancelled) return;
        setLaunchModels(catalog.models);
        const model =
          catalog.models.find((candidate) => candidate.id === catalog.currentModel) ??
          catalog.models.find((candidate) => candidate.isDefault) ??
          catalog.models[0];
        setInput((current) => {
          if (
            current.agent !== agent ||
            current.kind !== "structured" ||
            current.accountId !== accountId
          ) return current;
          return {
            ...current,
            model: model?.id,
            effort:
              catalog.currentEffort ??
              model?.defaultEffort ??
              model?.supportedEfforts[0],
          };
        });
      })
      .catch((reason) => {
        if (cancelled) return;
        setLaunchModelsError(displayError(reason));
        setInput((current) =>
          current.agent === agent && current.accountId === accountId
            ? { ...current, model: undefined, effort: undefined }
            : current,
        );
      })
      .finally(() => {
        if (!cancelled) setLaunchModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [input.accountId, input.agent, input.kind, open, supportsLaunchModels]);
  const create = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await window.prospero.createSession(input));
      onOpenChange(false);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };
  const chooseWorkspace = async (): Promise<void> => {
    if (choosingWorkspace) return;
    setChoosingWorkspace(true);
    setError(undefined);
    try {
      const cwd = await window.prospero.chooseProject();
      if (cwd) setInput((current) => ({ ...current, cwd }));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setChoosingWorkspace(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("新建 Agent 会话", "New agent session")}</DialogTitle>
          <DialogDescription>
            {t(
              "选择项目或编排 worktree，并为这次会话指定 Agent、账号与模型。",
              "Choose a project or orchestration worktree, then select the agent, account, and model for this session.",
            )}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>
              {t("无法创建会话", "Unable to create session")}
            </AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="session-project">
              {t("工作区", "Workspace")}
            </FieldLabel>
            <NativeSelect
              id="session-project"
              value={input.cwd}
              onChange={(event) =>
                setInput({ ...input, cwd: event.target.value })
              }
            >
              <NativeSelectOption value="" disabled>
                {t("选择工作区", "Choose workspace")}
              </NativeSelectOption>
              <NativeSelectOptGroup label={t("项目", "Projects")}>
                {launchWorkspaces
                  .filter((workspace) => workspace.kind === "project")
                  .map((workspace) => (
                    <NativeSelectOption value={workspace.path} key={workspace.path}>
                      {workspace.label}
                    </NativeSelectOption>
                  ))}
              </NativeSelectOptGroup>
              {launchWorkspaces.some((workspace) => workspace.kind === "worktree") && (
                <NativeSelectOptGroup label="Worktrees">
                  {launchWorkspaces
                    .filter((workspace) => workspace.kind === "worktree")
                    .map((workspace) => (
                      <NativeSelectOption value={workspace.path} key={workspace.path}>
                        {workspace.label}
                      </NativeSelectOption>
                    ))}
                </NativeSelectOptGroup>
              )}
            </NativeSelect>
            {launchWorkspaces.length === 0 && (
              <Button variant="outline" disabled={choosingWorkspace} onClick={() => void chooseWorkspace()}>
                {choosingWorkspace ? <Spinner data-icon="inline-start" /> : <FolderPlus data-icon="inline-start" />}
                {choosingWorkspace ? t("正在选择…", "Choosing…") : t("添加第一个工作区", "Add your first workspace")}
              </Button>
            )}
            <FieldDescription className="truncate" title={selectedWorkspace?.detail}>
              {launchWorkspaces.length === 0
                ? t("选择一个本地项目后即可在此创建会话。", "Choose a local project to create a session here.")
                : selectedWorkspace?.kind === "worktree"
                ? t("编排 worktree · 会话会直接在隔离分支中运行。", "Orchestration worktree · the session runs directly on the isolated branch.")
                : t("项目根目录与持久上下文。", "Project root and persistent context.")}
            </FieldDescription>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="session-agent">Agent</FieldLabel>
              <NativeSelect
                id="session-agent"
                value={input.agent}
                onChange={(event) => {
                  const agent = event.target
                    .value as SessionCreateInput["agent"];
                  setInput({
                    ...input,
                    agent,
                    accountId: defaultSessionLaunchAccountId(
                      snapshot.accounts,
                      agent,
                    ),
                    model: undefined,
                    effort: undefined,
                    ...(!["codex", "claude", "deepseek", "opencode"].includes(
                      agent,
                    )
                      ? { kind: "pty" as const }
                      : {}),
                  });
                }}
              >
                <NativeSelectOption value="codex">Codex</NativeSelectOption>
                <NativeSelectOption value="claude">Claude</NativeSelectOption>
                <NativeSelectOption value="deepseek">
                  DeepSeek
                </NativeSelectOption>
                <NativeSelectOption value="opencode">
                  OpenCode
                </NativeSelectOption>
                <NativeSelectOption value="grok">Grok</NativeSelectOption>
                <NativeSelectOption value="trae">Trae</NativeSelectOption>
                <NativeSelectOption value="shell">Shell</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="session-kind">
                {t("Pane 类型", "Pane type")}
              </FieldLabel>
              <NativeSelect
                id="session-kind"
                value={input.kind}
                onChange={(event) => {
                  const kind = event.target.value as SessionCreateInput["kind"];
                  setInput({
                    ...input,
                    kind,
                    ...(kind === "pty"
                      ? { model: undefined, effort: undefined }
                      : {}),
                  });
                }}
              >
                <NativeSelectOption
                  value="structured"
                  disabled={!supportsStructured}
                >
                  {t("对话", "Conversation")}
                </NativeSelectOption>
                <NativeSelectOption value="pty">
                  {t("终端", "Terminal")}
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          {(input.agent === "codex" || input.agent === "claude") && (
            <Field>
              <FieldLabel htmlFor="session-account">
                {t("账号环境", "Account")}
              </FieldLabel>
              <NativeSelect
                id="session-account"
                value={input.accountId ?? ""}
                onChange={(event) =>
                  setInput({
                    ...input,
                    accountId: event.target.value || undefined,
                    model: undefined,
                    effort: undefined,
                  })
                }
              >
                {launchAccounts.length === 0 && (
                  <NativeSelectOption value="" disabled>
                    {t("没有可用账号", "No accounts available")}
                  </NativeSelectOption>
                )}
                {launchAccounts.map((account) => (
                  <NativeSelectOption value={account.id} key={account.id}>
                    {account.name}
                    {account.isDefault ? t("（默认）", " (default)") : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                {selectedAccount
                  ? `${status(selectedAccount.status)}${selectedAccount.apiProfile ? ` · API Profile · ${text(selectedAccount.apiProfile["model"])}` : " · CLI"}`
                  : t("在 Agents 与账号页面添加或登录账号。", "Add or sign in to an account from Agents & accounts.")}
              </FieldDescription>
            </Field>
          )}
          {supportsLaunchModels && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="session-model">
                  {t("模型", "Model")}
                </FieldLabel>
                <NativeSelect
                  id="session-model"
                  value={input.model ?? ""}
                  disabled={launchModelsLoading || launchModels.length === 0}
                  onChange={(event) => {
                    const model = launchModels.find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    setInput({
                      ...input,
                      model: model?.id,
                      effort:
                        model?.defaultEffort ?? model?.supportedEfforts[0],
                    });
                  }}
                >
                  <NativeSelectOption value="" disabled>
                    {launchModelsLoading
                      ? t("读取模型中…", "Loading models…")
                      : t("没有可用模型", "No models available")}
                  </NativeSelectOption>
                  {launchModels.map((model) => (
                    <NativeSelectOption value={model.id} key={model.id}>
                      {model.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  {launchModelsError ??
                    selectedLaunchModel?.description ??
                    t("目录随所选账号实时读取。", "Catalog loaded for the selected account.")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="session-effort">
                  {t("推理强度", "Reasoning effort")}
                </FieldLabel>
                <NativeSelect
                  id="session-effort"
                  value={input.effort ?? ""}
                  disabled={!selectedLaunchModel?.supportedEfforts.length}
                  onChange={(event) =>
                    setInput({
                      ...input,
                      effort: event.target.value || undefined,
                    })
                  }
                >
                  <NativeSelectOption value="" disabled>
                    {t("使用模型默认值", "Use model default")}
                  </NativeSelectOption>
                  {selectedLaunchModel?.supportedEfforts.map((effort) => (
                    <NativeSelectOption value={effort} key={effort}>
                      {effort}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  {selectedLaunchModel?.supportedEfforts.length
                    ? t("只显示该模型支持的档位。", "Only efforts supported by this model are shown.")
                    : t("当前模型没有可选档位。", "This model has no selectable effort levels.")}
                </FieldDescription>
              </Field>
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="session-approval">
              {t("权限配置", "Permission profile")}
            </FieldLabel>
            <NativeSelect
              id="session-approval"
              value={input.approvalPolicy}
              onChange={(event) =>
                setInput({
                  ...input,
                  approvalPolicy: event.target
                    .value as SessionCreateInput["approvalPolicy"],
                })
              }
            >
              <NativeSelectOption value="strict">Strict</NativeSelectOption>
              <NativeSelectOption value="standard">Standard</NativeSelectOption>
              <NativeSelectOption value="yolo">YOLO</NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              {t(
                "Standard 会在高风险操作前请求确认。",
                "Standard asks for confirmation before high-risk actions.",
              )}
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button disabled={busy || !input.cwd} onClick={() => void create()}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            {busy ? t("正在创建", "Creating") : t("创建会话", "Create session")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommandDialog({
  open,
  onOpenChange,
  mode,
  snapshot,
  onView,
  onOpenSession,
  onNewSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "command" | "quick";
  snapshot: DesktopSnapshot;
  onView: (view: View) => void;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
}) {
  const { status, t } = useLocale();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const actions = [
    ...primaryNav.map((item) => ({
      key: `view:${item.id}`,
      label: t(`打开${navLabel(item.id, t)}`, `Open ${navLabel(item.id, t)}`),
      detail: t("导航", "Navigation"),
      icon: item.icon,
      run: () => onView(item.id),
    })),
    ...resourceNav.map((item) => ({
      key: `view:${item.id}`,
      label: t(`打开${navLabel(item.id, t)}`, `Open ${navLabel(item.id, t)}`),
      detail: t("导航", "Navigation"),
      icon: item.icon,
      run: () => onView(item.id),
    })),
    {
      key: "view:settings",
      label: t("打开设置", "Open Settings"),
      detail: t("导航", "Navigation"),
      icon: Settings,
      run: () => onView("settings" as const),
    },
    {
      key: "action:new",
      label: t("新建会话", "New Session"),
      detail: t("动作", "Action"),
      icon: Plus,
      run: onNewSession,
    },
  ];
  const quick = [
    ...snapshot.projects.map((project) => ({
      key: `project:${project}`,
      label: project.split(/[\\/]/).filter(Boolean).at(-1) ?? project,
      detail: shortPath(project),
      icon: FolderKanban,
      run: () => onView("workspaces" as const),
    })),
    ...snapshot.daemon.sessions.map((session) => ({
      key: `session:${session.id}`,
      label: sessionLabel(session),
      detail: `${session.agent} · ${shortPath(session.cwd)}`,
      icon: session.kind === "pty" ? SquareTerminal : MessageSquare,
      run: () => onOpenSession(session.id),
    })),
  ];
  const matches = (items: typeof actions | typeof quick) => items.filter((item) =>
    `${item.label} ${item.detail}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const commandSessions = query.trim()
    ? filterSessionsByQuery(
        sortSidebarSessions(
          snapshot.daemon.sessions,
          undefined,
          snapshot.pinnedSessionIds,
          snapshot.unreadSessionIds,
        ),
        query,
        12,
      ).map((session) => ({
        key: `session:${session.id}`,
        label: sessionLabel(session),
        detail: `${session.agent} · ${status(session.status)} · ${shortPath(session.cwd)}`,
        icon: session.kind === "pty" ? SquareTerminal : MessageSquare,
        run: () => onOpenSession(session.id),
      }))
    : [];
  const options = mode === "command"
    ? [...matches(actions), ...commandSessions]
    : matches(quick);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="command-dialog sm:max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>
            {mode === "command"
              ? t("指挥中心", "Command Center")
              : t("快速打开", "Quick Open")}
          </DialogTitle>
          <DialogDescription>
            {mode === "command"
              ? t("执行 Prospero 动作", "Run a Prospero action")
              : t(
                  "快速打开工作区、会话或任务",
                  "Open a workspace, session, or task",
                )}
          </DialogDescription>
        </DialogHeader>
        <InputGroup className="command-search">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              mode === "command"
                ? t("搜索会话或输入命令…", "Search sessions or type a command…")
                : t(
                    "打开工作区、会话或任务…",
                    "Open workspace, session, or task…",
                  )
            }
          />
          <InputGroupAddon align="inline-end">
            <kbd>Esc</kbd>
          </InputGroupAddon>
        </InputGroup>
        <div className="command-results">
          {options.map((item) => (
            <Button
              variant="ghost"
              key={item.key}
              onClick={() => {
                item.run();
                onOpenChange(false);
              }}
            >
              <item.icon data-icon="inline-start" />
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              <ChevronRight data-icon="inline-end" />
            </Button>
          ))}
          {options.length === 0 && (
            <p>{t("没有匹配结果", "No matching results")}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function App({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { t } = useLocale();
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [view, setView] = useState<View>("overview");
  const [hydratedSessions, setHydratedSessions] = useState<SessionInfo[]>([]);
  const [openIds, setOpenIds] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem("prospero.openSessions") || "[]",
      ) as unknown;
      return Array.isArray(stored)
        ? stored.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [activeId, setActiveId] = useState<string>();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionProject, setNewSessionProject] = useState<string>();
  const [runTargetId, setRunTargetId] = useState<string>();
  const [editingProject, setEditingProject] = useState<string>();
  const [editingSession, setEditingSession] = useState<string>();
  const [sidebarPreference] = useState(readSidebarOpenPreference);
  const startsWithCompactSidebar =
    window.innerWidth < COMPACT_SIDEBAR_BREAKPOINT;
  const [sidebarOpen, setSidebarOpen] = useState(
    () => sidebarPreference ?? !startsWithCompactSidebar,
  );
  const sidebarOpenRef = useRef(sidebarOpen);
  const sidebarPreferenceRef = useRef(sidebarPreference);
  const [launcher, setLauncher] = useState<"command" | "quick">();
  const sessionSnapshot = useMemo(() => {
    if (hydratedSessions.length === 0) return snapshot;
    const liveIds = new Set(snapshot.daemon.sessions.map((session) => session.id));
    const historical = hydratedSessions.filter(
      (session) => !liveIds.has(session.id),
    );
    if (historical.length === 0) return snapshot;
    return {
      ...snapshot,
      daemon: {
        ...snapshot.daemon,
        sessions: [...snapshot.daemon.sessions, ...historical],
      },
    };
  }, [hydratedSessions, snapshot]);
  const validOpenIds = useMemo(
    () =>
      openIds.filter((id) =>
        sessionSnapshot.daemon.sessions.some((session) => session.id === id),
      ),
    [openIds, sessionSnapshot.daemon.sessions],
  );
  const activeSession = sessionSnapshot.daemon.sessions.find(
    (session) => session.id === activeId,
  );
  const accountUsageKey = snapshot.accounts
    .map((account) => `${text(account["id"])}:${text(account["status"])}`)
    .join("|");
  useEffect(() => {
    localStorage.setItem("prospero.openSessions", JSON.stringify(validOpenIds));
  }, [validOpenIds]);
  useEffect(() => {
    if (
      activeId &&
      !sessionSnapshot.daemon.sessions.some((session) => session.id === activeId)
    )
      setActiveId(validOpenIds[0]);
  }, [sessionSnapshot.daemon.sessions, activeId, validOpenIds]);
  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.dataset.theme = snapshot.settings.theme;
      document.documentElement.classList.toggle(
        "dark",
        snapshot.settings.theme === "dark" ||
          (snapshot.settings.theme === "system" && systemTheme.matches),
      );
    };
    apply();
    systemTheme.addEventListener("change", apply);
    return () => systemTheme.removeEventListener("change", apply);
  }, [snapshot.settings.theme]);
  useEffect(() => {
    if (snapshot.daemon.running && accountUsageKey) prefetchAccountUsage();
  }, [snapshot.daemon.running, accountUsageKey]);
  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);
  useEffect(() => {
    const adaptSidebar = (): void => {
      if (sidebarPreferenceRef.current !== undefined) return;
      const next = adaptiveSidebarOpen(window.innerWidth, sidebarOpenRef.current);
      if (next === sidebarOpenRef.current) return;
      sidebarOpenRef.current = next;
      setSidebarOpen(next);
    };
    window.addEventListener("resize", adaptSidebar);
    adaptSidebar();
    return () => window.removeEventListener("resize", adaptSidebar);
  }, []);
  const changeSidebarOpen = useCallback((open: boolean): void => {
    sidebarPreferenceRef.current = open;
    sidebarOpenRef.current = open;
    setSidebarOpen(open);
    try {
      localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open));
    } catch {}
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setLauncher("command");
      }
      if (event.key.toLocaleLowerCase() === "p") {
        event.preventDefault();
        setLauncher("quick");
      }
      if (event.key.toLocaleLowerCase() === "n") {
        event.preventDefault();
        setNewSessionProject(undefined);
        setNewSessionOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const openSession = useCallback((id: string, session?: SessionInfo): void => {
    if (session) {
      setHydratedSessions((current) => {
        const next = [
          session,
          ...current.filter((item) => item.id !== session.id),
        ];
        return next.slice(0, HYDRATED_SESSION_CACHE_LIMIT);
      });
    }
    setOpenIds((current) =>
      current.includes(id) ? current : [...current, id],
    );
    setActiveId(id);
    setView("workspaces");
    if (snapshotRef.current.unreadSessionIds.includes(id))
      void window.prospero.setSessionUnread(id, false);
  }, []);
  const openRun = useCallback((runId?: string): void => {
    setRunTargetId(runId);
    setView("runs");
  }, []);
  const closeSession = (id: string): void => {
    const index = validOpenIds.indexOf(id);
    const next = validOpenIds.filter((item) => item !== id);
    setOpenIds(next);
    if (activeId === id) setActiveId(next[Math.max(0, index - 1)]);
  };
  const openNewSession = useCallback((project?: string): void => {
    setNewSessionProject(project);
    setNewSessionOpen(true);
  }, []);
  const toggleArchive = useCallback((id: string): void => {
    void window.prospero.setSessionArchived(
      id,
      !snapshotRef.current.archivedSessionIds.includes(id),
    );
  }, []);
  const togglePin = useCallback((id: string): void => {
    void window.prospero.setSessionPinned(
      id,
      !snapshotRef.current.pinnedSessionIds.includes(id),
    );
  }, []);
  const setUnread = useCallback((id: string, unread: boolean): void => {
    void window.prospero.setSessionUnread(id, unread);
  }, []);
  // 会话视图默认专注:顶栏、标签页条、会话工具条三条都收起,窗口只剩会话本身。
  // 它们说的都是侧栏已经说过的事(会话名、路径、切换),而会话内容才是这个页面的
  // 主体。⇧⌘F 随时调回来,选择会被记住。
  const [focus, setFocus] = useState(() => {
    try {
      const stored = localStorage.getItem("prospero.focusTerminal");
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("prospero.focusTerminal", String(focus));
    } catch {
      // Focus mode still works for this renderer lifetime.
    }
  }, [focus]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "f" || !event.shiftKey) return;
      if (!(isMac ? event.metaKey : event.ctrlKey)) return;
      event.preventDefault();
      setFocus((current) => !current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const duplicateSession = useCallback((session: SessionInfo): void => {
    void (async () => {
      const supportedAgents: SessionCreateInput["agent"][] = [
        "codex",
        "claude",
        "deepseek",
        "opencode",
        "grok",
        "trae",
        "shell",
      ];
      const agent = supportedAgents.includes(
        session.agent as SessionCreateInput["agent"],
      )
        ? (session.agent as SessionCreateInput["agent"])
        : "shell";
      const project =
        projectForSession(snapshotRef.current.projects, session) ??
        snapshotRef.current.projects[0];
      if (!project) return;
      const approvalPolicy =
        session.approvalPolicy === "strict" || session.approvalPolicy === "yolo"
          ? session.approvalPolicy
          : "standard";
      const kind =
        session.kind === "structured" &&
        ["codex", "claude", "deepseek", "opencode"].includes(agent)
          ? "structured"
          : "pty";
      const created = await window.prospero.createSession({
        cwd: project,
        agent,
        kind,
        approvalPolicy,
      });
      await window.prospero.renameSession(
        created.id,
        t(`${sessionLabel(session)} 副本`, `${sessionLabel(session)} Copy`),
      );
      openSession(created.id);
    })().catch((reason) =>
      console.error("Unable to duplicate session", reason),
    );
  }, [openSession, t]);
  const page = getViewCopy(view, t);
  return (
    <SidebarProvider
      // 专注模式只收起顶栏/标签页条/会话工具条,不碰侧栏 —— 侧栏是导航和会话
      // 操作(停止本轮、结束会话)的唯一入口,把它一起锁上等于把这些动作也锁没了。
      open={sidebarOpen}
      onOpenChange={changeSidebarOpen}
      style={
        {
          "--sidebar-width": "15rem",
          "--sidebar-width-icon": "3.5rem",
        } as React.CSSProperties
      }
      className="prospero-shell"
    >
      <ShellSidebar
        snapshot={sessionSnapshot}
        view={view}
        activeId={activeId}
        onView={setView}
        onOpenSession={openSession}
        onNewSession={openNewSession}
        onTogglePin={togglePin}
        onToggleArchive={toggleArchive}
        onRenameProject={setEditingProject}
        onRenameSession={setEditingSession}
        onDuplicateSession={duplicateSession}
        onSetUnread={setUnread}
      />
      <SidebarInset className="prospero-main">
        <header
          className={cn(
            "desktop-topbar",
            focus && view === "workspaces" && "terminal-focus-topbar",
          )}
        >
          <div className="topbar-context">
            <SidebarTrigger />
            <div>
              <strong>
                {activeSession && view === "workspaces"
                  ? sessionLabel(activeSession)
                  : page.title}
              </strong>
              <span>
                {activeSession && view === "workspaces"
                  ? shortPath(activeSession.cwd)
                  : page.description}
              </span>
            </div>
          </div>
          <div className="topbar-actions">
            <Button
              variant="outline"
              className="search-trigger"
              onClick={() => setLauncher("command")}
            >
              <Search data-icon="inline-start" />
              <span>{t("搜索或运行命令", "Search or run a command")}</span>
              <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
            </Button>
            <Button onClick={() => openNewSession()}>
              <Plus data-icon="inline-start" />
              {t("新建会话", "New session")}
            </Button>
          </div>
        </header>
        <div className="main-viewport">
          <Suspense
            fallback={
              <div className="boot-screen">
                <Spinner />
                <span>Loading workspace…</span>
              </div>
            }
          >
            {view === "overview" ? (
              <OverviewPane
                snapshot={sessionSnapshot}
                onOpenSession={openSession}
                onOpenInbox={() => setView("inbox")}
                onOpenRuns={() => openRun()}
                onOpenWorkspaces={() => setView("workspaces")}
                onNewSession={openNewSession}
              />
            ) : view === "inbox" ? (
              <InboxPane
                snapshot={sessionSnapshot}
                onOpenSession={openSession}
                onOpenRuns={() => openRun()}
              />
            ) : view === "mobile" ? (
              <DevicesPane snapshot={sessionSnapshot} />
            ) : view === "workspaces" ? (
              <WorkspacePane
                focus={focus}
                snapshot={sessionSnapshot}
                activeId={activeId}
                openIds={validOpenIds}
                onActivate={(id) => openSession(id)}
                onClose={closeSession}
                onNewSession={openNewSession}
                onOpenRun={openRun}
                onTogglePin={togglePin}
              />
            ) : view === "runs" ? (
              <OrchestrationPane
                snapshot={sessionSnapshot}
                onOpenSession={openSession}
                onNewSession={openNewSession}
                initialRunId={runTargetId}
              />
            ) : view === "providers" ? (
              <AccountsPane snapshot={sessionSnapshot} onOpenSession={openSession} />
            ) : view === "skills" ? (
              <SkillsPane snapshot={sessionSnapshot} />
            ) : view === "diagnostics" ? (
              <LogsPane snapshot={sessionSnapshot} />
            ) : (
              <SettingsPane snapshot={sessionSnapshot} />
            )}
          </Suspense>
        </div>
      </SidebarInset>
      <NewSessionDialog
        snapshot={sessionSnapshot}
        project={newSessionProject}
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        onCreated={(session) => openSession(session.id)}
      />
      <ProjectRenameDialog
        project={editingProject}
        currentName={
          editingProject
            ? snapshot.projectAliases[editingProject.toLocaleLowerCase()] ||
              editingProject.split(/[\\/]/).filter(Boolean).at(-1) ||
              editingProject
            : ""
        }
        open={Boolean(editingProject)}
        onOpenChange={(open) => {
          if (!open) setEditingProject(undefined);
        }}
      />
      <SessionRenameDialog
        session={sessionSnapshot.daemon.sessions.find(
          (session) => session.id === editingSession,
        )}
        open={Boolean(editingSession)}
        onOpenChange={(open) => {
          if (!open) setEditingSession(undefined);
        }}
      />
      <CommandDialog
        open={Boolean(launcher)}
        onOpenChange={(open) => {
          if (!open) setLauncher(undefined);
        }}
        mode={launcher ?? "command"}
        snapshot={sessionSnapshot}
        onView={setView}
        onOpenSession={openSession}
        onNewSession={() => openNewSession()}
      />
    </SidebarProvider>
  );
}
