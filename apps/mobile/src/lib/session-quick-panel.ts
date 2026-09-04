import type { GitFile } from "@prospero/protocol";

export interface GitChangeSummary {
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
}
/**
 * 同一个文件可以同时有暂存区和工作区改动，所以 staged / unstaged 不一定相加等于
 * changed；面板保留这个事实，避免把「又改过的已暂存文件」误报成干净。
 */
export function summarizeGitChanges(files: readonly GitFile[]): GitChangeSummary {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const file of files) {
    if (file.untracked) untracked++;
    if (file.index !== " " && file.index !== "?") staged++;
    if (file.worktree !== " " || file.untracked) unstaged++;
  }

  return { changed: files.length, staged, unstaged, untracked };
}

export function gitFileBadge(file: GitFile): string {
  if (file.untracked) return "新";
  const staged = file.index !== " " && file.index !== "?";
  const worktree = file.worktree !== " ";
  if (staged && worktree) return `${file.index}${file.worktree}`;
  return staged ? file.index : file.worktree;
}
