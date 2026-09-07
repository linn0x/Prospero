import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteWorkspaces, RemoteWorkspaceStore, remoteWorkspaceId } from "../src/main/remote-workspaces";
import { normalizedRemoteCwd, remoteDirectoryRequest, type RemoteDirectoryListing, type RemoteDirectoryRequest } from "../src/shared/remote-workspaces";
import type { SessionInfo } from "@prospero/protocol";

const homes: string[] = [];
const faults = vi.hoisted(() => ({ file: "" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: (from: string, to: string) => { if (to === faults.file) throw new Error("write failed"); fs.renameSync(from, to); } };
});
afterEach(() => { faults.file = ""; homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });

function setup() {
  const home = mkdtempSync(join(tmpdir(), "prospero-remote-workspaces-")); homes.push(home);
  const file = join(home, "remote-workspaces.json");
  const store = new RemoteWorkspaceStore(file);
  let paired = true;
  const hosts = { get: (id: string) => paired ? { id, name: "Remote fixture", addrs: ["127.0.0.1"], port: 1, daemonPubKey: "fixture-key", token: "private-pairing-token" } : undefined };
  const sessions = new Map<string, SessionInfo[]>();
  const listWorkspace = vi.fn(async (input: RemoteDirectoryRequest): Promise<RemoteDirectoryListing> => ({ hostId: input.hostId, root: input.root ?? "home", path: input.path ?? "", cwd: `/remote/${input.path || "home"}`, entries: [], supportsRoots: false }));
  const listWorkspaceShells = vi.fn(async (hostId: string, cwd: string) => sessions.get(`${hostId}\0${cwd}`) ?? []);
  const createShell = vi.fn(async (hostId: string, cwd = "/remote/home") => {
    const key = `${hostId}\0${cwd}`;
    const session: SessionInfo = { id: "identical-session-id", agent: "shell", kind: "pty", title: "shell", cwd, status: "running", createdAt: 0 };
    sessions.set(key, [session]);
    return session.id;
  });
  const service = new RemoteWorkspaces(store, hosts, { listWorkspace, listWorkspaceShells, createShell });
  return { file, store, service, listWorkspace, listWorkspaceShells, createShell, sessions, unpair: () => { paired = false; } };
}

