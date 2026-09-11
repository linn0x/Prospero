import { WindowsTitlebar } from "./app-shell/WindowsTitlebar";
import { notify } from "./notifications/notifications";
import { useNavigationHistory } from "./app-shell/use-navigation-history";
import { ProjectToolsProvider } from "./project-tools/ProjectToolsHost";
import {
  Fragment,
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Activity,
  Monitor,
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
  Folder,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Mail,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Smartphone,
  SquareTerminal,
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
  RemoteWorkspace,
} from "../../shared/types";
import { AgentLogo } from "./AgentLogo";
import {
  getCachedAccountUsage,
  loadAccountUsage,
  prefetchAccountUsage,
} from "./account-usage-cache";
import { reportError, shortPath, text } from "./state";
import { installLiquidGlass } from "./liquid-glass";
import { useLocale, type Language } from "./locale";
import {
  EXPANDED_PROJECTS_STORAGE_KEY,
  SIDEBAR_COLLAPSE_WIDTH,
  SIDEBAR_EXPAND_WIDTH,
  SIDEBAR_SESSION_PREVIEW_LIMIT,
  adaptiveSidebarOpen,
  filterSessionsByQuery,
  matchesDesktopShortcut,
  matchesFocusShortcut,
  mostRelevantProject,
  nextSidebarSessionLimit,
  parseExpandedProjects,
  projectForSession,
  restoredSessionIds,
  sessionRestoreRetryDelay,
  sortProjectsByRecentActivity,
  sortSidebarSessions,
  upsertHydratedSession,
  validOpenSessionIds,
} from "./workspace-sidebar-state";
import {
  groupManagedWorkspaces,
  managedWorkspaceActivity,
  managedWorkspaceParent,
  type ManagedWorkspaceGroup,
} from "./managed-workspaces";
import {
  defaultSessionLaunchAccountId,
  duplicateSessionAccountState,
  sessionLaunchAccounts,
  sessionLaunchRequiresStructured,
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./styles.css";
import "./workspace/workspace.css";
import { WorkspacePane } from "./workspace/WorkspacePane";
import { WorkspaceTabs } from "./app-shell/WorkspaceTabs";
import { WorkspacePicker } from "./remote-workspaces/AddWorkspaceDialog";
import { RemoteWorkspaceList } from "./remote-workspaces/RemoteWorkspaceList";
import { useRemoteWorkspaces } from "./remote-workspaces/use-remote-workspaces";
import { SourceSelector } from "./model-sources/SourceSelector";
import { useModelSources, runModelSourceAction } from "./model-sources/use-model-sources";
import { rememberSourceSelection, rememberedSourceSelection, selectedSourceRoute, sourceRouteAgent, type SourceSelection } from "./model-sources/source-state";
import { sessionLabel, SessionAgentIcon, StatusMark } from "./workspace/session-presentation";
import { useSessionUnread } from "./workspace/use-session-unread";

/** Host platform is static and controls native menu labels and shortcuts. */
const isMac = window.prospero.platform === "darwin";
const SIDEBAR_OPEN_STORAGE_KEY = "prospero.sidebarOpen";
const SIDEBAR_PROJECT_PREVIEW_LIMIT = 24;
const SIDEBAR_PROJECT_PAGE_SIZE = 24;
const SIDEBAR_PINNED_PREVIEW_LIMIT = 24;
const SIDEBAR_SEARCH_PAGE_SIZE = 60;
const SIDEBAR_SEARCH_VISIBLE_LIMIT = 120;
const HYDRATED_SESSION_CACHE_LIMIT = 120;
const INBOX_TASK_PAGE_SIZE = 50;
const COMMAND_RESULT_LIMIT = 60;
const SEARCH_QUERY_MAX_LENGTH = 500;
const OPEN_SESSIONS_STORAGE_KEY = "prospero.openSessions";
const ACTIVE_SESSION_STORAGE_KEY = "prospero.activeSession";
const ACTIVE_VIEW_STORAGE_KEY = "prospero.activeView";
const FOCUS_STORAGE_KEY = "prospero.workspaceFocus";

function readSidebarOpenPreference(): boolean | undefined {
  try {
    const value = localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    return value === "true" ? true : value === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

const OrchestrationPane = lazy(() =>
  import("./OrchestrationPane").then((module) => ({
    default: module.OrchestrationPane,
  })),
);
const AccountsPane = lazy(() =>
  import("./accounts/AccountsPane").then((module) => ({
    default: module.AccountsPane,
  })),
);
const RemoteHostsPane = lazy(() => import("./RemoteHostsPane"));
const RemoteWorkspacePane = lazy(() => import("./remote-workspaces/RemoteWorkspacePane").then(module => ({ default: module.RemoteWorkspacePane })));
const DevicesPane = lazy(() =>
  import("./ManagementPanes").then((module) => ({
    default: module.DevicesPane,
  })),
);
const LogsPane = lazy(() =>
  import("./ManagementPanes").then((module) => ({ default: module.LogsPane })),
);
const SettingsPane = lazy(() =>
  import("./settings/SettingsPane").then((module) => ({
    default: module.SettingsPane,
  })),
);
const SkillsPane = lazy(() =>
  import("./SkillsPane").then((module) => ({ default: module.SkillsPane })),
);

type View =
  | "overview"
  | "inbox"
  | "remote"
  | "mobile"
  | "workspaces"
  | "runs"
  | "providers"
  | "skills"
  | "diagnostics"
  | "settings";
const views = new Set<View>([
  "overview",
  "inbox",
  "remote",
  "mobile",
  "workspaces",
  "runs",
  "providers",
  "skills",
  "diagnostics",
  "settings",
]);

function readStoredView(): View {
  try {
    const value = localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY) as View | null;
    if (["files", "search", "git"].includes(value ?? "")) return "workspaces";
    return value && views.has(value) ? value : "overview";
  } catch {
    return "overview";
  }
}

function readStoredActiveSession(): string | undefined {
  try {
    return localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}
type NavItem = { id: View; label: string; icon: ComponentType };

const primaryNav: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "inbox", label: "Inbox", icon: Mail },
  { id: "remote", label: "Remote computers", icon: Monitor },
  { id: "mobile", label: "Mobile", icon: Smartphone },
  { id: "workspaces", label: "Workspaces", icon: FolderKanban },
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
      remote: {
        title: t("远程电脑", "Remote computers"),
        description: t("通过局域网或中继控制其他电脑的 Shell", "Control another computer’s Shell over LAN or relay"),
      },
      mobile: {
        title: t("移动端", "Mobile"),
        description: t("配对手机并管理远程访问权限", "Pair phones and manage remote access permissions"),
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
        title: t("Agent 与账号", "Agents & accounts"),
        description: t(
          "Agent、模型、账号与额度",
          "Agents, models, accounts, and usage",
        ),
      },
      skills: {
        title: t("技能", "Skills"),
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
  active: boolean;
  unread: boolean;
};

/**
 * Pinned rows remain independently mounted from the workspace preview.  This
 * keeps a pinned session reachable even when its project has hundreds of
 * historical sessions that are no longer part of the live snapshot.
 */
const PinnedSessionRow = memo(function PinnedSessionRow({
  session,
  active,
  unread,
  onOpenSession,
  onTogglePin,
}: PinnedSessionRowProps) {
  const { t } = useLocale();
  return (
    <SidebarMenuItem className="workspace-session-item workspace-pinned-item">
      <SidebarMenuButton
        className="workspace-session-link"
        isActive={active}
        aria-current={active ? "page" : undefined}
        tooltip={sessionLabel(session)}
        onClick={() => onOpenSession(session.id, session)}
      >
        <SessionAgentIcon agent={session.agent} />
        <span className="workspace-session-copy"><strong>{sessionLabel(session)}</strong></span>
        <StatusMark status={session.status} unread={unread} pendingPermissions={session.pendingPermissions} pendingQuestions={session.pendingQuestions} />
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
  const { t } = useLocale();
  return (
    <SidebarMenuSubItem className="workspace-session-item">
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuSubButton
              render={<button type="button" />}
              className="workspace-session-link"
              isActive={active}
              aria-current={active ? "page" : undefined}
              title={sessionLabel(session)}
              onClick={() => onOpenSession(session.id, session)}
            />
          }
        >
          <SessionAgentIcon agent={session.agent} />
          <span className="workspace-session-copy">
            <strong>{sessionLabel(session)}</strong>
          </span>
          <StatusMark status={session.status} unread={unread} pendingPermissions={session.pendingPermissions} pendingQuestions={session.pendingQuestions} />
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
            <ContextMenuItem
              onClick={() => void window.prospero.revealPath(session.cwd)}
            >
              <FolderOpen />
              {isMac
                ? t("在访达中显示", "Reveal in Finder")
                : t("在资源管理器中打开", "Open in Explorer")}
            </ContextMenuItem>
          </ContextMenuGroup>
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

  if (
    "active" in previous &&
    "active" in next &&
    previous.active !== next.active
  )
    return false;

  if (previous.unread !== next.unread) return false;
  if ("pinned" in previous && "pinned" in next) {
    if (
      previous.pinned !== next.pinned ||
      previous.archived !== next.archived
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
        previous.onSetUnread === next.onSetUnread &&
        previous.onToggleArchive === next.onToggleArchive))
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

function newestRecord(records: JsonObject[]): JsonObject | undefined {
  return records.reduce<JsonObject | undefined>((latest, record) => {
    const value = record["updatedAt"] ?? record["createdAt"];
    const latestValue = latest?.["updatedAt"] ?? latest?.["createdAt"];
    const time = typeof value === "number" ? value : Date.parse(String(value ?? ""));
    const latestTime = typeof latestValue === "number" ? latestValue : Date.parse(String(latestValue ?? ""));
    return !latest || (Number.isFinite(time) ? time : 0) > (Number.isFinite(latestTime) ? latestTime : 0) ? record : latest;
  }, undefined);
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
                <span className="truncate text-xs text-muted-foreground">
                  {status(sessions[0]?.status ?? "running")} · {remaining !== undefined
                    ? t(`${String(remaining)}% 可用`, `${String(remaining)}% available`)
                    : loading
                      ? t("读取额度中…", "Loading usage…")
                      : accountUsage?.reason ?? t("额度不可用", "Usage unavailable")}
                </span>
                {remaining !== undefined && (
                  <Progress
                    value={remaining}
                    className="h-1"
                    aria-label={t(
                      `${agent} 剩余额度 ${String(remaining)}%`,
                      `${agent} usage remaining: ${String(remaining)}%`,
                    )}
                  />
                )}
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
  onAddWorkspace,
  remoteWorkspaces,
  activeRemoteId,
  onOpenRemote,
  onUpdateRemote,
  onForgetRemote,
  focus,
  onExitFocus,
  remoteError,
  remoteLoading,
  onRetryRemote,
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
  onAddWorkspace: () => void;
  remoteWorkspaces: RemoteWorkspace[];
  activeRemoteId: string | undefined;
  onOpenRemote: (workspace: RemoteWorkspace, newSession?: boolean) => void;
  onUpdateRemote: (workspace: RemoteWorkspace) => void;
  onForgetRemote: (id: string) => Promise<void>;
  focus: boolean;
  onExitFocus: () => void;
  remoteError: string | undefined;
  remoteLoading: boolean;
  onRetryRemote: () => void;
}) {
  const { language, t, status } = useLocale();
  const { open, isMobile, setOpenMobile } = useSidebar();
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
    onAddWorkspace();
    closeMobileSidebar();
  }, [closeMobileSidebar, onAddWorkspace]);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const managedLayout = useMemo(
    () => groupManagedWorkspaces(snapshot.projects, snapshot.orchestration),
    [snapshot.projects, snapshot.orchestration],
  );
  const [expandedTaskGroups, setExpandedTaskGroups] = useState<Set<string>>(() => new Set());
  const [sessionQuery, setSessionQuery] = useState("");
  const deferredSessionQuery = useDeferredValue(sessionQuery.trim());
  const [searchPage, setSearchPage] = useState<SessionPage>();
  const [searchPageQuery, setSearchPageQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const searchGeneration = useRef(0);
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
        managedLayout.projects,
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
        (project) => !knownProjects.current.has(project) && !managedLayout.byPath.has(project),
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
    managedLayout,
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
  const selectedSession = snapshot.daemon.sessions.find((session) => session.id === activeId);
  const activeSessionProject = selectedSession ? projectForSession(snapshot.projects, selectedSession) : undefined;
  const activeTaskGroup = activeSessionProject ? managedLayout.byPath.get(activeSessionProject)?.group : undefined;
  const activeTaskGroupKey = activeTaskGroup?.key;
  const activeTaskParent = activeTaskGroup?.project;
  useEffect(() => {
    if (!activeTaskGroupKey) return;
    setExpandedTaskGroups((current) => current.has(activeTaskGroupKey) ? current : new Set([...current, activeTaskGroupKey]));
    if (activeTaskParent) setExpandedProjects((current) => current.has(activeTaskParent) ? current : new Set([...current, activeTaskParent]));
  }, [activeId, activeTaskGroupKey, activeTaskParent]);
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
  }, [pinnedSessionKey, pinnedSessionRequestIds, snapshot.daemon.metadataRevision]);
  useEffect(() => {
    const generation = ++searchGeneration.current;
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
        if (!cancelled && searchGeneration.current === generation) {
          setSearchPage(page);
          setSearchPageQuery(deferredSessionQuery);
        }
      })
      .catch(() => {
        if (!cancelled && searchGeneration.current === generation) {
          setSearchPage(undefined);
          setSearchPageQuery(deferredSessionQuery);
        }
      })
      .finally(() => {
        if (!cancelled && searchGeneration.current === generation) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deferredSessionQuery, snapshot.daemon.metadataRevision]);
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
    const latestByProject = new Map<string, number>();
    for (const [project, sessions] of sessionsByProject) {
      const parent = managedWorkspaceParent(managedLayout, project);
      if (!parent) continue;
      const latest = sessions.reduce((value, session) => Math.max(value, session.createdAt ?? 0), 0);
      latestByProject.set(parent, Math.max(latestByProject.get(parent) ?? 0, latest));
    }
    const pinnedParents = new Set(snapshot.pinnedProjectPaths.map((project) => managedWorkspaceParent(managedLayout, project)?.toLocaleLowerCase()));
    return [...managedLayout.projects].sort((left, right) => {
      const leftPinned = pinnedParents.has(left.toLocaleLowerCase());
      const rightPinned = pinnedParents.has(right.toLocaleLowerCase());
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (snapshot.settings.workspaceSort === "name")
        return projectName(left).localeCompare(
          projectName(right),
          language === "zh" ? "zh-CN" : "en-US",
          { sensitivity: "base" },
        );
      return (
        (latestByProject.get(right) ?? 0) - (latestByProject.get(left) ?? 0) ||
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
    managedLayout,
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
      if (project) {
        const parent = managedWorkspaceParent(managedLayout, project);
        if (parent) projects.add(parent);
      }
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
    managedLayout,
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
    const generation = searchGeneration.current;
    const query = deferredSessionQuery;
    const cursor = searchPage.nextCursor;
    setSearchLimit((current) =>
      Math.min(SIDEBAR_SEARCH_VISIBLE_LIMIT, current + SIDEBAR_SEARCH_PAGE_SIZE),
    );
    void window.prospero
      .listSessions({
        query,
        cursor,
        limit: SIDEBAR_SEARCH_PAGE_SIZE,
      })
      .then((next) => {
        if (searchGeneration.current !== generation) return;
        setSearchPage((current) =>
          current && searchPageQuery === query
            ? { ...next, items: [...current.items, ...next.items] }
            : current,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (searchGeneration.current === generation) setSearchLoading(false);
      });
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
          data-liquid-glass="nav"
          isActive={view === item.id}
          aria-current={view === item.id ? "page" : undefined}
          tooltip={navLabel(item.id, t)}
          onClick={() => selectView(item.id)}
        >
          <item.icon />
          <span>{navLabel(item.id, t)}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ));
  const renderProject = (project: string): ReactNode => {
    const managedWorkspace = managedLayout.byPath.get(project)?.workspace;
    const childGroups = managedLayout.groups.filter((group) => group.project === project);
    const sessions = sessionsByProject.get(project) ?? [];
    const projectSessionCount = sessions.length + childGroups.reduce((total, group) => total + group.workspaces.reduce(
      (count, workspace) => count + (sessionsByProject.get(workspace.path)?.length ?? 0), 0,
    ), 0);
    // 归档的会话从主列表收起。搜索时不过滤 —— 明确搜某个东西的人
    // 是想找到它,而不是被"你把它归档过"挡回来。
    const matchingSessions = filterSessionsByQuery(
      normalizedSessionQuery
        ? sessions
        : sessions.filter(
            (item) => item.id === activeId || !snapshot.archivedSessionIds.includes(item.id),
          ),
      normalizedSessionQuery,
    );
    if (normalizedSessionQuery && matchingSessions.length === 0)
      return null;
    const fallback =
      project.split(/[\\/]/).filter(Boolean).at(-1) ?? project;
    const name =
      snapshot.projectAliases[project.toLocaleLowerCase()] ||
      managedWorkspace?.taskTitle ||
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
                tooltip={`${name}\n${project}`}
                title={project}
              />
            }
          >
            {projectOpen ? <FolderOpen /> : <Folder />}
            <span className="truncate">{name}</span>
            {projectPinned && (
              <Pin className="workspace-project-pinned" />
            )}
            {managedWorkspace?.cleaned && (
              <span className="workspace-task-cleaned">{t("已清理", "Cleaned")}</span>
            )}
            <span className="workspace-session-count">
              {normalizedSessionQuery
                ? `${String(matchingSessions.length)}/${String(sessions.length)}`
                    : projectSessionCount}
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
            {childGroups.map(renderTaskGroup)}
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    );
  };

  const renderTaskGroup = (group: ManagedWorkspaceGroup): ReactNode => {
    const activity = managedWorkspaceActivity(group.workspaces.flatMap((workspace) => sessionsByProject.get(workspace.path) ?? []));
    const repoName = group.repo.split(/[\\/]/).filter(Boolean).at(-1) ?? group.repo;
    const label = group.project ? t("任务工作区", "Task workspaces") : t(`任务工作区 · ${repoName}`, `Task workspaces · ${repoName}`);
    const open = expandedTaskGroups.has(group.key);
    return (
      <Collapsible
        key={group.key}
        open={open}
        onOpenChange={(expanded) => setExpandedTaskGroups((current) => {
          const next = new Set(current);
          if (expanded) next.add(group.key); else next.delete(group.key);
          return next;
        })}
        className="workspace-task-group"
      >
        <SidebarMenuItem>
          <CollapsibleTrigger render={<SidebarMenuButton className="workspace-task-group-button" tooltip={group.repo} />}>
            <ChevronRight className={cn("workspace-task-chevron", open && "is-open")} />
            <span className="workspace-task-group-copy">
              <span className="truncate">{label} · {group.workspaces.length}</span>
              <span className={cn("workspace-task-summary", activity.pending > 0 && "has-pending")}>
                {t(`${activity.running} 运行 · ${activity.pending} 待处理`, `${activity.running} running · ${activity.pending} pending`)}
              </span>
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub className="workspace-task-children">
              {group.workspaces.map((workspace) => renderProject(workspace.path))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    );
  };

  return (
    <Sidebar
      collapsible="icon"
      className="prospero-sidebar"
      mobileTitle={t("侧边栏", "Sidebar")}
      mobileDescription={t("主导航、工作区与会话", "Main navigation, workspaces, and sessions")}
    >
      {(isMac || focus) && <SidebarHeader className="sidebar-shell-header">
        {isMac && <>
        <Button className="sidebar-new-session" variant="ghost" size="icon-sm" aria-label={t("新建会话", "New session")} title={t("新建会话", "New session")} onClick={() => newSession()}><Plus /></Button>
        <SidebarTrigger
          className="sidebar-header-toggle"
          aria-label={open || isMobile ? t("收起侧边栏", "Collapse sidebar") : t("展开侧边栏", "Expand sidebar")}
          title={open || isMobile ? t("收起侧边栏", "Collapse sidebar") : t("展开侧边栏", "Expand sidebar")}
        />
        </>}
        {focus && <Button className="sidebar-exit-focus" variant="ghost" size="icon-sm" aria-label={t("退出专注", "Exit focus")} title={t("退出专注", "Exit focus")} onClick={onExitFocus}><Minimize2 /></Button>}
      </SidebarHeader>}
      <SidebarContent className="sidebar-content-shell">
        <nav className="sidebar-nav-fixed" aria-label={t("主导航", "Main navigation")}>
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
        </nav>
        <div className="sidebar-workspace-scroll" role="region" aria-label={t("工作区与会话", "Workspaces and sessions")}>
        {snapshot.pinnedSessionIds.length > 0 && <>
          <SidebarSeparator className="sidebar-detail-section" />
          <SidebarGroup className="sidebar-detail-section">
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
                    active={view === "workspaces" && activeId === session.id}
                    unread={snapshot.unreadSessionIds.includes(session.id)}
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
        <SidebarSeparator className="sidebar-detail-section" />
        <Collapsible
          open={workspaceOpen}
          onOpenChange={setWorkspaceOpen}
          className="group/workspaces sidebar-detail-section"
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
                    onClick={() => {
                      setExpandedProjects(new Set(snapshot.projects));
                      setExpandedTaskGroups(new Set(managedLayout.groups.map((group) => group.key)));
                    }}
                  >
                    <FolderOpen />
                    {t("全部展开", "Expand all")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setExpandedProjects(new Set());
                      setExpandedTaskGroups(new Set());
                    }}
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
                maxLength={SEARCH_QUERY_MAX_LENGTH}
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
                        {visibleSearchSessions.map((session) => {
                          const project = projectForSession(snapshot.projects, session);
                          const managed = project ? managedLayout.byPath.get(project) : undefined;
                          const parent = managed?.group.project ?? managed?.group.repo;
                          const parentName = parent ? snapshot.projectAliases[parent.toLocaleLowerCase()] || parent.split(/[\\/]/).filter(Boolean).at(-1) || parent : undefined;
                          return <Fragment key={session.id}>
                          {managed && (
                            <SidebarMenuSubItem className="workspace-task-search-parent" title={`${parent}\n${project}`}>
                              <span className="truncate">{parentName} / {managed.workspace.taskTitle ?? t("任务工作区", "Task workspace")}</span>
                            </SidebarMenuSubItem>
                          )}
                          <WorkspaceSessionRow
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
                          </Fragment>;
                        })}
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
                  <>
                    {visibleProjects.map(renderProject)}
                    {managedLayout.groups.filter((group) => !group.project).map(renderTaskGroup)}
                  </>
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
                  <RemoteWorkspaceList workspaces={remoteWorkspaces} activeId={activeRemoteId} query={normalizedSessionQuery} sort={snapshot.settings.workspaceSort} onOpen={(workspace, newShell) => { onOpenRemote(workspace, newShell); closeMobileSidebar(); }} onUpdate={onUpdateRemote} onForget={onForgetRemote} />
                  {remoteError && <SidebarMenuItem className="remote-workspace-load-error"><p role="alert">{remoteError}</p><Button size="sm" variant="ghost" disabled={remoteLoading} onClick={onRetryRemote}>{remoteLoading ? <Spinner /> : <RefreshCw />}{t("重试远程工作区", "Retry remote workspaces")}</Button></SidebarMenuItem>}
                  {snapshot.projects.length === 0 && remoteWorkspaces.length === 0 && (
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
        </div>
      </SidebarContent>
      <SidebarFooter className="sidebar-shell-footer">
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
                <span className="sidebar-daemon-indicator" aria-hidden="true">
                  {snapshot.daemon.starting ? (
                    <LoaderCircle className="daemon-spinner" />
                  ) : (
                    <span className={cn("sidebar-daemon-dot", snapshot.daemon.running ? "online" : "offline")} />
                  )}
                </span>
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
              aria-current={view === "settings" ? "page" : undefined}
              tooltip={t("设置", "Settings")}
              onClick={() => selectView("settings")}
            >
              <Settings />
              <span>{t("设置", "Settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail
        aria-label={t("调整侧栏宽度", "Resize sidebar")}
        title={t("拖动调整宽度 · 双击恢复默认", "Drag to resize · Double-click to reset")}
      />
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
      <span className={cn("attention-icon", `tone-${status}`)} aria-hidden="true">
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {action ?? <ChevronRight className="text-muted-foreground" aria-hidden="true" />}
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
  onAddWorkspace,
}: {
  snapshot: DesktopSnapshot;
  onOpenSession: (id: string) => void;
  onOpenInbox: () => void;
  onOpenRuns: (runId?: string, taskId?: string) => void;
  onOpenWorkspaces: () => void;
  onNewSession: (project: string) => void;
  onAddWorkspace: () => void;
}) {
  const { t, status } = useLocale();
  const activeSessions = snapshot.daemon.sessions.filter((session) =>
    ["running", "starting", "waiting_approval", "waiting_input"].includes(
      session.status,
    ),
  );
  const activeRunIds = new Set(
    snapshot.orchestration.runs
      .filter((run) => text(run["status"]) === "active")
      .map((run) => text(run["id"])),
  );
  const failedTasks = snapshot.orchestration.tasks.filter((task) =>
    activeRunIds.has(text(task["runId"])) &&
    ["failed", "blocked"].includes(text(task["status"])),
  ).sort((left, right) => (Number(right["updatedAt"]) || 0) - (Number(left["updatedAt"]) || 0));
  const pendingGates = snapshot.orchestration.gates.filter(
    (gate) =>
      activeRunIds.has(text(gate["runId"])) &&
      text(gate["status"]) === "pending",
  ).sort((left, right) => (Number(right["createdAt"]) || 0) - (Number(left["createdAt"]) || 0));
  const activeRun = newestRecord(
    snapshot.orchestration.runs.filter(
      (run) => text(run["status"]) === "active",
    ),
  ) ?? newestRecord(snapshot.orchestration.runs);
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
          <Card className="attention-card-shell" data-liquid-glass="panel" role="region" aria-labelledby="overview-attention-title">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle id="overview-attention-title" role="heading" aria-level={2}>
                    {t("需要你处理", "Needs your attention")}
                  </CardTitle>
                  <CardDescription>
                    {t(
                      "先处理会阻塞 Agent 的事项",
                      "Resolve anything blocking an agent first",
                    )}
                  </CardDescription>
                </div>
                <Badge
                  variant={attentionCount ? "secondary" : "outline"}
                  aria-label={t(
                    `${String(attentionCount)} 项需要处理`,
                    `${String(attentionCount)} items need attention`,
                  )}
                >
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
                    <Button variant="outline" size="sm" onClick={() => onOpenRuns(text(gate["runId"]), text(gate["taskId"]) || undefined)}>
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
                    <Button variant="outline" size="sm" onClick={() => onOpenRuns(text(task["runId"]), text(task["id"]))}>
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
            <CardFooter>
              <Button variant="ghost" size="sm" onClick={onOpenInbox}>
                {t("打开收件箱", "Open inbox")}{" "}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardFooter>
          </Card>
          <Card className="run-focus-card" data-liquid-glass="panel" role="region" aria-labelledby="overview-run-title">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <Badge variant="outline">{t("当前运行", "CURRENT RUN")}</Badge>
                {activeRun && (
                  <Badge variant="secondary">
                    {status(text(activeRun["status"]))}
                  </Badge>
                )}
              </div>
              <CardTitle id="overview-run-title" role="heading" aria-level={2}>
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
                <Progress
                  value={progress}
                  aria-label={t(
                    `运行进度 ${String(progress)}%`,
                    `Run progress: ${String(progress)}%`,
                  )}
                />
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
              <Button variant="ghost" size="sm" onClick={() => onOpenRuns(runId || undefined)}>
                {t("打开运行", "Open run")}{" "}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardFooter>
          </Card>
          <Card className="active-work-card" data-liquid-glass="panel" role="region" aria-labelledby="overview-active-title">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle id="overview-active-title" role="heading" aria-level={2}>{t("活跃工作", "Active work")}</CardTitle>
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
                  type="button"
                  key={session.id}
                  title={`${sessionLabel(session)} · ${shortPath(session.cwd)}`}
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
                  <ChevronRight aria-hidden="true" />
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
            <CardFooter>
              <Button variant="ghost" size="sm" onClick={onOpenWorkspaces}>
                {t("打开工作台", "Open workspaces")}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardFooter>
          </Card>
        </div>
        <section className="recent-section" aria-labelledby="recent-workspaces-title">
          <div className="section-heading">
            <div>
              <h2 id="recent-workspaces-title">{t("最近的工作区", "Recent workspaces")}</h2>
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
              onClick={onAddWorkspace}
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
                <Card size="sm" key={project} data-liquid-glass="panel">
                  <CardHeader>
                    <div className="workspace-symbol">
                      <FolderKanban />
                    </div>
                    <CardTitle title={name}>{name}</CardTitle>
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
                  <Button onClick={onAddWorkspace}>
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
  onOpenRuns: (runId?: string, taskId?: string) => void;
}) {
  const { t, status } = useLocale();
  const [gateDecisions, setGateDecisions] = useState<Record<string, string>>(
    {},
  );
  const gateSubmissionRef = useRef(new Set<string>());
  const [gateSubmissions, setGateSubmissions] = useState<Record<string, string>>({});
  const [gateErrors, setGateErrors] = useState<Record<string, string>>({});
  const taskSubmissionRef = useRef(new Set<string>());
  const [taskSubmissions, setTaskSubmissions] = useState<Set<string>>(new Set());
  const [taskErrors, setTaskErrors] = useState<Record<string, string>>({});
  const [taskIssueLimit, setTaskIssueLimit] = useState(INBOX_TASK_PAGE_SIZE);
  const activeRunIds = new Set(
    snapshot.orchestration.runs
      .filter((run) => text(run["status"]) === "active")
      .map((run) => text(run["id"])),
  );
  const gates = snapshot.orchestration.gates.filter(
    (gate) =>
      activeRunIds.has(text(gate["runId"])) &&
      text(gate["status"]) === "pending",
  ).sort((left, right) => (Number(right["createdAt"]) || 0) - (Number(left["createdAt"]) || 0));
  const taskIssues = snapshot.orchestration.tasks.filter((task) =>
    activeRunIds.has(text(task["runId"])) &&
    ["failed", "blocked"].includes(text(task["status"])),
  ).sort((left, right) => (Number(right["updatedAt"]) || 0) - (Number(left["updatedAt"]) || 0));
  const visibleTaskIssues = taskIssues.slice(0, taskIssueLimit);
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
      setGateErrors((current) => ({ ...current, [gateId]: reportError(reason) }));
    } finally {
      gateSubmissionRef.current.delete(gateId);
      setGateSubmissions((current) => {
        const next = { ...current };
        delete next[gateId];
        return next;
      });
    }
  };
  const retryInboxTask = async (taskId: string): Promise<void> => {
    if (taskSubmissionRef.current.has(taskId)) return;
    taskSubmissionRef.current.add(taskId);
    setTaskSubmissions((current) => new Set(current).add(taskId));
    setTaskErrors((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    try {
      await window.prospero.orchestrationAction("task.retry", {
        operationId: crypto.randomUUID(),
        taskId,
      });
    } catch (reason) {
      setTaskErrors((current) => ({ ...current, [taskId]: reportError(reason) }));
    } finally {
      taskSubmissionRef.current.delete(taskId);
      setTaskSubmissions((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  };
  const gateActions = (gate: JsonObject): React.ReactNode => {
    const gateId = text(gate["id"]);
    const errorId = `gate-error-${encodeURIComponent(gateId)}`;
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
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            placeholder={t("输入决定", "Enter a decision")}
            onChange={(event) =>
              setGateDecisions((current) => ({
                ...current,
                [gateId]: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key !== "Enter" || !decision.trim() || submitting) return;
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
        {error && <span id={errorId} className="w-full text-xs text-destructive" role="alert">{error}</span>}
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
            <Badge variant="secondary" aria-live="polite">
              {total} {t("项待处理", "open")}
            </Badge>
          }
        />
        <div className="inbox-list">
          {!snapshot.daemon.running && (
            <Card className="inbox-item tone-danger" role="article">
              <CardHeader>
                <div className="inbox-item-head">
                  <span className="attention-icon tone-danger" aria-hidden="true">
                    <WifiOff />
                  </span>
                  <div>
                    <CardTitle role="heading" aria-level={2}>
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
                <Button
                  aria-busy={snapshot.daemon.starting}
                  disabled={snapshot.daemon.starting}
                  onClick={() => void window.prospero.startDaemon()}
                >
                  {snapshot.daemon.starting
                    ? t("正在连接…", "Connecting…")
                    : t("重新连接", "Reconnect")}
                </Button>
              </CardFooter>
            </Card>
          )}
          {gates.map((gate) => (
            <Card className="inbox-item tone-warning" key={text(gate["id"])} role="article">
              <CardHeader>
                <div className="inbox-item-head">
                  <span className="attention-icon tone-warning" aria-hidden="true">
                    <ListChecks />
                  </span>
                  <div>
                    <CardTitle role="heading" aria-level={2} title={text(gate["question"])}>
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
                <Button variant="ghost" size="sm" onClick={() => onOpenRuns(text(gate["runId"]), text(gate["taskId"]) || undefined)}>
                  {t("打开运行", "Open run")}
                </Button>
              </CardFooter>
            </Card>
          ))}
          {sessionIssues.map((session) => (
            <Card className="inbox-item tone-warning" key={session.id} role="article">
              <CardHeader>
                <div className="inbox-item-head">
                  <span className="attention-icon tone-warning" aria-hidden="true">
                    <MessageSquare />
                  </span>
                  <div>
                    <CardTitle role="heading" aria-level={2} title={sessionLabel(session)}>{sessionLabel(session)}</CardTitle>
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
                <p className="line-clamp-3">
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
          {visibleTaskIssues.map((task) => (
            <Card className="inbox-item tone-danger" key={text(task["id"])} role="article">
              <CardHeader>
                <div className="inbox-item-head">
                  <span className="attention-icon tone-danger" aria-hidden="true">
                    <CircleAlert />
                  </span>
                  <div>
                    <CardTitle role="heading" aria-level={2} title={text(task["title"])}>
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
                <p className="line-clamp-3">
                  {text(
                    task["spec"],
                    t(
                      "打开对应 Run 查看失败上下文与执行结果。",
                      "Open the related run for failure context and results.",
                    ),
                  )}
                </p>
              </CardContent>
              <CardFooter className="flex-wrap">
                <Button variant="outline" size="sm" onClick={() => onOpenRuns(text(task["runId"]), text(task["id"]))}>
                  {t("查看运行", "View run")}
                </Button>
                {text(task["status"]) === "failed" && (
                  <Button
                    size="sm"
                    disabled={taskSubmissions.has(text(task["id"]))}
                    onClick={() => void retryInboxTask(text(task["id"]))}
                  >
                    {taskSubmissions.has(text(task["id"])) && <Spinner data-icon="inline-start" />}
                    {taskSubmissions.has(text(task["id"])) ? t("重试中…", "Retrying…") : t("重试", "Retry")}
                  </Button>
                )}
                {taskErrors[text(task["id"])] && <span className="w-full text-xs text-destructive" role="alert">{taskErrors[text(task["id"])]}</span>}
              </CardFooter>
            </Card>
          ))}
          {visibleTaskIssues.length < taskIssues.length && (
            <Button
              variant="outline"
              onClick={() => setTaskIssueLimit((current) => current + INBOX_TASK_PAGE_SIZE)}
            >
              {t("显示更多失败任务", "Show more failed tasks")} · {taskIssues.length - visibleTaskIssues.length}
            </Button>
          )}
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
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setName(currentName);
      setError(undefined);
    }
  }, [open, currentName]);
  const save = async (): Promise<void> => {
    if (busyRef.current || !project || !name.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await window.prospero.renameProject(project, name);
      onOpenChange(false);
    } catch (reason) {
      setError(reportError(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (next || !busy) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={!busy} closeLabel={t("关闭", "Close")} aria-busy={busy}>
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
            <AlertDescription id="workspace-rename-error">{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="workspace-name">
            {t("显示名称", "Display name")}
          </FieldLabel>
          <Input
            id="workspace-name"
            autoFocus
            maxLength={80}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "workspace-rename-error workspace-path-description" : "workspace-path-description"}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (!event.nativeEvent.isComposing && event.key === "Enter" && !busy) void save();
            }}
          />
          <FieldDescription id="workspace-path-description" className="truncate" title={project}>
            {project}
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
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
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setName(session ? sessionLabel(session) : "");
      setError(undefined);
    }
  }, [open, session]);
  const save = async (): Promise<void> => {
    if (busyRef.current || !session || !name.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await window.prospero.renameSession(session.id, name);
      onOpenChange(false);
    } catch (reason) {
      setError(reportError(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (next || !busy) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={!busy} closeLabel={t("关闭", "Close")} aria-busy={busy}>
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
            <AlertDescription id="session-rename-error">{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="session-name">
            {t("显示名称", "Display name")}
          </FieldLabel>
          <Input
            id="session-name"
            autoFocus
            maxLength={120}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "session-rename-error session-path-description" : "session-path-description"}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (!event.nativeEvent.isComposing && event.key === "Enter" && !busy) void save();
            }}
          />
          <FieldDescription id="session-path-description" className="truncate" title={session?.cwd}>
            {session?.cwd}
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
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
  remoteWorkspaces,
  onRemoteWorkspace,
  onManageHosts,
  initialSource,
  initialTab,
}: {
  initialTab: "session" | "workspace";
  snapshot: DesktopSnapshot;
  project: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: SessionInfo) => void;
  remoteWorkspaces: RemoteWorkspace[];
  onRemoteWorkspace: (workspace: RemoteWorkspace, newSession?: boolean) => void;
  onManageHosts: () => void;
  initialSource: SourceSelection | undefined;
}) {
  const { t, status } = useLocale();
  const [tab, setTab] = useState(initialTab);
  const independentAccounts = useMemo(() => snapshot.accounts.filter(account => !account.modelSource), [snapshot.accounts]);
  const sourceSupported = snapshot.daemon.running && snapshot.daemon.capabilities?.includes("model.sources.v1") === true && typeof window.prospero.modelSourceAction === "function";
  const [useSource, setUseSource] = useState(() => sourceSupported && Boolean(initialSource || rememberedSourceSelection()));
  const [sourceSelection, setSourceSelection] = useState<SourceSelection | undefined>(initialSource);
  const sourceState = useModelSources(sourceSupported && useSource);
  const sourceChoice = selectedSourceRoute(sourceState.sources, sourceSelection);
  const [input, setInput] = useState<SessionCreateInput>({
    cwd: project || snapshot.projects[0] || "",
    agent: "codex",
    kind: "structured",
    approvalPolicy: "standard",
    accountId: defaultSessionLaunchAccountId(independentAccounts, "codex"),
  });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const [remoteId, setRemoteId] = useState<string>();
  const remoteTarget = remoteWorkspaces.find(workspace => workspace.id === remoteId);
  const [error, setError] = useState<string>();
  const [launchModels, setLaunchModels] = useState<AgentModel[]>([]);
  const [launchModelsLoading, setLaunchModelsLoading] = useState(false);
  const [launchModelsError, setLaunchModelsError] = useState<string>();
  const launchCatalogKey = useRef<string | undefined>(undefined);
  const workspaceSelectRef = useRef<HTMLSelectElement>(null);
  const launchWorkspaces = useMemo(
    () => sessionLaunchWorkspaces(snapshot),
    [snapshot],
  );
  const launchAccounts = useMemo(
    () => sessionLaunchAccounts(independentAccounts, input.agent),
    [input.agent, independentAccounts],
  );
  const selectedAccount = launchAccounts.find(
    (account) => account.id === input.accountId,
  );
  const requiresStructured = sessionLaunchRequiresStructured(selectedAccount);
  const selectedKind: SessionCreateInput["kind"] = useSource ? sourceChoice?.route.protocol === "openai_chat_completions" ? "structured" : input.kind : requiresStructured ? "structured" : input.kind;
  const accountCanLaunch = useSource ? sourceSupported && Boolean(sourceChoice) : !selectedAccount?.apiProfileError && (selectedAccount?.capabilities?.sessionKinds.includes(selectedKind) ?? true);
  const selectedWorkspace = launchWorkspaces.find(
    (workspace) => workspace.path === input.cwd,
  );
  const selectedLaunchModel = launchModels.find(
    (model) => model.id === input.model,
  );
  // 对话框打开时刷新一次账号。主进程在 daemon 就绪时已经灌过一份,但 daemon
  // 可能是后启动的,账号也可能在别处刚被创建/删除 —— 这里兜住那些情况。
  useEffect(() => {
    if (!open || tab !== "session") return;
    void window.prospero
      .accountAction({ type: "agent.accounts.list", requestId: crypto.randomUUID() })
      .catch(() => undefined);
  }, [open, tab]);
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
      const accounts = sessionLaunchAccounts(independentAccounts, current.agent);
      const accountId = accounts.some((account) => account.id === current.accountId)
        ? current.accountId
        : defaultSessionLaunchAccountId(independentAccounts, current.agent);
      if (cwd === current.cwd && accountId === current.accountId) return current;
      return { ...current, cwd, accountId, model: undefined, effort: undefined };
    });
  }, [launchWorkspaces, open, project, independentAccounts]);
  const supportsStructured = [
    "codex",
    "claude",
    "deepseek",
    "opencode",
  ].includes(input.agent);
  const supportsLaunchModels =
    !useSource &&
    !remoteId &&
    selectedKind === "structured" &&
    (selectedAccount?.capabilities?.modelSelection ?? true) &&
    (input.agent === "codex" ||
      input.agent === "claude" ||
      input.agent === "deepseek");
  useEffect(() => {
    if (!requiresStructured) return;
    setInput((current) => current.kind === "structured" ? current : { ...current, kind: "structured" });
  }, [requiresStructured]);
  useEffect(() => {
    if (!open || !supportsLaunchModels) {
      launchCatalogKey.current = undefined;
      setLaunchModels([]);
      setLaunchModelsLoading(false);
      setLaunchModelsError(undefined);
      return;
    }
    if (tab !== "session") return;
    const catalogKey = JSON.stringify([input.agent, input.accountId, input.kind]);
    if (launchCatalogKey.current === catalogKey) return;
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
        launchCatalogKey.current = catalogKey;
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
        setLaunchModelsError(reportError(reason));
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
  }, [input.accountId, input.agent, input.kind, open, supportsLaunchModels, tab]);
  const create = async (): Promise<void> => {
    if (remoteId) {
      if (!busyRef.current && remoteTarget) { onRemoteWorkspace(remoteTarget, true); onOpenChange(false); }
      return;
    }
    if (busyRef.current || !input.cwd || !accountCanLaunch) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (useSource) {
        if (!sourceChoice || !sourceSelection) throw new Error(t("请选择有效的模型源和模型。", "Choose a valid model source and model."));
        const bound = await runModelSourceAction({ kind: "bind", sourceId: sourceSelection.sourceId, routeId: sourceSelection.routeId, revision: sourceSelection.revision });
        if (!bound.accountId) throw new Error(t("模型源没有返回会话绑定。", "The source did not return an account binding."));
        onCreated(await window.prospero.createSession({ cwd: input.cwd, agent: sourceRouteAgent(sourceChoice.route), accountId: bound.accountId, kind: selectedKind, approvalPolicy: input.approvalPolicy }));
        rememberSourceSelection(sourceSelection);
      } else {
        onCreated(await window.prospero.createSession({ ...input, kind: selectedKind, model: selectedAccount?.capabilities?.modelSelection === false ? undefined : input.model, effort: selectedAccount?.capabilities?.reasoningEffort === false ? undefined : input.effort }));
        rememberSourceSelection(undefined);
      }
      onOpenChange(false);
    } catch (reason) {
      setError(reportError(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (next || (!busy && !choosingWorkspace)) onOpenChange(next); }}>
      <DialogContent
        className="new-session-dialog sm:max-w-2xl"
        showCloseButton={!busy && !choosingWorkspace}
        closeLabel={t("关闭", "Close")}
        initialFocus={tab === "session" ? workspaceSelectRef : undefined}
        aria-busy={busy || choosingWorkspace}
      >
        <DialogHeader>
          <DialogTitle>{t("新建", "Create")}</DialogTitle>
          <DialogDescription>{tab === "workspace" ? t("添加本机或远程文件夹，继续创建会话。", "Add a local or remote folder, then start a conversation.") : t("选择工作区、Agent 和模型。", "Choose a workspace, agent, and model.")}</DialogDescription>
        </DialogHeader>
        <Tabs className="create-dialog-tabs" value={tab} onValueChange={(value) => { if (!busy && !choosingWorkspace && (value === "session" || value === "workspace")) setTab(value); }}>
          <TabsList variant="line" aria-label={t("创建类型", "Create type")}>
            <TabsTrigger value="session" disabled={busy || choosingWorkspace}><MessageSquare />{t("新增会话", "New session")}</TabsTrigger>
            <TabsTrigger value="workspace" disabled={busy || choosingWorkspace}><FolderPlus />{t("新增工作区", "New workspace")}</TabsTrigger>
          </TabsList>
          <TabsContent value="session" keepMounted className="create-dialog-panel">
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
              ref={workspaceSelectRef}
              id="session-project"
              value={remoteId ?? input.cwd}
              disabled={busy}
              onChange={(event) => {
                const remoteWorkspace = remoteWorkspaces.find(workspace => workspace.id === event.target.value);
                setRemoteId(remoteWorkspace?.id);
                if (!remoteWorkspace) setInput({ ...input, cwd: event.target.value });
              }}
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
              {remoteWorkspaces.length > 0 && <NativeSelectOptGroup label={t("远程工作区", "Remote workspaces")}>{remoteWorkspaces.map(workspace => <NativeSelectOption key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.hostName}</NativeSelectOption>)}</NativeSelectOptGroup>}
            </NativeSelect>
            <Button variant={launchWorkspaces.length === 0 ? "outline" : "ghost"} size="sm" className="w-fit" disabled={busy || choosingWorkspace} onClick={() => setTab("workspace")}>
              {choosingWorkspace ? <Spinner data-icon="inline-start" /> : <FolderPlus data-icon="inline-start" />}
              {choosingWorkspace ? t("正在选择…", "Choosing…") : launchWorkspaces.length === 0 ? t("添加第一个工作区", "Add your first workspace") : t("添加其他工作区", "Add another workspace")}
            </Button>
            <FieldDescription className="truncate" title={remoteTarget?.cwd ?? selectedWorkspace?.detail}>
              {remoteTarget ? `${remoteTarget.hostName} · ${remoteTarget.cwd}` : launchWorkspaces.length === 0
                ? t("选择一个本地项目后即可在此创建会话。", "Choose a local project to create a session here.")
                : selectedWorkspace?.kind === "worktree"
                ? t("编排 worktree · 会话会直接在隔离分支中运行。", "Orchestration worktree · the session runs directly on the isolated branch.")
                : t("项目根目录与持久上下文。", "Project root and persistent context.")}
            </FieldDescription>
          </Field>
          {remoteId ? <p className="workspace-picker-hint">{t("在远程电脑的此目录新建交互式 Shell，可运行远端已安装的 codex、claude 等 CLI。不会使用本机账号或本机模型配置。", "Create an interactive Shell in this folder on the remote computer, where you can run its installed codex, claude or other CLI. Local accounts and model settings are not used.")}</p> : <>
          <div className="model-source-session-mode" role="group" aria-label={t("模型连接方式", "Model connection")}><Button data-liquid-glass="tab" variant={useSource ? "secondary" : "ghost"} aria-pressed={useSource} disabled={busy || !sourceSupported} onClick={() => setUseSource(true)}>{t("共享模型源", "Shared model source")}</Button><Button data-liquid-glass="tab" variant={!useSource ? "secondary" : "ghost"} aria-pressed={!useSource} disabled={busy} onClick={() => setUseSource(false)}>{t("CLI / 独立 Profile", "CLI / independent profile")}</Button></div>
          {useSource ? <><SourceSelector sources={sourceState.sources} loading={sourceState.loading} error={sourceState.error} value={sourceSelection} onChange={setSourceSelection} onRefresh={() => void sourceState.refresh()} disabled={busy} /><Field><FieldLabel htmlFor="source-session-kind">{t("会话类型", "Session type")}</FieldLabel><NativeSelect id="source-session-kind" value={selectedKind} disabled={busy || sourceChoice?.route.protocol === "openai_chat_completions"} onChange={event => setInput(current => ({ ...current, kind: event.target.value as SessionCreateInput["kind"] }))}><NativeSelectOption value="structured">{t("对话", "Conversation")}</NativeSelectOption><NativeSelectOption value="pty">{t("终端", "Terminal")}</NativeSelectOption></NativeSelect></Field></> : <>
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
                      independentAccounts,
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
                value={selectedKind}
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
                  disabled={!supportsStructured || selectedAccount?.capabilities?.sessionKinds.includes("structured") === false}
                >
                  {t("对话", "Conversation")}
                </NativeSelectOption>
                <NativeSelectOption value="pty" disabled={selectedAccount?.capabilities?.sessionKinds.includes("pty") === false || requiresStructured}>
                  {t("终端", "Terminal")}
                </NativeSelectOption>
              </NativeSelect>
              {requiresStructured && <FieldDescription>{t("当前账号仅支持对话会话。", "This account supports conversation sessions only.")}</FieldDescription>}
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
                  ? selectedAccount.apiProfileError ?? `${selectedAccount.engine ?? input.agent} · ${selectedAccount.apiProfile ? `${t("使用 Profile 模型", "Profile model")} · ${text(selectedAccount.apiProfile["model"])}` : status(selectedAccount.status) + " · CLI"}`
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
                  aria-busy={launchModelsLoading}
                  aria-describedby={launchModelsError ? "session-model-error" : undefined}
                  aria-invalid={Boolean(launchModelsError)}
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
                <FieldDescription
                  id={launchModelsError ? "session-model-error" : undefined}
                  role={launchModelsError ? "alert" : undefined}
                >
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
                  disabled={selectedAccount?.capabilities?.reasoningEffort === false || !selectedLaunchModel?.supportedEfforts.length}
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
          </>}
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
              {input.approvalPolicy === "strict"
                ? t("严格确认所有可能修改系统或文件的操作。", "Ask before operations that may modify files or the system.")
                : input.approvalPolicy === "yolo"
                  ? t("高风险：自动批准操作，仅用于可信工作区。", "High risk: approve operations automatically; use only in trusted workspaces.")
                  : t("在高风险操作前请求确认。", "Ask for confirmation before high-risk actions.")}
            </FieldDescription>
          </Field>
          </>}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" disabled={busy || choosingWorkspace} onClick={() => onOpenChange(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button
            aria-busy={busy}
            disabled={busy || choosingWorkspace || (remoteId ? !remoteTarget : !accountCanLaunch || !input.cwd || (supportsLaunchModels && launchModelsLoading))}
            onClick={() => void create()}
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            {busy ? t("正在创建", "Creating") : remoteId ? t("创建远程 Shell", "Create remote Shell") : t("创建会话", "Create session")}
          </Button>
        </DialogFooter>
          </TabsContent>
          <TabsContent value="workspace" className="create-dialog-panel">
            <WorkspacePicker onBusyChange={setChoosingWorkspace} onClose={() => onOpenChange(false)} onLocalAdded={(cwd) => { setRemoteId(undefined); setInput((current) => ({ ...current, cwd })); setTab("session"); }} onRemoteAdded={(workspace) => { onRemoteWorkspace(workspace); setRemoteId(workspace.id); setTab("session"); }} onManageHosts={() => { onOpenChange(false); onManageHosts(); }} />
          </TabsContent>
        </Tabs>
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
  onNewSession: (project?: string) => void;
}) {
  const { status, t } = useLocale();
  const [query, setQuery] = useState("");
  const [activeOption, setActiveOption] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) setQuery("");
    setActiveOption(0);
  }, [open]);
  useEffect(() => setActiveOption(0), [mode, query]);
  const recentSessionByProject = useMemo(() => {
    const recent = new Map<string, SessionInfo>();
    for (const session of sortSidebarSessions(
      snapshot.daemon.sessions,
      undefined,
      snapshot.pinnedSessionIds,
      snapshot.unreadSessionIds,
    )) {
      const project = projectForSession(snapshot.projects, session);
      if (project && !recent.has(project)) recent.set(project, session);
    }
    return recent;
  }, [
    snapshot.daemon.sessions,
    snapshot.pinnedSessionIds,
    snapshot.projects,
    snapshot.unreadSessionIds,
  ]);
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
    ...snapshot.projects.map((project) => {
      const recent = recentSessionByProject.get(project);
      return {
        key: `project:${project}`,
        label: project.split(/[\\/]/).filter(Boolean).at(-1) ?? project,
        detail: shortPath(project),
        icon: FolderKanban,
        run: () => recent ? onOpenSession(recent.id) : onNewSession(project),
      };
    }),
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
  const allOptions = mode === "command"
    ? [...matches(actions), ...commandSessions]
    : matches(quick);
  const options = allOptions.slice(0, COMMAND_RESULT_LIMIT);
  const hiddenOptionCount = allOptions.length - options.length;
  useEffect(() => {
    setActiveOption((current) =>
      Math.min(current, Math.max(0, options.length - 1)),
    );
  }, [options.length]);
  useEffect(() => {
    resultsRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeOption]);
  const runOption = (index: number): void => {
    const item = options[index];
    if (!item) return;
    item.run();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="command-dialog sm:max-w-xl" showCloseButton={false}>
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
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            maxLength={SEARCH_QUERY_MAX_LENGTH}
            role="combobox"
            aria-label={
              mode === "command"
                ? t("搜索会话或命令", "Search sessions or commands")
                : t("快速打开工作区或会话", "Quickly open a workspace or session")
            }
            aria-controls="command-results"
            aria-describedby="command-results-summary"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-activedescendant={
              options.length > 0
                ? `command-option-${String(activeOption)}`
                : undefined
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveOption((current) =>
                  options.length === 0 ? 0 : (current + 1) % options.length,
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveOption((current) =>
                  options.length === 0
                    ? 0
                    : (current - 1 + options.length) % options.length,
                );
              } else if (event.key === "Enter" && options.length > 0) {
                event.preventDefault();
                runOption(activeOption);
              }
            }}
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
        <div id="command-results-summary" className="command-results-summary" role="status" aria-live="polite">
          {allOptions.length === 0
            ? t("没有匹配结果", "No matching results")
            : hiddenOptionCount > 0
              ? t(
                  `显示前 ${String(options.length)} 项，共 ${String(allOptions.length)} 项；继续输入可缩小范围`,
                  `Showing the first ${String(options.length)} of ${String(allOptions.length)} results; type more to narrow the list`,
                )
              : t(`${String(options.length)} 项结果`, `${String(options.length)} results`)}
        </div>
        <div
          id="command-results"
          className="command-results"
          role="listbox"
          tabIndex={-1}
          aria-label={mode === "command" ? t("命令结果", "Command results") : t("快速打开结果", "Quick Open results")}
          ref={resultsRef}
        >
          {options.map((item, index) => (
            <Button
              variant="ghost"
              key={item.key}
              id={`command-option-${String(index)}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeOption}
              aria-posinset={index + 1}
              aria-setsize={allOptions.length}
              data-active={index === activeOption ? "true" : undefined}
              onMouseEnter={() => setActiveOption(index)}
              onClick={() => runOption(index)}
            >
              <item.icon data-icon="inline-start" />
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              <ChevronRight data-icon="inline-end" />
            </Button>
          ))}
          {options.length === 0 && <p aria-hidden="true">{t("没有匹配结果", "No matching results")}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function App({ snapshot }: { snapshot: DesktopSnapshot }) {
  useEffect(() => installLiquidGlass(), []);
  const { t } = useLocale();
  useEffect(() => {
    if (snapshot.daemon.lastError) notify({ kind: "error", title: t("本地服务异常", "Local service error"), message: snapshot.daemon.lastError });
  }, [snapshot.daemon.lastError, t]);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [view, setView] = useState<View>(readStoredView);
  const remote = useRemoteWorkspaces();
  const [createTab, setCreateTab] = useState<"session" | "workspace">("session");
  const [activeRemoteId, setActiveRemoteId] = useState<string | undefined>(() => {
    try { return localStorage.getItem("prospero.activeRemoteWorkspace") || undefined; } catch { return undefined; }
  });
  const [remoteSessionRequest, setRemoteSessionRequest] = useState(0);
  const activeRemote = remote.workspaces.find(workspace => workspace.id === activeRemoteId);
  const openRemoteWorkspace = useCallback((workspace: RemoteWorkspace, newSession = false) => {
    remote.upsert(workspace);
    setRemoteSessionRequest(request => activeRemoteId === workspace.id ? request + (newSession ? 1 : 0) : newSession ? 1 : 0);
    setActiveRemoteId(workspace.id);
    setView("workspaces");
  }, [activeRemoteId, remote.upsert]);
  const openAddWorkspace = useCallback(() => { setCreateTab("workspace"); setNewSessionOpen(true); }, []);
  useEffect(() => {
    if (view !== "workspaces") { setActiveRemoteId(undefined); setRemoteSessionRequest(0); }
  }, [view]);
  useEffect(() => {
    if (remote.ready && activeRemoteId && !activeRemote) setActiveRemoteId(undefined);
  }, [activeRemote, activeRemoteId, remote.ready]);
  useEffect(() => {
    try {
      if (activeRemoteId) localStorage.setItem("prospero.activeRemoteWorkspace", activeRemoteId);
      else localStorage.removeItem("prospero.activeRemoteWorkspace");
    } catch {}
  }, [activeRemoteId]);
  const [hydratedSessions, setHydratedSessions] = useState<SessionInfo[]>([]);
  const [openIds, setOpenIds] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(OPEN_SESSIONS_STORAGE_KEY) || "[]",
      ) as unknown;
      const ids = Array.isArray(stored)
        ? stored.filter((value): value is string => typeof value === "string")
        : [];
      const active = readStoredActiveSession();
      return restoredSessionIds(ids, active);
    } catch {
      return [];
    }
  });
  const restoredOpenIds = useRef(openIds);
  const [restoredSessionsReady, setRestoredSessionsReady] = useState(
    openIds.length === 0,
  );
  const [sessionRestoreAttempt, setSessionRestoreAttempt] = useState(0);
  const [activeId, setActiveId] = useState<string | undefined>(
    readStoredActiveSession,
  );
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionProject, setNewSessionProject] = useState<string>();
  const [newSessionSource, setNewSessionSource] = useState<SourceSelection>();
  const [runTargetId, setRunTargetId] = useState<string>();
  const [taskTargetId, setTaskTargetId] = useState<string>();
  const [editingProject, setEditingProject] = useState<string>();
  const [editingSession, setEditingSession] = useState<string>();
  const [sessionActionError, setSessionActionError] = useState<string>();
  const [sidebarPreference] = useState(readSidebarOpenPreference);
  const startsWithCompactSidebar =
    window.innerWidth <= SIDEBAR_COLLAPSE_WIDTH;
  const [sidebarOpen, setSidebarOpen] = useState(
    () => startsWithCompactSidebar ? false : sidebarPreference ?? true,
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
    () => validOpenSessionIds(openIds, sessionSnapshot.daemon.sessions),
    [openIds, sessionSnapshot.daemon.sessions],
  );
  const openMetadataKey = validOpenIds.slice(0, 100).join("|");
  useEffect(() => {
    if (!snapshot.daemon.metadataRevision || !openMetadataKey || !snapshot.daemon.running) return;
    let cancelled = false;
    const ids = openMetadataKey.split("|");
    void window.prospero.listSessions({ ids, limit: 100 }).then(page => {
      if (cancelled) return;
      const requested = new Set(ids);
      setHydratedSessions(current => [...page.items, ...current.filter(item => !requested.has(item.id))].slice(0, HYDRATED_SESSION_CACHE_LIMIT));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [openMetadataKey, snapshot.daemon.metadataRevision, snapshot.daemon.running]);
  useSessionUnread(sessionSnapshot.daemon.sessions, snapshot.unreadSessionIds, view === "workspaces" && !activeRemote ? activeId : undefined);
  const accountUsageKey = snapshot.accounts
    .map((account) => `${text(account["id"])}:${text(account["status"])}`)
    .join("|");
  useEffect(() => {
    if (restoredSessionsReady) return;
    let retryTimer: number | undefined;
    const ids = restoredOpenIds.current.slice(0, 100);
    if (ids.length === 0) {
      setRestoredSessionsReady(true);
      return;
    }
    const liveIds = new Set(snapshotRef.current.daemon.sessions.map((session) => session.id));
    const missingIds = ids.filter((id) => !liveIds.has(id));
    if (missingIds.length === 0) {
      setRestoredSessionsReady(true);
      return;
    }
    if (!snapshot.daemon.running) return;
    let cancelled = false;
    void window.prospero.listSessions({ ids: missingIds, limit: 100 })
      .then((page) => {
        if (cancelled) return;
        setHydratedSessions((current) => [
          ...page.items,
          ...current.filter((session) => !page.items.some((item) => item.id === session.id)),
        ].slice(0, HYDRATED_SESSION_CACHE_LIMIT));
        const available = new Set([
          ...snapshotRef.current.daemon.sessions.map((session) => session.id),
          ...page.items.map((session) => session.id),
        ]);
        const restored = new Set(ids);
        setOpenIds((current) =>
          current.filter((id) => !restored.has(id) || available.has(id)),
        );
        setRestoredSessionsReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        const delay = sessionRestoreRetryDelay(sessionRestoreAttempt);
        if (delay === undefined) {
          setRestoredSessionsReady(true);
          return;
        }
        retryTimer = window.setTimeout(
          () => setSessionRestoreAttempt((current) => current + 1),
          delay,
        );
      });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [restoredSessionsReady, sessionRestoreAttempt, snapshot.daemon.running]);
  useEffect(() => {
    if (!restoredSessionsReady) return;
    try {
      localStorage.setItem(
        OPEN_SESSIONS_STORAGE_KEY,
        JSON.stringify(validOpenIds),
      );
    } catch {}
  }, [restoredSessionsReady, validOpenIds]);
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, view);
    } catch {}
  }, [view]);
  useEffect(() => {
    if (!restoredSessionsReady) return;
    try {
      if (activeId) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeId);
      else localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    } catch {}
  }, [activeId, restoredSessionsReady]);
  useEffect(() => {
    if (!restoredSessionsReady) return;
    if (
      activeId &&
      !sessionSnapshot.daemon.sessions.some((session) => session.id === activeId)
    )
      setActiveId(validOpenIds[0]);
    else if (!activeId && validOpenIds.length > 0)
      setActiveId(validOpenIds[0]);
  }, [
    sessionSnapshot.daemon.sessions,
    activeId,
    restoredSessionsReady,
    validOpenIds,
  ]);
  useLayoutEffect(() => {
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
      const preference = sidebarPreferenceRef.current;
      const next = window.innerWidth <= SIDEBAR_COLLAPSE_WIDTH
        ? false
        : window.innerWidth >= SIDEBAR_EXPAND_WIDTH
          ? preference ?? true
          : adaptiveSidebarOpen(window.innerWidth, sidebarOpenRef.current);
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
      if (matchesDesktopShortcut(event, "k", window.prospero.platform)) {
        event.preventDefault();
        setLauncher("command");
      } else if (matchesDesktopShortcut(event, "p", window.prospero.platform)) {
        event.preventDefault();
        setLauncher("quick");
      } else if (matchesDesktopShortcut(event, "n", window.prospero.platform)) {
        event.preventDefault();
        if (view === "workspaces" && activeRemote) { setRemoteSessionRequest(request => request + 1); return; }
        setNewSessionProject(undefined);
        setNewSessionSource(undefined);
        setCreateTab("session"); setNewSessionOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeRemote, view]);
  const openSession = useCallback((id: string, session?: SessionInfo): void => {
    setActiveRemoteId(undefined);
    if (session) {
      setHydratedSessions((current) =>
        upsertHydratedSession(current, session, HYDRATED_SESSION_CACHE_LIMIT),
      );
    }
    setOpenIds((current) =>
      current.includes(id) ? current : [...current, id],
    );
    setActiveId(id);
    setView("workspaces");
    if (snapshotRef.current.unreadSessionIds.includes(id))
      void window.prospero.setSessionUnread(id, false);
  }, []);
  const openRun = useCallback((runId?: string, taskId?: string): void => {
    setRunTargetId(runId);
    setTaskTargetId(taskId);
    setView("runs");
  }, []);
  const selectView = useCallback((next: View): void => {
    if (next !== "workspaces") setActiveRemoteId(undefined);
    void remote.refresh();
    if (next === "runs") {
      setRunTargetId(undefined);
      setTaskTargetId(undefined);
    }
    setView(next);
  }, [remote.refresh]);
  const closeSession = (id: string): void => {
    const index = validOpenIds.indexOf(id);
    const next = validOpenIds.filter((item) => item !== id);
    setOpenIds(next);
    if (activeId === id) setActiveId(next[Math.max(0, index - 1)]);
  };
  const openNewSession = useCallback((project?: string): void => {
    if (!project && view === "workspaces" && activeRemote) { setRemoteSessionRequest(request => request + 1); return; }
    setNewSessionProject(project);
    setNewSessionSource(undefined);
    setCreateTab("session"); setNewSessionOpen(true);
  }, [activeRemote, view]);
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
  const [focus, setFocus] = useState(() => {
    try {
      return localStorage.getItem(FOCUS_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FOCUS_STORAGE_KEY, String(focus));
    } catch {}
  }, [focus]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (view !== "workspaces" || !matchesFocusShortcut(event, window.prospero.platform)) return;
      event.preventDefault();
      event.stopPropagation();
      setFocus((current) => !current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [view]);
  const duplicateSession = useCallback((session: SessionInfo): void => {
    setSessionActionError(undefined);
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
      const accountState = duplicateSessionAccountState(snapshotRef.current.accounts, session);
      if (accountState === "missing") {
        throw new Error(t(
          `原会话账号“${session.accountName ?? session.accountId}”已删除，无法安全复制`,
          `The source account “${session.accountName ?? session.accountId}” was deleted and cannot be copied safely`,
        ));
      }
      if (accountState === "unavailable") {
        throw new Error(t(
          `原会话账号“${session.accountName ?? session.accountId}”当前不可用`,
          `The source account “${session.accountName ?? session.accountId}” is unavailable`,
        ));
      }
      const created = await window.prospero.createSession({
        cwd: project,
        agent,
        kind,
        approvalPolicy,
        ...(session.accountId ? { accountId: session.accountId } : {}),
      });
      openSession(created.id, created);
      try {
        await window.prospero.renameSession(
          created.id,
          t(`${sessionLabel(session)} 副本`, `${sessionLabel(session)} Copy`),
        );
      } catch (reason) {
        setSessionActionError(t(
          `副本已打开，但名称保存失败：${reportError(reason)}`,
          `The copy opened, but its name could not be saved: ${reportError(reason)}`,
        ));
      }
    })().catch((reason) => setSessionActionError(t(
      `无法复制会话：${reportError(reason)}`,
      `Unable to duplicate the session: ${reportError(reason)}`,
    )));
  }, [openSession, t]);
  const navigation = useNavigationHistory({ view, activeId: view === "workspaces" && !activeRemoteId ? activeId : undefined, activeRemoteId, runTargetId: view === "runs" ? runTargetId : undefined, taskTargetId: view === "runs" ? taskTargetId : undefined }, (destination) => {
    setView(destination.view); setActiveRemoteId(destination.activeRemoteId);
    if (destination.view === "workspaces") setActiveId(destination.activeId);
    if (destination.activeId) { setActiveId(destination.activeId); setOpenIds((ids) => ids.includes(destination.activeId!) ? ids : [...ids, destination.activeId!]); }
    setRunTargetId(destination.runTargetId); setTaskTargetId(destination.taskTargetId);
  });
  useEffect(() => {
    const navigate = (event: KeyboardEvent): void => { if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return; if (event.key === "ArrowLeft" && navigation.canBack) { event.preventDefault(); navigation.back(); } if (event.key === "ArrowRight" && navigation.canForward) { event.preventDefault(); navigation.forward(); } };
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [navigation]);
  const workspaceFocus = focus && view === "workspaces";
  return (
    <TooltipProvider>
    <ProjectToolsProvider>
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={changeSidebarOpen}
      className="prospero-shell"
    >
      <WindowsTitlebar canBack={navigation.canBack} canForward={navigation.canForward} onBack={navigation.back} onForward={navigation.forward} onAction={(action) => { if (action === "new-session") openNewSession(); if (action === "settings") selectView("settings"); if (action === "command") setLauncher("command"); }} />
      <a className="skip-link" href="#main-content">
        {t("跳到主内容", "Skip to main content")}
      </a>
      <SidebarTrigger className="sidebar-drawer-trigger" aria-label={t("打开侧边栏", "Open sidebar")} />
      <ShellSidebar
        snapshot={sessionSnapshot}
        view={view}
        activeId={activeRemoteId ? undefined : activeId}
        onView={selectView}
        onOpenSession={openSession}
        onNewSession={openNewSession}
        onTogglePin={togglePin}
        onToggleArchive={toggleArchive}
        onRenameProject={setEditingProject}
        onRenameSession={setEditingSession}
        onDuplicateSession={duplicateSession}
        onSetUnread={setUnread}
        onAddWorkspace={openAddWorkspace}
        remoteWorkspaces={remote.workspaces}
        activeRemoteId={view === "workspaces" ? activeRemoteId : undefined}
        onOpenRemote={openRemoteWorkspace}
        onUpdateRemote={remote.upsert}
        onForgetRemote={remote.forget}
        focus={workspaceFocus}
        onExitFocus={() => setFocus(false)}
        remoteError={remote.error}
        remoteLoading={remote.loading}
        onRetryRemote={() => void remote.refresh()}
      />
      <SidebarInset id="main-content" tabIndex={-1} className="prospero-main">

        <div className="main-viewport">
          {sessionActionError && !workspaceFocus && <Alert variant="destructive" className="mx-7 mt-5 w-auto"><CircleAlert /><AlertTitle>{t("会话操作失败", "Session action failed")}</AlertTitle><AlertDescription>{sessionActionError}</AlertDescription><Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSessionActionError(undefined)}>{t("关闭", "Dismiss")}</Button></Alert>}
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
                onOpenRuns={openRun}
                onOpenWorkspaces={() => setView("workspaces")}
                onNewSession={openNewSession}
                onAddWorkspace={openAddWorkspace}
              />
            ) : view === "inbox" ? (
              <InboxPane
                snapshot={sessionSnapshot}
                onOpenSession={openSession}
                onOpenRuns={openRun}
              />
            ) : view === "remote" ? (
              <RemoteHostsPane settings={sessionSnapshot.settings} />
            ) : view === "mobile" ? (
              <DevicesPane snapshot={sessionSnapshot} />
            ) : view === "workspaces" ? (
              activeRemote ? <RemoteWorkspacePane key={activeRemote.id} workspace={activeRemote} settings={sessionSnapshot.settings} focus={focus} onToggleFocus={() => setFocus(current => !current)} newSessionRequest={remoteSessionRequest} /> : activeRemoteId && !remote.ready ? <div className="boot-screen"><p role={remote.error ? "alert" : "status"}>{remote.error ?? t("正在恢复远程工作区…", "Restoring remote workspace…")}</p>{remote.error && <Button onClick={() => void remote.refresh()}>{t("重试", "Retry")}</Button>}</div> : <div className="local-workspace-container">
              {!workspaceFocus && validOpenIds.length > 0 && <WorkspaceTabs snapshot={sessionSnapshot} openIds={openIds} activeId={activeId} onActivate={openSession} onClose={closeSession} onTogglePin={togglePin} onReorder={ids => setOpenIds(current => [...ids, ...current.filter(id => !ids.includes(id))])} />}
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
                onToggleFocus={() => setFocus((current) => !current)}
                onAddWorkspace={openAddWorkspace}
              /></div>
            ) : view === "runs" ? (
              <OrchestrationPane
                snapshot={sessionSnapshot}
                onOpenSession={openSession}
                onNewSession={openNewSession}
                initialRunId={runTargetId}
                initialTaskId={taskTargetId}
              />
            ) : view === "providers" ? (
              <AccountsPane snapshot={sessionSnapshot} onOpenSession={openSession} onUseModelSource={selection => { setNewSessionProject(undefined); setNewSessionSource(selection); setCreateTab("session"); setNewSessionOpen(true); }} />
            ) : view === "skills" ? (
              <SkillsPane snapshot={sessionSnapshot} />
            ) : view === "diagnostics" ? (
              <LogsPane snapshot={sessionSnapshot} />
            ) : (
              <SettingsPane snapshot={sessionSnapshot} onOpenAccounts={() => selectView("providers")} />
            )}
          </Suspense>
        </div>
      </SidebarInset>
      {newSessionOpen && (
        <NewSessionDialog
          snapshot={sessionSnapshot}
          project={newSessionProject}
          open
          onOpenChange={setNewSessionOpen}
          onCreated={(session) => openSession(session.id, session)}
          remoteWorkspaces={remote.workspaces}
          onRemoteWorkspace={openRemoteWorkspace}
          onManageHosts={() => selectView("remote")}
          initialTab={createTab}
          initialSource={newSessionSource}
        />
      )}
      {editingProject && (
        <ProjectRenameDialog
          project={editingProject}
          currentName={
            snapshot.projectAliases[editingProject.toLocaleLowerCase()] ||
            editingProject.split(/[\\/]/).filter(Boolean).at(-1) ||
            editingProject
          }
          open
          onOpenChange={(open) => {
            if (!open) setEditingProject(undefined);
          }}
        />
      )}
      {editingSession && (
        <SessionRenameDialog
          session={sessionSnapshot.daemon.sessions.find(
            (session) => session.id === editingSession,
          )}
          open
          onOpenChange={(open) => {
            if (!open) setEditingSession(undefined);
          }}
        />
      )}
      {launcher && (
        <CommandDialog
          open
          onOpenChange={(open) => {
            if (!open) setLauncher(undefined);
          }}
          mode={launcher}
          snapshot={sessionSnapshot}
          onView={selectView}
          onOpenSession={openSession}
          onNewSession={openNewSession}
        />
      )}
    </SidebarProvider>
    </ProjectToolsProvider>
    </TooltipProvider>
  );
}
