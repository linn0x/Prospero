import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RemoteHostStore } from "./remote-host-store";
import type { RemoteShellManager } from "./remote-shell-manager";
import { normalizedRemoteCwd, remoteDirectoryRequest, validRemoteHostId, type RemoteDirectoryListing, type RemoteDirectoryRequest, type RemoteWorkspace, type RemoteWorkspaceInput, type RemoteWorkspaceOpenOptions, type RemoteWorkspaceOpenResult } from "../shared/remote-workspaces";

const LIMIT = 200;

function workspaceName(value: unknown, cwd: string): string {
  if (value === undefined) return ((cwd.split(cwd.startsWith("/") ? "/" : /[\\/]/).filter(Boolean).at(-1) ?? cwd).trim() || cwd.trim()).slice(0, 80);
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("工作区名称应为 1–80 个字符 / Invalid workspace name");
  return value.trim();
}

export function remoteWorkspaceId(hostId: string, cwd: string): string {
  if (!validRemoteHostId(hostId)) throw new Error("远程主机 ID 无效 / Invalid remote host ID");
  return `remote-${createHash("sha256").update(hostId).update("\0").update(normalizedRemoteCwd(cwd)).digest("hex").slice(0, 40)}`;
}

export class RemoteWorkspaceStore {
  private records: RemoteWorkspace[] | undefined;

  constructor(private readonly file: string) {}

  list(): RemoteWorkspace[] {
    this.load();
    return this.records!.map(record => ({ ...record }));
  }

  get(id: string): RemoteWorkspace {
    const workspace = this.list().find(record => record.id === id);
    if (!workspace) throw new Error("远程工作区不存在，请重新添加 / Remote workspace not found");
    return workspace;
  }

  remember(listing: RemoteDirectoryListing, hostName: string, name?: string): RemoteWorkspace {
    const location = remoteDirectoryRequest(listing);
    if (location.root === "computer") throw new Error("请选择一个远程文件夹 / Select a remote folder");
    const cwd = normalizedRemoteCwd(listing.cwd);
    const id = remoteWorkspaceId(location.hostId, cwd);
    const records = this.list();
    const previous = records.find(record => record.id === id);
    if (!previous && records.length >= LIMIT) throw new Error("远程工作区数量已达上限 / Remote workspace limit reached");
    const workspace: RemoteWorkspace = { id, ...location, hostName: hostName.slice(0, 200), cwd, name: name === undefined && previous ? previous.name : workspaceName(name, cwd), createdAt: previous?.createdAt ?? Date.now(), ...(previous?.lastOpenedAt ? { lastOpenedAt: previous.lastOpenedAt } : {}) };
    this.save(previous ? records.map(record => record.id === id ? workspace : record) : [...records, workspace]);
    return { ...workspace };
  }

  rename(id: string, name: string): RemoteWorkspace {
    const workspace = this.get(id);
    const updated = { ...workspace, name: workspaceName(name, workspace.cwd) };
    this.save(this.list().map(record => record.id === id ? updated : record));
    return updated;
  }

  markOpened(id: string): RemoteWorkspace {
    const updated = { ...this.get(id), lastOpenedAt: Date.now() };
    this.save(this.list().map(record => record.id === id ? updated : record));
    return updated;
  }

  remove(id: string): boolean {
    const records = this.list();
    const next = records.filter(record => record.id !== id);
    if (next.length === records.length) return false;
    this.save(next);
    return true;
  }

  removeHost(hostId: string): void {
    const records = this.list();
    const next = records.filter(record => record.hostId !== hostId);
    if (next.length !== records.length) this.save(next);
  }

