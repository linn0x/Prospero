import type { SessionInfo } from "@prospero/protocol";

import type { StoredHost } from "./hosts";
import type { HostRuntime } from "./store";

const ACTIVE_STATUSES = new Set<SessionInfo["status"]>([
  "starting",
  "running",
  "waiting_approval",
  "waiting_input",
]);

const STATUS_PRIORITY: Record<SessionInfo["status"], number> = {
  waiting_approval: 0,
  waiting_input: 1,
  running: 2,
  starting: 3,
  idle: 4,
  completed: 5,
  done: 6,
  died: 7,
};

const STATUS_LABEL: Record<SessionInfo["status"], string> = {
  starting: "正在启动",
  running: "正在运行",
  waiting_approval: "等待审批",
  waiting_input: "等待回复",
  idle: "空闲",
  completed: "已完成",
  done: "已结束",
  died: "已退出",
};

export interface RunningSessionProgress {
  runningCount: number;
  waitingCount: number;
  title: string;
  detail: string;
  deepLink: string;
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "工作区";
}

/** 只把非敏感状态放进系统 UI；Agent 回复预览和完整路径不会出现在锁屏通知里。 */
export function runningSessionProgress(
  hosts: readonly StoredHost[],
  runtimes: Record<string, HostRuntime>,
): RunningSessionProgress | null {
  const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
  const active = Object.entries(runtimes).flatMap(([hostId, runtime]) =>
    Object.values(runtime.sessions)
      .filter((session) => ACTIVE_STATUSES.has(session.status))
      .map((session) => ({ hostId, hostName: hostNames.get(hostId) ?? "设备", session })),
  );
  if (active.length === 0) return null;

  active.sort(
    (a, b) =>
      STATUS_PRIORITY[a.session.status] - STATUS_PRIORITY[b.session.status] ||
      (b.session.busySince ?? b.session.createdAt) -
        (a.session.busySince ?? a.session.createdAt),
  );
  const primary = active[0];
  if (!primary) return null;
  const waitingCount = active.filter(
    ({ session }) =>
      session.status === "waiting_approval" || session.status === "waiting_input",
  ).length;
  const title = primary.session.title.trim() || `${primary.session.agent} 会话`;
  const remaining = active.length - 1;

  return {
    runningCount: active.length,
    waitingCount,
    title,
    detail: `${primary.hostName} · ${projectName(primary.session.cwd)} · ${STATUS_LABEL[primary.session.status]}${remaining > 0 ? ` · 另有 ${String(remaining)} 项` : ""}`,
    deepLink: `prospero://host/${encodeURIComponent(primary.hostId)}/session/${encodeURIComponent(primary.session.id)}`,
  };
}
