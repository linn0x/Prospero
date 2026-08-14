/** 编排工作树的单写租约：只信已登记 Dispatch 对应的实时会话。 */
import { realpathSync } from "node:fs";
import path from "node:path";
import type { SessionInfo } from "@prospero/protocol";
import type { WorktreeAsset } from "./model.js";
import type { OrchestrationStore } from "./store.js";

/** SessionManager.infoOf 的最小只读面；测试可显式提供确定的会话状态。 */
export interface WorktreeSessionInspector {
  infoOf(sid: string): SessionInfo;
}

export interface LiveWorktreeLease {
  asset: WorktreeAsset;
  session: SessionInfo;
}

/**
 * 会话/进程已真正终止，今后不可能再向它的 cwd 写入。
 *
 * `completed` 只表示结构化 agent 的一轮 turn 结束；`idle`、各种 waiting 状态和
 * `completed` 都仍可以接受下一轮 chat，因而仍是工作树 writer。调用方应把
 * `SessionManager.infoOf` 的缺失规范为 `null`，它和真正终止一样不再占租约。
 */
export function isTerminalSession(session: SessionInfo | null | undefined): boolean {
  return session == null || session.status === "done" || session.status === "died";
}

/** 找到某个 cwd 所在登记工作树的存活 writer；缺失或真正终态会话不占租约。 */
export function findLiveWorktreeLease(
  store: OrchestrationStore,
  sessions: WorktreeSessionInspector,
  cwd: string,
): LiveWorktreeLease | null {
  const candidate = canonicalPath(cwd);
  for (const asset of store.listWorktreeAssets()) {
    if (!isWithin(candidate, canonicalPath(asset.path))) continue;
    const lease = findLiveLeaseForAsset(store, sessions, asset);
    if (lease) return lease;
  }
  return null;
}

/** cwd 所在的最具体登记资产；用于覆盖 session.create 进行中的短暂租约窗口。 */
export function registeredWorktreeAssetForCwd(
  store: OrchestrationStore,
  cwd: string,
): WorktreeAsset | null {
  const candidate = canonicalPath(cwd);
  return store.listWorktreeAssets()
    .filter((asset) => isWithin(candidate, canonicalPath(asset.path)))
    .sort((a, b) => canonicalPath(b.path).length - canonicalPath(a.path).length)[0] ?? null;
}

/** cleanup/delete 使用：只检查这个资产是否仍有已登记 Dispatch 的存活 writer。 */
export function findLiveLeaseForAsset(
  store: OrchestrationStore,
  sessions: WorktreeSessionInspector,
  asset: WorktreeAsset,
): LiveWorktreeLease | null {
  const assetPath = canonicalPath(asset.path);
  for (const dispatch of store.listDispatches()) {
    let session: SessionInfo;
    try {
      session = sessions.infoOf(dispatch.sessionId);
    } catch {
      // 已从 SessionManager 移除的历史会话不再持有目录；允许显式清理/复用。
      continue;
    }
    if (isTerminalSession(session)) continue;

    const dispatchPath = dispatch.worktreePath ? canonicalPath(dispatch.worktreePath) : null;
    const sessionPath = canonicalPath(session.cwd);
    const belongsToAsset =
      asset.dispatchId === dispatch.id ||
      (dispatchPath !== null && isWithin(dispatchPath, assetPath)) ||
      isWithin(sessionPath, assetPath);
    if (belongsToAsset) return { asset, session };
  }
  return null;
}

/** Run 删除前的更宽检查：settled Dispatch 仍有 live session 也不能丢失索引。 */
export function findLiveSessionForRun(
  store: OrchestrationStore,
  sessions: WorktreeSessionInspector,
  runId: string,
): SessionInfo | null {
  for (const dispatch of store.listDispatches(runId)) {
    try {
      const session = sessions.infoOf(dispatch.sessionId);
      if (!isTerminalSession(session)) return session;
    } catch {
      // missing session cannot write the old worktree.
    }
  }
  return null;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
