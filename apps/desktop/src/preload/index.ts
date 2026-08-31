import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopSettings, DesktopSnapshotPatch, JsonObject, SessionCreateInput, SessionPageRequest } from "../shared/types";

const api: DesktopApi = {
  platform: process.platform,
  listNetworkInterfaces: () => ipcRenderer.invoke("network:interfaces"),
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
  setSessionUnread: (sessionId: string, unread: boolean) => ipcRenderer.invoke("session:unread", sessionId, unread),
  renameSession: (sessionId: string, title: string) => ipcRenderer.invoke("session:rename", sessionId, title),
  revealPath: (path: string) => ipcRenderer.invoke("path:reveal", path),
  openWindowsTerminal: (path: string) => ipcRenderer.invoke("path:terminal", path),
  createSession: (input: SessionCreateInput) => ipcRenderer.invoke("session:create", input),
  listSessions: (request?: SessionPageRequest) => ipcRenderer.invoke("sessions:list", request),
  getSessionView: (sessionId: string, query?: Record<string, number>) => ipcRenderer.invoke("session:view", sessionId, query),
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
  saveWorkflowTemplate: (template) => ipcRenderer.invoke("workflow-template:save", template),
  deleteWorkflowTemplate: (templateId: string) => ipcRenderer.invoke("workflow-template:delete", templateId),
  resolveGate: (gateId: string, decision: string) => ipcRenderer.invoke("orchestration:gate", gateId, decision),
  accountAction: (message: JsonObject) => ipcRenderer.invoke("account:action", message),
  pairDevice: (input) => ipcRenderer.invoke("device:pair", input),
  revokeDevice: (name: string) => ipcRenderer.invoke("device:revoke", name),
  relayAction: (input) => ipcRenderer.invoke("relay:action", input),
  updateSettings: (patch: Partial<DesktopSettings>) => ipcRenderer.invoke("settings:update", patch),
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
};

contextBridge.exposeInMainWorld("prospero", Object.freeze(api));
