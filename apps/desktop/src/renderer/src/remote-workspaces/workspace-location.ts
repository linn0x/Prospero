import type { RemoteDirectoryRoot } from "../../../shared/remote-workspaces";

export type RemoteLocation = { root: RemoteDirectoryRoot; path: string };

export function remoteParentLocation(location: RemoteLocation): RemoteLocation | undefined {
  if (location.path) return { root: location.root, path: location.path.split("/").slice(0, -1).join("/") };
  if (/^[A-Za-z]:$/.test(location.root)) return { root: "computer", path: "" };
  return undefined;
}

export function remoteChildLocation(location: RemoteLocation, name: string): RemoteLocation | undefined {
  if (location.root === "computer") return /^[A-Za-z]:$/.test(name) ? { root: name as RemoteDirectoryRoot, path: "" } : undefined;
  if (!name || name === "." || name === ".." || /[\\/\u0000-\u001f]/.test(name)) return undefined;
  return { root: location.root, path: location.path ? `${location.path}/${name}` : name };
}
