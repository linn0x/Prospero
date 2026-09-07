import type { WorkspaceListing } from "@prospero/protocol";

export type RemoteDirectoryRoot = "home" | "computer" | `${string}:`;

export type RemoteWorkspace = {
  id: string;
  hostId: string;
  hostName: string;
  cwd: string;
  name: string;
  root: RemoteDirectoryRoot;
  path: string;
  createdAt: number;
  lastOpenedAt?: number;
};

export type RemoteDirectoryRequest = {
  hostId: string;
  root?: RemoteDirectoryRoot;
  path?: string;
};

export type RemoteDirectoryListing = {
  hostId: string;
  root: RemoteDirectoryRoot;
  path: string;
  cwd: string;
  entries: WorkspaceListing["entries"];
  supportsRoots: boolean;
};

export type RemoteWorkspaceInput = RemoteDirectoryRequest & { name?: string };
export type RemoteWorkspaceOpenOptions = { newSession?: boolean };
export type RemoteWorkspaceOpenResult = { workspace: RemoteWorkspace; sessionId: string };

export function validRemoteHostId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

export function remoteDirectoryRequest(value: unknown): Required<RemoteDirectoryRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("远程目录参数无效 / Invalid remote directory request");
  const input = value as Record<string, unknown>;
  if (!validRemoteHostId(input["hostId"])) throw new Error("远程主机 ID 无效 / Invalid remote host ID");
  const root = input["root"] ?? "home";
  if (typeof root !== "string" || root !== "home" && root !== "computer" && !/^[A-Za-z]:$/.test(root)) throw new Error("远程目录根无效 / Invalid remote directory root");
  const rawPath = input["path"] ?? "";
  if (typeof rawPath !== "string" || rawPath.length > 4096 || rawPath.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(rawPath) || rawPath.split("/").some(part => part === ".." || part === ".") || root === "computer" && rawPath !== "") {
    throw new Error("远程目录必须是安全相对路径 / Invalid relative remote directory");
  }
  return { hostId: input["hostId"], root: (root.length === 2 ? root.toUpperCase() : root) as RemoteDirectoryRoot, path: rawPath.split("/").filter(Boolean).join("/") };
}

export function normalizedRemoteCwd(value: string): string {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("远程工作目录无效 / Invalid remote working directory");
  const windows = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  if (!windows && !value.startsWith("/")) throw new Error("远程工作目录必须是绝对路径 / Remote working directory must be absolute");
  const separator = windows ? "\\" : "/";
  const cwd = windows ? value.replace(/\//g, "\\").replace(/^[a-z]:/, drive => drive.toUpperCase()) : value;
  if (cwd.split(separator).some(part => part === ".." || part === ".")) throw new Error("远程工作目录包含路径穿越 / Invalid remote working directory traversal");
  if (windows && /^[A-Z]:\\$/.test(cwd)) return cwd;
  return cwd.replace(windows ? /\\+$/ : /\/+$/, "") || separator;
}
