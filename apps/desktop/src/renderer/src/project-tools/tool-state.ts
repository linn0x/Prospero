import type { ProjectTool } from "../../../shared/project-tools";

export type PreviewTab = { id: string; path: string; kind: "file" | "diff"; staged: boolean; line: number };
export const tabId = (path: string, kind: "file" | "diff", staged = false): string => JSON.stringify([path, kind, staged]);
export const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
export const parentPath = (path: string): string => path.split("/").slice(0, -1).join("/");
export const formatSize = (size: number): string => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
export function openProjectTools(root: string, mode: ProjectTool = "files"): void {
  window.dispatchEvent(new CustomEvent("prospero:project-tools", { detail: { root, mode } }));
}

type FileRequest = { path: string; line: number };
const fileRequests = new Map<string, FileRequest>();
const fileListeners = new Set<() => void>();
export const getProjectFileRequest = (root: string): FileRequest | undefined => fileRequests.get(root);
export function subscribeProjectFileRequests(listener: () => void): () => void {
  fileListeners.add(listener);
  return () => { fileListeners.delete(listener); };
}
export function openProjectFile(root: string, file: { path: string; line?: number }): void {
  fileRequests.set(root, { path: file.path, line: file.line ?? 0 });
  fileListeners.forEach(listener => listener());
  openProjectTools(root);
}
export function codeLanguage(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", rs: "rust", sh: "bash", ps1: "powershell", md: "markdown", yml: "yaml", h: "c", cs: "csharp", svg: "xml", html: "xml", vue: "xml" } as Record<string, string>)[extension] ?? extension;
}
