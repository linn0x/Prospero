import type { FsEntry } from "@prospero/protocol";

export type ProjectTool = "files" | "search" | "git";
export type ProjectFile = FsEntry;
export type FilePreview = { path: string; content: string; size: number; version: string; kind: "text" | "image" | "binary"; truncated: boolean };
export type SearchMatch = { path: string; line: number; column: number; text: string };
export type SearchResult = { matches: SearchMatch[]; scanned: number; skipped: number; truncated: boolean };
export type ProjectGitFile = { path: string; originalPath?: string; index: string; worktree: string; untracked: boolean };
export type ProjectGitStatus = { branch: string | null; ahead: number; behind: number; files: ProjectGitFile[]; staged: boolean };
export type GitHistoryEntry = { hash: string; subject: string; author: string; date: string };
export type FileMutation = { kind: "create-file" | "create-directory" | "trash"; path: string } | { kind: "rename"; path: string; destination: string } | { kind: "save"; path: string; content: string; version: string };
export type GitMutation = { kind: "stage" | "unstage"; paths: string[] } | { kind: "commit"; message: string };
export type ProjectToolsApi = {
  listProjectFiles(root: string, path: string): Promise<ProjectFile[]>;
  readProjectFile(root: string, path: string): Promise<FilePreview>;
  mutateProjectFile(root: string, mutation: FileMutation): Promise<void>;
  searchProject(root: string, query: string, options: { caseSensitive: boolean; wholeWord: boolean; pathFilter: string }): Promise<SearchResult>;
  cancelProjectSearch(): Promise<void>;
  getProjectGitStatus(root: string): Promise<ProjectGitStatus>;
  getProjectDiff(root: string, path: string, staged: boolean): Promise<string>;
  getProjectGitHistory(root: string): Promise<GitHistoryEntry[]>;
  mutateProjectGit(root: string, mutation: GitMutation): Promise<void>;
};
