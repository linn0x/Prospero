import { describe, expect, it } from "vitest";
import { modelSourceResult } from "../src/shared/model-sources";
import {
  deriveNativeBindingPhase,
  deriveSessionLifecyclePhase,
  isReadOnlyTerminalStatus,
  isSessionEndedStatus,
  needsNativeBinding,
} from "../src/shared/session-state";
import { PROSPERO_TERMINAL_THEME } from "../src/shared/terminal-typography";
import {
  reduceModelSourceCatalog,
  type ModelSourceCatalogState,
} from "../src/renderer/src/model-sources/use-model-sources";
import {
  canPasteIntoTerminal,
  deriveTerminalViewPhase,
  isNativeDisconnectedBannerVisible,
  terminalViewHostStateAttr,
} from "../src/renderer/src/terminal-view-state";
import {
  initialSplitLayoutState,
  reduceSplitLayout,
  resolveEffectiveFocusedSessionId,
  resolveSplitPeerId,
} from "../src/renderer/src/workspace/pane-layout-state";

describe("Explicit State Machines (P0 / P1 / P2)", () => {
  describe("P0.1 & P0.2: Session & Native Binding State Machine", () => {
    it("unifies session ended and read-only terminal predicates", () => {
      for (const status of ["completed", "done", "died", "failed", "stopped", "cancelled", "exited", "killed"]) {
        expect(isSessionEndedStatus(status)).toBe(true);
        expect(isReadOnlyTerminalStatus(status)).toBe(true);
        expect(deriveSessionLifecyclePhase({ status }).phase).toBe("ended");
      }
      expect(isSessionEndedStatus("idle")).toBe(false);
      expect(isReadOnlyTerminalStatus("idle")).toBe(true);
      expect(deriveSessionLifecyclePhase({ status: "idle" }).phase).toBe("idle");
      expect(deriveSessionLifecyclePhase({ status: "running" }).phase).toBe("running");
      expect(deriveSessionLifecyclePhase({ status: "waiting_approval" })).toEqual({
        phase: "waiting_user",
        reason: "permission",
      });
    });

    it("derives native binding phases and avoids prompting login or ended sessions", () => {
      expect(
        deriveNativeBindingPhase({
          title: "Codex",
          kind: "pty",
          agent: "codex",
          nativeSession: undefined,
        }),
      ).toEqual({ kind: "unbound", requiresLinkBeforeArchive: true });

      expect(
        deriveNativeBindingPhase({
          title: "Codex",
          kind: "pty",
          agent: "codex",
          nativeSession: { state: "running", nativeId: "conv-1" },
        }),
      ).toEqual({
        kind: "bound",
        state: "running",
        nativeId: "conv-1",
        managed: false,
      });

      expect(
        deriveNativeBindingPhase({
          title: "Codex",
          kind: "pty",
          agent: "codex",
          nativeSession: { state: "binding" },
        }),
      ).toEqual({ kind: "transitioning", state: "binding" });

      expect(
        deriveNativeBindingPhase({
          title: "Codex",
          kind: "pty",
          agent: "codex",
          nativeSession: { state: "archived", nativeId: "conv-1" },
        }),
      ).toEqual({
        kind: "bound",
        state: "archived",
        nativeId: "conv-1",
        managed: false,
      });

      expect(
        deriveNativeBindingPhase({
          title: "Codex",
          kind: "pty",
          agent: "codex",
          nativeSession: { state: "failed", error: "too large" },
        }),
      ).toEqual({ kind: "failed", error: "too large" });

      expect(
        needsNativeBinding({
          title: "Codex · 登录",
          kind: "pty",
          agent: "codex",
          nativeSession: { state: "unbound" },
        }),
      ).toBe(false);

      expect(
        needsNativeBinding({
          title: "Codex",
          kind: "pty",
          agent: "codex",
          nativeSession: { state: "unbound" },
        }),
      ).toBe(true);
    });
  });

  describe("P0.3: ModelSourceCatalogState & Resilient Envelope Parsing", () => {
    it("preserves cached sources during background revalidation and stale errors", () => {
      const sampleSource = {
        id: "glm",
        name: "GLM",
        kind: "glm" as const,
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        protocol: "openai_responses" as const,
        wireApi: "responses" as const,
        defaultCredentialId: "cred-1",
        credentials: [{ id: "cred-1", label: "Default", maskedValue: "sk-***", updatedAt: 1 }],
        models: [
          {
            id: "route-1",
            modelId: "glm-5.3-flash",
            displayName: "glm-5.3-flash",
            wireModel: "glm-5.3-flash",
            protocol: "openai_responses" as const,
            wireApi: "responses" as const,
            enabled: true,
            targetAgents: ["codex" as const, "pi" as const],
            capabilities: ["chat" as const],
          },
        ],
        createdAt: 1,
        updatedAt: 1,
        revision: 3,
      };

      let state: ModelSourceCatalogState = { phase: "loading_initial", sources: [] };
      expect(state.phase).toBe("loading_initial");

      state = reduceModelSourceCatalog(state, { type: "resolve", sources: [sampleSource] });
      expect(state.phase).toBe("ready");
      expect(state.sources).toHaveLength(1);

      // Background window focus revalidation must not blank sources or flip initial loading
      state = reduceModelSourceCatalog(state, { type: "start_request", background: true });
      expect(state.phase).toBe("revalidating");
      expect(state.sources).toHaveLength(1);

      // Transient background error preserves stale sources so NewSessionDialog remains usable
      state = reduceModelSourceCatalog(state, { type: "reject", error: "timeout", background: true });
      expect(state.phase).toBe("stale_error");
      expect(state.sources).toHaveLength(1);
      expect(state.sources[0]?.revision).toBe(3);
    });

    it("tolerates newly added agent accounts in modelSourceResult envelopes", () => {
      const parsed = modelSourceResult({
        type: "model.source.result",
        requestId: "req-1",
        ok: true,
        sources: [],
        accounts: [
          {
            id: "native-agy",
            agent: "agy",
            name: "本机默认环境",
            managed: false,
            isDefault: true,
            status: "signed_in",
            createdAt: 0,
            updatedAt: 0,
            activeSessions: 0,
          },
          {
            id: "future-agent",
            agent: "future_agent_v2",
            name: "Future Agent",
            managed: false,
            isDefault: false,
            status: "signed_in",
            createdAt: 0,
            updatedAt: 0,
            activeSessions: 0,
          },
        ],
      });
      expect(parsed.accounts).toHaveLength(1);
      expect(parsed.accounts?.[0]?.agent).toBe("agy");
    });
  });

  describe("P2.1: TerminalViewPhase State Machine", () => {
    it("transitions cleanly between probing, connecting, observing, controlling, disconnected, and exited", () => {
      const baseState = {
        connected: false,
        syncing: true,
        controller: false,
        readOnly: true,
        exited: false,
      };

      expect(
        deriveTerminalViewPhase({ mode: "pending", sessionStatus: "running", state: baseState }),
      ).toBe("probing");

      expect(
        deriveTerminalViewPhase({ mode: "native", sessionStatus: "running", state: baseState }),
      ).toBe("connecting");

      const observing = deriveTerminalViewPhase({
        mode: "native",
        sessionStatus: "running",
        state: { ...baseState, connected: true, syncing: false, controller: false, readOnly: true },
      });
      expect(observing).toBe("observing");
      expect(canPasteIntoTerminal({ active: true, focused: true, phase: observing })).toBe(false);

      const controlling = deriveTerminalViewPhase({
        mode: "native",
        sessionStatus: "running",
        state: { ...baseState, connected: true, syncing: false, controller: true, readOnly: false },
      });
      expect(controlling).toBe("controlling");
      expect(canPasteIntoTerminal({ active: true, focused: true, phase: controlling })).toBe(true);
      expect(terminalViewHostStateAttr(controlling)).toBe("connected");

      const disconnected = deriveTerminalViewPhase({
        mode: "native",
        sessionStatus: "running",
        state: { ...baseState, connected: false, syncing: false },
      });
      expect(disconnected).toBe("disconnected");
      expect(isNativeDisconnectedBannerVisible(disconnected, undefined)).toBe(true);
      expect(isNativeDisconnectedBannerVisible(disconnected, 42)).toBe(false);

      const exited = deriveTerminalViewPhase({
        mode: "native",
        sessionStatus: "completed",
        state: { ...baseState, connected: true, syncing: false, controller: true, readOnly: false },
      });
      expect(exited).toBe("exited");
      expect(terminalViewHostStateAttr(exited)).toBe("exited");
    });
  });

  describe("P2.2: WorkspaceSplitLayoutState State Machine", () => {
    it("swaps primary and split peer cleanly when activating the split session", () => {
      let state = initialSplitLayoutState("session-a");
      state = reduceSplitLayout(state, { type: "open_split", splitId: "session-b" });
      expect(state.splitId).toBe("session-b");

      // Activating session-b swaps splitId to session-a automatically
      state = reduceSplitLayout(state, { type: "sync_active", activeId: "session-b" });
      expect(state.activeId).toBe("session-b");
      expect(state.splitId).toBe("session-a");
      expect(state.focusedId).toBe("session-b");
      expect(resolveSplitPeerId(state, "session-b")).toBe("session-a");

      // Focusing the split session updates effective focus
      state = reduceSplitLayout(state, { type: "focus_session", sessionId: "session-a" });
      expect(
        resolveEffectiveFocusedSessionId({
          active: true,
          activeId: state.activeId,
          focusedId: state.focusedId,
          splitSessionId: state.splitId,
        }),
      ).toBe("session-a");
    });
  });

  describe("TUI Color Palette", () => {
    it("defines a distinct elevated black and readable brightBlack for TUI borders and dim text", () => {
      expect(PROSPERO_TERMINAL_THEME.background).toBe("#16171a");
      expect(PROSPERO_TERMINAL_THEME.black).not.toBe(PROSPERO_TERMINAL_THEME.background);
      expect(PROSPERO_TERMINAL_THEME.brightBlack).toBe("#7d8597");
    });
  });
});