describe("remote workspace identity and persistence", () => {
  it("keeps host identity separate from remote paths, including Windows drive roots and POSIX backslashes", () => {
    expect(normalizedRemoteCwd("C:\\")).toBe("C:\\");
    expect(normalizedRemoteCwd("c:/Users/Work/")).toBe("C:\\Users\\Work");
    expect(normalizedRemoteCwd("/home/Foo\\Bar/")).toBe("/home/Foo\\Bar");
    expect(remoteWorkspaceId("host-a", "/workspace/project")).not.toBe(remoteWorkspaceId("host-b", "/workspace/project"));
    expect(remoteWorkspaceId("host", "/workspace/Project")).not.toBe(remoteWorkspaceId("host", "/workspace/project"));
    expect(() => normalizedRemoteCwd("C:relative")).toThrow("absolute");
    expect(() => normalizedRemoteCwd("/workspace/../private")).toThrow("traversal");
  });

  it.each(["../escape", "folder/../../escape", "..\\escape", "/etc", "\\remote\\folder", "folder/./child", "bad\0path"])("rejects an unsafe browser path %s", (path) => {
    expect(() => remoteDirectoryRequest({ hostId: "host", path })).toThrow();
  });

  it("persists only remote metadata and preserves long-directory defaults across restarts", async () => {
    const { service, store, file } = setup();
    const path = "directory-" + "a".repeat(180);
    const workspace = await service.add({ hostId: "host-a", path });
    expect(workspace.name).toHaveLength(80);
    expect(workspace.cwd).toBe(`/remote/${path}`);
    expect(new RemoteWorkspaceStore(file).list()).toEqual([workspace]);
    expect(readFileSync(file, "utf8")).not.toMatch(/private-pairing-token|daemonPubKey|projects|clientKeys/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await service.add({ hostId: "host-a", path });
    expect(store.list()).toHaveLength(1);
    await service.add({ hostId: "host-b", path });
    expect(store.list()).toHaveLength(2);
  });

  it("supports Windows root records without turning C:\\ into drive-relative paths", () => {
    const { store, file } = setup();
    const workspace = store.remember({ hostId: "host", root: "C:", path: "", cwd: "C:\\", entries: [], supportsRoots: true }, "Windows");
    expect(workspace.cwd).toBe("C:\\");
    expect(new RemoteWorkspaceStore(file).get(workspace.id).cwd).toBe("C:\\");
    expect(() => store.remember({ hostId: "host", root: "computer", path: "", cwd: "", entries: [], supportsRoots: true }, "Windows")).toThrow("Select");
  });

  it("round trips a whitespace-only directory basename with a nonempty display name", async () => {
    const { service, file } = setup();
    const workspace = await service.add({ hostId: "host", path: "   " });
    expect(workspace.name.trim()).not.toBe("");
    expect(new RemoteWorkspaceStore(file).get(workspace.id)).toEqual(workspace);
  });

  it("does not overwrite unreadable metadata or publish a failed save", async () => {
    const { store, service, file } = setup();
    const workspace = await service.add({ hostId: "host", path: "work" });
    const before = readFileSync(file, "utf8");
    faults.file = file;
    expect(() => store.rename(workspace.id, "Changed")).toThrow("write failed");
    expect(store.get(workspace.id).name).toBe("work");
    expect(readFileSync(file, "utf8")).toBe(before);
    faults.file = "";
    writeFileSync(file, "malformed");
    const unreadable = new RemoteWorkspaceStore(file);
    expect(() => unreadable.list()).toThrow("preserved");
    expect(readFileSync(file, "utf8")).toBe("malformed");
  });

  it("removes only workspace metadata when forgetting a workspace or paired host", async () => {
    const { service, store, unpair, createShell } = setup();
    const first = await service.add({ hostId: "host-a", path: "first" });
    await service.add({ hostId: "host-a", path: "second" });
    const other = await service.add({ hostId: "host-b", path: "third" });
    expect(store.remove(first.id)).toBe(true);
    store.removeHost("host-a");
    expect(store.list()).toEqual([other]);
    unpair();
    await expect(service.open(other.id)).rejects.toThrow("Pair");
    expect(createShell).not.toHaveBeenCalled();
  });
});

describe("remote workspace shell workflow", () => {
  it("revalidates the saved remote folder before creating and deduplicates the entire opening flow", async () => {
    const { service, createShell, listWorkspace } = setup();
    const workspace = await service.add({ hostId: "host", path: "work" });
    const opened = await Promise.all([service.open(workspace.id, { newSession: true }), service.open(workspace.id, { newSession: true })]);
    expect(opened[0]?.sessionId).toBe("identical-session-id");
    expect(opened[1]).toEqual(opened[0]);
    expect(createShell).toHaveBeenCalledOnce();
    expect(createShell).toHaveBeenCalledWith("host", "/remote/work");
    expect(listWorkspace).toHaveBeenCalledTimes(2);
    await service.open(workspace.id);
    expect(createShell).toHaveBeenCalledOnce();
  });

  it("never treats a same-ID shell on another host as the workspace session", async () => {
    const { service, createShell } = setup();
    const a = await service.add({ hostId: "host-a", path: "work" });
    const b = await service.add({ hostId: "host-b", path: "work" });
    expect((await service.open(a.id)).sessionId).toBe("identical-session-id");
    expect((await service.open(b.id)).sessionId).toBe("identical-session-id");
    expect(createShell.mock.calls).toEqual([["host-a", "/remote/work"], ["host-b", "/remote/work"]]);
  });

  it("rejects a changed remote cwd and unavailable pairing before any shell mutation", async () => {
    const { service, listWorkspace, createShell, unpair } = setup();
    const workspace = await service.add({ hostId: "host", path: "work" });
    listWorkspace.mockResolvedValueOnce({ hostId: "host", root: "home", path: "work", cwd: "/other/folder", entries: [], supportsRoots: false });
    await expect(service.open(workspace.id)).rejects.toThrow("folder changed");
    unpair();
    await expect(service.add({ hostId: "host", path: "work" })).rejects.toThrow("Pair");
    expect(createShell).not.toHaveBeenCalled();
  });

  it("returns a failure without automatic retry when shell creation fails", async () => {
    const { service, createShell } = setup();
    const workspace = await service.add({ hostId: "host", path: "work" });
    createShell.mockRejectedValueOnce(new Error("unconfirmed creation"));
    await expect(service.open(workspace.id)).rejects.toThrow("unconfirmed");
    expect(createShell).toHaveBeenCalledOnce();
  });
});