  private load(): void {
    if (this.records) return;
    if (!existsSync(this.file)) { this.records = []; return; }
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("invalid file");
      const value = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; workspaces?: unknown };
      if (value.version !== 1 || !Array.isArray(value.workspaces) || value.workspaces.length > LIMIT) throw new Error("invalid store");
      const records = value.workspaces.map((input: unknown): RemoteWorkspace => {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid record");
        const row = input as Record<string, unknown>;
        const location = remoteDirectoryRequest(row);
        if (location.root === "computer" || typeof row["cwd"] !== "string" || typeof row["hostName"] !== "string" || row["hostName"].length > 200 ||
            typeof row["createdAt"] !== "number" || !Number.isFinite(row["createdAt"]) || row["createdAt"] < 0 ||
            row["lastOpenedAt"] !== undefined && (typeof row["lastOpenedAt"] !== "number" || !Number.isFinite(row["lastOpenedAt"]) || row["lastOpenedAt"] < 0)) throw new Error("invalid metadata");
        const cwd = normalizedRemoteCwd(row["cwd"]);
        const id = remoteWorkspaceId(location.hostId, cwd);
        if (row["id"] !== id) throw new Error("identity mismatch");
        return { id, ...location, cwd, hostName: row["hostName"], name: workspaceName(row["name"], cwd), createdAt: row["createdAt"], ...(typeof row["lastOpenedAt"] === "number" ? { lastOpenedAt: row["lastOpenedAt"] } : {}) };
      });
      if (new Set(records.map(record => record.id)).size !== records.length) throw new Error("duplicate workspace");
      this.records = records;
    } catch { throw new Error("远程工作区存储无法读取，原文件已保留 / Remote workspace storage is unreadable; the file was preserved"); }
  }

  private save(records: RemoteWorkspace[]): void {
    const contents = JSON.stringify({ version: 1, workspaces: records }) + "\n";
    if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error("远程工作区存储超过大小限制 / Remote workspace storage limit reached");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (existsSync(this.file) && (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink())) throw new Error("远程工作区存储路径无效 / Invalid remote workspace storage path");
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, contents);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.file);
      this.records = records;
      if (process.platform !== "win32") {
        const directory = openSync(dirname(this.file), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}

export class RemoteWorkspaces {
  private readonly opening = new Map<string, Promise<RemoteWorkspaceOpenResult>>();

  constructor(readonly store: RemoteWorkspaceStore, private readonly hosts: Pick<RemoteHostStore, "get">, private readonly shells: Pick<RemoteShellManager, "listWorkspace" | "listWorkspaceShells" | "createShell">) {}

  list(): RemoteWorkspace[] { return this.store.list(); }

  async directories(input: RemoteDirectoryRequest): Promise<RemoteDirectoryListing> {
    const request = remoteDirectoryRequest(input);
    if (!this.hosts.get(request.hostId)) throw new Error("远程主机未配对，请重新配对 / Pair the remote host first");
    return this.shells.listWorkspace(request);
  }

  async add(input: RemoteWorkspaceInput): Promise<RemoteWorkspace> {
    const request = remoteDirectoryRequest(input);
    const host = this.hosts.get(request.hostId);
    if (!host) throw new Error("远程主机未配对，请重新配对 / Pair the remote host first");
    const listing = await this.directories(request);
    if (!this.hosts.get(request.hostId)) throw new Error("远程配对已移除 / Remote pairing was removed");
    return this.store.remember(listing, host.name, input.name);
  }

  async listShells(id: string) {
    const workspace = this.store.get(id);
    if (!this.hosts.get(workspace.hostId)) throw new Error("远程主机未配对，请重新配对 / Pair the remote host first");
    return this.shells.listWorkspaceShells(workspace.hostId, workspace.cwd);
  }

  open(id: string, options: RemoteWorkspaceOpenOptions = {}): Promise<RemoteWorkspaceOpenResult> {
    const previous = this.opening.get(id);
    if (previous) return previous;
    const job = this.openWorkspace(id, options).finally(() => { if (this.opening.get(id) === job) this.opening.delete(id); });
    this.opening.set(id, job);
    return job;
  }

  private async openWorkspace(id: string, options: RemoteWorkspaceOpenOptions): Promise<RemoteWorkspaceOpenResult> {
    const workspace = this.store.get(id);
    const listing = await this.directories(workspace);
    if (normalizedRemoteCwd(listing.cwd) !== workspace.cwd) throw new Error("远程目录已变化，请重新添加此工作区 / Remote folder changed; add this workspace again");
    this.store.get(id);
    const existing = options.newSession ? [] : await this.listShells(id);
    const sessionId = existing[0]?.id ?? await this.shells.createShell(workspace.hostId, workspace.cwd);
    const sessions = await this.listShells(id);
    if (!sessions.some(session => session.id === sessionId && normalizedRemoteCwd(session.cwd) === workspace.cwd)) throw new Error("远程 Shell 未在所选工作区启动，请刷新检查 / Remote shell did not start in the selected workspace");
    return { workspace: this.store.markOpened(id), sessionId };
  }
}
