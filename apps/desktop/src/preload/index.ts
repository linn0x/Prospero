import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopSettings, DesktopSnapshotPatch, JsonObject, SessionCreateInput, SessionPageRequest } from "../shared/types";
import type { WindowAppearance } from "../shared/window-appearance";

// Apply appearance to the shared DOM without granting the renderer another
// native API. Starting opaque also avoids a transparent flash before IPC loads.
let appearance: WindowAppearance | undefined;
function applyAppearance(value: WindowAppearance): void {
  appearance = value;
  if (!document.documentElement) return;
  document.documentElement.dataset["nativeGlass"] = String(value.nativeGlass);
  document.documentElement.dataset["reducedTransparency"] = String(value.reducedTransparency);
  document.documentElement.dataset["highContrast"] = String(value.highContrast);
}
ipcRenderer.on("appearance:changed", (_event, value: WindowAppearance) => applyAppearance(value));
void ipcRenderer.invoke("appearance:get").then(applyAppearance).catch(() => { /* Retain opaque fallback. */ });
document.addEventListener("DOMContentLoaded", () => { if (appearance) applyAppearance(appearance); }, { once: true });

const api: DesktopApi = {
  modelSourceAction: action => ipcRenderer.invoke("model-source:action", action),
  subscribeModelSources: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, sources: Parameters<typeof listener>[0]) => listener(sources);
    ipcRenderer.on("model-source:changed", wrapped);
    return () => ipcRenderer.removeListener("model-source:changed", wrapped);
  },
  platform: process.platform,
  listNetworkInterfaces: () => ipcRenderer.invoke("network:interfaces"),
  openWindowMenu: (request) => ipcRenderer.invoke("window:menu", request),
  openExternal: (url: string) => ipcRenderer.invoke("external:open", url),
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  writeClipboard: (value: string) => ipcRenderer.invoke("clipboard:write", value),
  getSnapshot: () => ipcRenderer.invoke("snapshot:get"),
  subscribeSnapshot(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, patch: DesktopSnapshotPatch): void => listener(patch);
    ipcRenderer.on("snapshot:changed", wrapped);
    return () => ipcRenderer.removeListener("snapshot:changed", wrapped);
  },
  startDaemon: () => ipcRenderer.invoke("daemon:start"),
  stopDaemon: () => ipcRenderer.invoke("daemon:stop"),
  restartDaemon: () => ipcRenderer.invoke("daemon:restart"),
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  forgetProject: (path: string) => ipcRenderer.invoke("project:forget", path),
  renameProject: (path: string, name: string) => ipcRenderer.invoke("project:rename", path, name),
  setProjectPinned: (path: string, pinned: boolean) => ipcRenderer.invoke("project:pin", path, pinned),
  setSessionPinned: (sessionId: string, pinned: boolean) => ipcRenderer.invoke("session:pin", sessionId, pinned),
  setSessionArchived: (sessionId: string, archived: boolean) => ipcRenderer.invoke("session:archive", sessionId, archived),
  setSessionUnread: (sessionId: string, unread: boolean) => ipcRenderer.invoke("session:unread", sessionId, unread),
  renameSession: (sessionId: string, title: string) => ipcRenderer.invoke("session:rename", sessionId, title),
  revealPath: (path: string) => ipcRenderer.invoke("path:reveal", path),
  openWindowsTerminal: (path: string) => ipcRenderer.invoke("path:terminal", path),
  createSession: (input: SessionCreateInput) => ipcRenderer.invoke("session:create", input),
  listSessions: (request?: SessionPageRequest) => ipcRenderer.invoke("sessions:list", request),
  getSessionView: (sessionId: string, query?: Record<string, number>) => ipcRenderer.invoke("session:view", sessionId, query),
  cancelSessionView: (sessionId: string) => ipcRenderer.invoke("session:view:cancel", sessionId),
  interact: (sessionId: string, message: JsonObject) => ipcRenderer.invoke("session:interact", sessionId, message),
  interruptSession: (sessionId: string) => ipcRenderer.invoke("session:interrupt", sessionId),
  killSession: (sessionId: string) => ipcRenderer.invoke("session:kill", sessionId),
  getToolOutput: (sessionId: string, callId: string) => ipcRenderer.invoke("session:tool-output", sessionId, callId),
  getSubagentEvents: (sessionId: string, subagentId: string) => ipcRenderer.invoke("session:subagent", sessionId, subagentId),
  getUsage: (sessionId?: string) => ipcRenderer.invoke("usage:get", sessionId),
  getSkillSuggestions: (sessionId: string, query: string) => ipcRenderer.invoke("session:suggestions", sessionId, query),
  listSkills: (cwd: string) => ipcRenderer.invoke("skills:list", cwd),
  revealSkill: (path: string, cwd: string) => ipcRenderer.invoke("skills:reveal", path, cwd),
  getAgentModes: (sessionId: string) => ipcRenderer.invoke("session:modes", sessionId),
  setAgentMode: (sessionId: string, mode: string) => ipcRenderer.invoke("session:mode:set", sessionId, mode),
  getLaunchModels: (agent, accountId) => ipcRenderer.invoke("launch:models", agent, accountId),
  getAgentModels: (sessionId: string) => ipcRenderer.invoke("session:models", sessionId),
  setAgentModel: (sessionId: string, model: string, effort?: string) => ipcRenderer.invoke("session:model:set", sessionId, model, effort),
  orchestrationAction: (method: string, params: JsonObject) => ipcRenderer.invoke("orchestration:action", method, params),
  getOrchestrationTask: (taskId: string) => ipcRenderer.invoke("orchestration:task", taskId),
  getOrchestrationRunTasks: (runId: string) => ipcRenderer.invoke("orchestration:run-tasks", runId),
  saveWorkflowTemplate: (template) => ipcRenderer.invoke("workflow-template:save", template),
  deleteWorkflowTemplate: (templateId: string) => ipcRenderer.invoke("workflow-template:delete", templateId),
  resolveGate: (gateId: string, decision: string) => ipcRenderer.invoke("orchestration:gate", gateId, decision),
  accountAction: (message: JsonObject) => ipcRenderer.invoke("account:action", message),
  getAccountModels: (input) => ipcRenderer.invoke("account:models", input),
  getAccountConfig: (accountId) => ipcRenderer.invoke("account:config:get", accountId),
  setAccountConfig: (input) => ipcRenderer.invoke("account:config:set", input),
  pairDevice: (input) => ipcRenderer.invoke("device:pair", input),
  revokeDevice: (id: string, name: string) => ipcRenderer.invoke("device:revoke", { id, name }),
  relayAction: (input) => ipcRenderer.invoke("relay:action", input),
  updateSettings: (patch: Partial<DesktopSettings>) => ipcRenderer.invoke("settings:update", patch),
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
  listRemoteHosts: () => ipcRenderer.invoke("remote-host:list"),
  importRemoteHost: (pairingUri: string) => ipcRenderer.invoke("remote-host:import", pairingUri),
  removeRemoteHost: (id: string) => ipcRenderer.invoke("remote-host:remove", id),
  connectRemoteHost: (id: string) => ipcRenderer.invoke("remote-shell:connect", id),
  listRemoteWorkspaces: () => ipcRenderer.invoke("remote-workspace:list"),
  listRemoteDirectories: (input) => ipcRenderer.invoke("remote-workspace:directories", input),
  addRemoteWorkspace: (input) => ipcRenderer.invoke("remote-workspace:add", input),
  forgetRemoteWorkspace: (id: string) => ipcRenderer.invoke("remote-workspace:forget", id),
  renameRemoteWorkspace: (id: string, name: string) => ipcRenderer.invoke("remote-workspace:rename", id, name),
  listRemoteWorkspaceShells: (id: string) => ipcRenderer.invoke("remote-workspace:shells", id),
  openRemoteWorkspace: (id: string, options) => ipcRenderer.invoke("remote-workspace:open", id, options),
  subscribeRemoteWorkspaces: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, workspaces: Parameters<typeof listener>[0]) => listener(workspaces);
    ipcRenderer.on("remote-workspace:changed", wrapped);
    return () => ipcRenderer.removeListener("remote-workspace:changed", wrapped);
  },
  createRemoteShell: (hostId: string, cwd?: string) => ipcRenderer.invoke("remote-shell:create", hostId, cwd),
  listRemoteShells: (hostId: string) => ipcRenderer.invoke("remote-shell:list", hostId),
  attachRemoteShell: (hostId: string, sid: string, ownerId?: string) => ipcRenderer.invoke("remote-shell:attach", hostId, sid, ownerId),
  detachRemoteShell: (hostId: string, sid: string, ownerId?: string) => ipcRenderer.invoke("remote-shell:detach", hostId, sid, ownerId),
  sendRemoteShellInput: (hostId: string, sid: string, dataB64: string, ownerId?: string) => ipcRenderer.invoke("remote-shell:input", hostId, sid, dataB64, ownerId),
  resizeRemoteShell: (hostId: string, sid: string, cols: number, rows: number, ownerId?: string) => ipcRenderer.invoke("remote-shell:resize", hostId, sid, cols, rows, ownerId),
  killRemoteShell: (hostId: string, sid: string) => ipcRenderer.invoke("remote-shell:kill", hostId, sid),
  disconnectRemoteHost: (id: string) => ipcRenderer.invoke("remote-shell:disconnect", id),
  subscribeRemoteShell(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, value: import("../shared/types").RemoteShellEvent): void => listener(value);
    ipcRenderer.on("remote-shell:event", wrapped);
    return () => ipcRenderer.removeListener("remote-shell:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("prospero", Object.freeze(api));
