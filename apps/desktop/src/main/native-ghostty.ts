import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type WebSocket from "ws";
import type { TerminalSnapshot } from "@prospero/protocol/rust-daemon";
import { TerminalStreamKind, decodeTerminalFrame, encodeTerminalFrame, type TerminalStreamFrame } from "../shared/terminal-stream";
import { NativeRelayDecoder, NativeTerminalQueryFilter } from "./native-terminal-wire";
import { NativeTerminalOperationQueue, type NativeTerminalOperation } from "./native-terminal-operation-queue";
import { TerminalStreamController, type TerminalStreamState } from "../renderer/src/terminal-stream-controller";

type GhosttySurfaceUpdate = { x: number; y: number; width: number; height: number; visible: boolean; focus?: boolean; preserveGrid?: boolean };

export type NativeGhosttyAddon = {
  initialize(configPath: string, resourcePath: string): void;
  shutdown?(): void;
  create(nativeWindowHandle: Buffer, command: string, options: { fontSize: number; fontFamily?: string; configPath?: string }): number;
  update(id: number, bounds: GhosttySurfaceUpdate): void;
  destroy(id: number): void;
  size?(id: number): { columns: number; rows: number; width: number; height: number; cellWidth: number; cellHeight: number };
  setGrid?(id: number, columns: number, rows: number): void;
  setShortcutHandler?(handler: (action: string, id: number) => void): void;
  bindingAction?(id: number, action: string): boolean;
  setFocusHandler?(handler: (id: number, focused: boolean) => void): void;
  setReadOnly?(id: number, readOnly: boolean): void;
  setPasteImageHandler?(handler: (id: number) => boolean): void;
  inputText?(id: number, text: string): void;
  readText?(id: number, viewport?: boolean): string;
};

type NativeSession = {
  id: number;
  contentsId: number;
  sessionId: string;
  directory: string;
  socketPath: string;
  server: Server;
  peer?: Socket;
  relayPeerPromise: Promise<Socket>;
  resolveRelayPeer: (peer: Socket) => void;
  rejectRelayPeer: (error: Error) => void;
  preSurfaceBuffers: Buffer[];
  preSurfaceBytes: number;
  relayConnectTimer?: ReturnType<typeof setTimeout>;
  decoder: NativeRelayDecoder;
  filter: NativeTerminalQueryFilter;
  nextOutputId: number;
  pendingAcks: Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  controller?: TerminalStreamController;
  operations: NativeTerminalOperationQueue;
  controllerState: TerminalStreamState;
  controllerAttached: boolean;
  committedCursor?: number;
  renderedThrough?: number;
  consuming: number;
  reconcilingResize: boolean;
  epoch?: string;
  hasRenderedOutput: boolean;
  needsColdReset: boolean;
  readOnlyInputFailureNotified: boolean;
  streamSocket?: WebSocket;
  streamGeneration: number;
  suspended: boolean;
  suspendTimer?: ReturnType<typeof setTimeout>;
  wantControl: boolean;
  bounds: Omit<GhosttySurfaceUpdate, "focus" | "preserveGrid">;
  surfacePhase: "pre_surface" | "mounted";
  pendingError?: string;
  surfaceReady: boolean;
  daemonGrid?: { columns: number; rows: number };
  desiredGrid?: { columns: number; rows: number };
  resizeRequestActive: boolean;
  busyInputNotified: boolean;
  inputQueueFullNotified: boolean;
  resizeRetryTimer?: ReturnType<typeof setTimeout>;
  closing: boolean;
};

const ACK_TIMEOUT_MS = 30_000;
const MAX_NATIVE_CHUNK = 48 * 1024;
const MAX_PENDING_STREAM_BYTES = 256 * 1024;
export const HIDDEN_STREAM_SUSPEND_DELAY_MS = 30_000;
const require = createRequire(import.meta.url);

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function abortError(): Error { return new Error("Native terminal open was cancelled because its window is closing or reloading"); }

export function surfaceCommand(relayPath: string, socketPath: string): string {
  if (!/\s/.test(relayPath) && !/\s/.test(socketPath)) {
    return `direct:${relayPath} ${socketPath}`;
  }
  return `/bin/sh -c ${shellQuote(`exec ${shellQuote(relayPath)} ${shellQuote(socketPath)}`)}`;
}

export function parseFontFamilies(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Native terminal font family is invalid");
  const tokens = value.match(/(?:"[^"]*"|'[^']*'|[^,]+)/g) ?? [];
  const families: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const unquoted = trimmed
      .replace(/^(?:"(.*)"|'(.*)')$/, (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined) => doubleQuoted ?? singleQuoted ?? "")
      .trim();
    if (!unquoted || unquoted.length > 200 || /[\u0000-\u001f\u007f]/.test(unquoted)) {
      throw new Error("Native terminal font family is invalid");
    }
    if (!seen.has(unquoted)) {
      seen.add(unquoted);
      families.push(unquoted);
    }
  }
  if (!families.length) throw new Error("Native terminal font family is invalid");
  return families;
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const abort = (): void => rejectOperation(abortError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolveOperation(value); }, error => { signal.removeEventListener("abort", abort); rejectOperation(error); });
  });
}

function nativeBundlePath(): string | undefined {
  if (process.env["PROSPERO_NATIVE_GHOSTTY_DIR"]) return resolve(process.env["PROSPERO_NATIVE_GHOSTTY_DIR"]);
  return typeof process.resourcesPath === "string" ? resolve(process.resourcesPath, "native-ghostty") : undefined;
}

function developmentBundlePath(appPath: string): string { return resolve(appPath, ".native", "ghostty"); }

/** Owns the Ghostty NSViews and bridges their PTY relay to existing daemon sessions. */
export class NativeGhosttyManager {
  private addon: NativeGhosttyAddon | undefined;
  private addonAttempted = false;
  private readonly sessions = new Map<number, NativeSession>();
  private readonly surfacesByContents = new Map<number, Set<number>>();
  private readonly pendingOpens = new Map<number, Set<AbortController>>();

  constructor(
    private readonly appPath: string,
    private readonly openSocket: (sessionId: string) => WebSocket,
    private readonly supportsSession: (sessionId: string) => Promise<boolean>,
    private readonly onState: (id: number, state: TerminalStreamState) => void,
    private readonly onError: (id: number, message: string) => void,
    private readonly publishShortcut: (id: number, action: "toggle-focus" | "project-search" | "terminal-search") => void,
    private readonly publishFocus: (id: number, focused: boolean) => void,
    private readonly publishPasteImage: (id: number) => boolean,
    private readonly addonOverride?: NativeGhosttyAddon,
    private readonly readSnapshot?: (sessionId: string) => Promise<TerminalSnapshot | null>,
  ) {}

  private publishState(session: NativeSession): void {
    if (session.closing || session.surfacePhase !== "mounted") return;
    this.onState(session.id, session.controllerState);
  }

  private publishError(session: NativeSession, message: string): void {
    if (session.closing) return;
    if (session.surfacePhase !== "mounted") {
      session.pendingError = message;
      return;
    }
    this.onError(session.id, message);
  }

  availability(): { available: boolean; reason?: string } {
    if (process.env["PROSPERO_NATIVE_GHOSTTY"] === "0") return { available: false, reason: "Native Ghostty is disabled" };
    if (this.addonOverride) {
      try { this.loadAddon(); return { available: true }; }
      catch (error) { return { available: false, reason: error instanceof Error ? error.message : "Native Ghostty could not be loaded" }; }
    }
    if (process.platform !== "darwin") return { available: false, reason: "Native Ghostty is available on macOS only" };
    const bundle = this.bundle();
    if (!bundle || !existsSync(join(bundle, "ghostty.node")) || !existsSync(join(bundle, "prospero-terminal-relay"))) {
      return { available: false, reason: "Native Ghostty resources are not installed" };
    }
    try { this.loadAddon(); }
    catch (error) { return { available: false, reason: error instanceof Error ? error.message : "Native Ghostty could not be loaded" }; }
    return { available: true };
  }

  open(window: BrowserWindow, contentsId: number, sessionId: string, fontSize: number, requestedFontFamily?: string): Promise<number> {
    const controller = new AbortController();
    const pending = this.pendingOpens.get(contentsId) ?? new Set<AbortController>();
    pending.add(controller); this.pendingOpens.set(contentsId, pending);
    return this.openInternal(window, contentsId, sessionId, fontSize, requestedFontFamily, controller.signal).finally(() => {
      const active = this.pendingOpens.get(contentsId);
      active?.delete(controller);
      if (!active?.size) this.pendingOpens.delete(contentsId);
    });
  }

  private waitForNativeAck(session: NativeSession, bytes: Uint8Array): Promise<void> {
    if (!bytes.byteLength) return Promise.resolve();
    const ackId = session.nextOutputId++;
    if (session.nextOutputId > 0xffff_ffff) session.nextOutputId = 1;
    const payload = Buffer.allocUnsafe(4 + bytes.byteLength);
    payload.writeUInt32BE(ackId, 0);
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(payload, 4);
    const header = Buffer.allocUnsafe(5);
    header[0] = "O".charCodeAt(0); header.writeUInt32BE(payload.byteLength, 1);
    return session.relayPeerPromise.then(peer => new Promise<void>((resolveAck, rejectAck) => {
      if (session.closing || peer.destroyed) { rejectAck(new Error("Native terminal relay disconnected")); return; }
      const timer = setTimeout(() => { session.pendingAcks.delete(ackId); rejectAck(new Error("Native terminal relay acknowledgement timed out")); }, ACK_TIMEOUT_MS);
      timer.unref?.(); session.pendingAcks.set(ackId, { resolve: resolveAck, reject: rejectAck, timer });
      try {
        peer.write(Buffer.concat([header, payload]), error => {
          if (!error) return;
          const pending = session.pendingAcks.get(ackId); if (!pending) return;
          clearTimeout(pending.timer); session.pendingAcks.delete(ackId); pending.reject(error);
        });
      } catch (error) {
        clearTimeout(timer); session.pendingAcks.delete(ackId); rejectAck(error instanceof Error ? error : new Error(String(error)));
      }
    }));
  }

  private async connectStream(session: NativeSession, signal?: AbortSignal): Promise<void> {
    const generation = ++session.streamGeneration;
    const resuming = session.committedCursor !== undefined && session.epoch !== undefined;
    session.controllerAttached = false;
    if (!resuming) session.filter.reset();

    const streamSocket = this.openSocket(session.sessionId);
    session.streamSocket = streamSocket;

    try {
      await new Promise<void>((resolveOpen, rejectOpen) => {
        if (signal?.aborted) {
          try { streamSocket.terminate?.(); streamSocket.close(); } catch {}
          rejectOpen(abortError());
          return;
        }
        const timer = setTimeout(() => rejectOpen(new Error("Terminal stream connection timed out")), 7_000);
        timer.unref?.();
        const cleanup = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        const abort = (): void => {
          cleanup();
          try { streamSocket.terminate?.(); streamSocket.close(); } catch {}
          rejectOpen(abortError());
        };
        streamSocket.once("open", () => { cleanup(); resolveOpen(); });
        streamSocket.once("error", error => { cleanup(); rejectOpen(error); });
        streamSocket.once("close", () => { cleanup(); rejectOpen(new Error("Terminal stream closed before attach")); });
        signal?.addEventListener("abort", abort, { once: true });
      });
    } catch (error) {
      if (session.closing || session.streamGeneration !== generation) {
        try { streamSocket.terminate?.(); streamSocket.close(); } catch {}
        return;
      }
      if (signal) throw error;
      this.failSession(session.id, error instanceof Error ? error.message : String(error));
      return;
    }

    if (session.closing || session.streamGeneration !== generation) {
      try { streamSocket.terminate?.(); streamSocket.close(); } catch {}
      return;
    }

    const consume = async (frame: TerminalStreamFrame): Promise<void> => {
      session.consuming += 1;
      try { await consumeFrame(frame); }
      finally {
        session.consuming -= 1;
        if (session.reconcilingResize) {
          session.reconcilingResize = false;
          if (!session.closing && session.streamGeneration === generation) {
            const state = session.controllerState;
            this.setReadOnly(session, session.suspended || !state.connected || state.syncing || !state.controller || state.exited);
          }
        }
      }
    };
    const consumeFrame = async (frame: TerminalStreamFrame): Promise<void> => {
      if (session.closing || session.streamGeneration !== generation) return;
      if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") process.stderr.write(`[native-ghostty] stream frame kind=${frame.kind} seq=${frame.sequence} bytes=${frame.payload.byteLength}\n`);
      // An HTTP checkpoint can be ahead of the stream. Acknowledge the
      // covered frames normally, but never paint their bytes a second time.
      if (session.renderedThrough !== undefined && frame.sequence <= session.renderedThrough) {
        session.committedCursor = frame.sequence;
        return;
      }
      if (frame.kind === TerminalStreamKind.Resize) {
        if (this.readSnapshot) {
          session.reconcilingResize = true;
          this.setReadOnly(session, true);
          const snapshot = await this.readSnapshot(session.sessionId);
          if (session.closing || session.streamGeneration !== generation) return;
          if (snapshot && snapshot.seq >= frame.sequence) {
            this.setAuthoritativeGrid(session, snapshot.size.cols, snapshot.size.rows);
            session.filter.reset();
            const bytes = Buffer.concat([Buffer.from("\x1bc", "binary"), session.filter.push(Buffer.from(snapshot.dataB64, "base64"))]);
            for (let offset = 0; offset < bytes.length; offset += MAX_NATIVE_CHUNK) {
              if (session.closing || session.streamGeneration !== generation) return;
              await this.waitForNativeAck(session, bytes.subarray(offset, offset + MAX_NATIVE_CHUNK));
            }
            session.renderedThrough = snapshot.seq;
            session.committedCursor = frame.sequence;
            return;
          }
        }
        const size = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        this.setAuthoritativeGrid(session, size.getUint16(0, false), size.getUint16(2, false));
        session.committedCursor = frame.sequence;
        return;
      }
      if (frame.kind !== TerminalStreamKind.Snapshot && frame.kind !== TerminalStreamKind.Output) return;
      const resetScreen = frame.kind === TerminalStreamKind.Snapshot || session.needsColdReset;
      if (resetScreen) session.filter.reset();
      const content = session.filter.push(frame.payload);
      const filtered = resetScreen
        ? Buffer.concat([Buffer.from("\x1bc", "binary"), content])
        : content;
      session.needsColdReset = false;
      for (let offset = 0; offset < filtered.byteLength; offset += MAX_NATIVE_CHUNK) {
        if (session.closing || session.streamGeneration !== generation) return;
        await this.waitForNativeAck(session, filtered.subarray(offset, Math.min(filtered.byteLength, offset + MAX_NATIVE_CHUNK)));
      }
      if (session.closing || session.streamGeneration !== generation) return;
      session.hasRenderedOutput = true;
      session.committedCursor = frame.sequence;
    };

    let streamFailure: string | undefined;
    const terminalController = new TerminalStreamController({
      sessionId: session.sessionId,
      cursor: () => session.committedCursor,
      epoch: () => session.epoch,
      wantControl: session.wantControl,
      renderedThrough: () => session.renderedThrough,
      consume,
      onHello: ({ cols, rows }) => {
        if (session.closing || session.streamGeneration !== generation) return;
        if (!resuming) {
          this.setAuthoritativeGrid(session, cols, rows);
        }
      },
      onState: state => {
        if (session.closing || session.streamGeneration !== generation) return;
        const wasSyncing = session.controllerState.syncing;
        session.controllerState = state;
        if (state.epoch) session.epoch = state.epoch;
        if (state.connected && !state.syncing && session.committedCursor === undefined) {
          session.committedCursor = 0;
        }
        if (state.connected) session.wantControl = state.controller;
        if (session.surfaceReady) this.setReadOnly(session, !state.connected || !state.controller || state.exited);
        if (state.connected && state.controller && !state.exited) session.readOnlyInputFailureNotified = false;
        if (state.connected && state.controller && !state.exited) this.flushResizeRequest(session);
        if (wasSyncing && state.connected && !state.syncing) this.restoreSurfaceBounds(session);
        if (!session.bounds.visible && state.connected && !state.syncing && !state.exited) {
          this.scheduleSuspendIfHidden(session);
        }
        this.publishState(session);
      },
      onError: message => {
        if (session.closing || session.streamGeneration !== generation) return;
        streamFailure = message;
        this.publishError(session, message);
      },
      onHistoryGap: message => {
        if (session.closing || session.streamGeneration !== generation) return;
        streamFailure = message;
        if (resuming) {
          delete session.committedCursor;
          delete session.renderedThrough;
          delete session.epoch;
          session.needsColdReset = session.hasRenderedOutput;
          session.controllerState = {
            ...session.controllerState,
            syncing: true,
            readOnly: true,
            controller: false,
          };
          this.publishState(session);
          const reconnect = this.connectStream(session);
          try { streamSocket.close(); } catch {}
          void reconnect;
          return;
        }
        this.publishError(session, message);
      },
    });
    session.controller = terminalController;

    const controllerPortLike = {
      onmessage: undefined as ((event: MessageEvent) => void) | null | undefined,
      onmessageerror: undefined as ((event: MessageEvent) => void) | null | undefined,
      start: () => { session.controllerAttached = true; },
      close: () => {
        if (session.streamGeneration !== generation) return;
        if (streamSocket.readyState === 1) streamSocket.close();
      },
      postMessage: (value: unknown) => {
        if (session.closing || session.streamGeneration !== generation) return;
        if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error("Invalid terminal stream client frame");
        if (streamSocket.bufferedAmount > MAX_PENDING_STREAM_BYTES) throw new Error("Terminal stream input queue is full");
        const frame = decodeTerminalFrame(value as ArrayBuffer | ArrayBufferView, "client");
        if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") process.stderr.write(`[native-ghostty] client frame kind=${frame.kind} seq=${frame.sequence} bytes=${frame.payload.byteLength}\n`);
        streamSocket.send(Buffer.from(encodeTerminalFrame(frame)), error => {
          if (error && !session.closing && session.streamGeneration === generation) {
            this.failSession(session.id, `Terminal stream write failed: ${error.message}`);
          }
        });
      },
    };

    streamSocket.on("message", raw => {
      if (session.closing || session.streamGeneration !== generation || !session.controllerAttached) return;
      try {
        const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        controllerPortLike.onmessage?.({ data: bytes } as MessageEvent);
      } catch {
        this.failSession(session.id, "Terminal stream frame could not be forwarded to Ghostty");
      }
    });
    streamSocket.on("error", error => {
      if (session.closing || session.streamGeneration !== generation) return;
      this.failSession(session.id, `Terminal stream error: ${error.message}`);
    });
    streamSocket.on("close", (code, reason) => {
      if (session.closing || session.streamGeneration !== generation) return;
      if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") {
        let nativeOutput = "";
        try { nativeOutput = this.loadAddon().readText?.(session.id) ?? ""; }
        catch (error) { nativeOutput = `readText failed: ${error instanceof Error ? error.message : String(error)}`; }
        process.stderr.write(`[native-ghostty] websocket closed code=${code} reason=${reason.toString("utf8")} peer=${Boolean(session.peer && !session.peer.destroyed)} queuedRelayBytes=${session.preSurfaceBytes}\n${nativeOutput.slice(-2000)}\n`);
      }
      const closeMessage = streamFailure ?? `Terminal stream closed unexpectedly (code ${code}${reason.byteLength ? `: ${reason.toString("utf8").slice(0, 256)}` : ""})`;
      if (terminalController.hasExit()) {
        void terminalController.finishCleanExit().then(cleanExit => {
          if (session.closing || session.streamGeneration !== generation) return;
          if (!cleanExit) {
            this.failSession(session.id, closeMessage);
            return;
          }
          delete session.controller;
          delete session.streamSocket;
          session.controllerAttached = false;
          session.controllerState = {
            ...session.controllerState,
            connected: false,
            syncing: false,
            controller: false,
            exited: true,
            readOnly: true,
          };
          if (session.surfaceReady) {
            this.setReadOnly(session, true);
            this.restoreSurfaceBounds(session);
          }
          this.publishState(session);
        });
        return;
      }
      this.failSession(session.id, closeMessage);
    });

    terminalController.attach(controllerPortLike as unknown as MessagePort);
    session.controllerAttached = true;
  }

  private scheduleSuspendIfHidden(session: NativeSession): void {
    if (session.closing || session.bounds.visible || session.suspended || session.suspendTimer || session.controllerState.exited) {
      return;
    }
    session.suspendTimer = setTimeout(() => {
      delete session.suspendTimer;
      // Older hosts cannot make checkpoints. Keep their bounded, live stream
      // attached instead of disconnecting into an unrecoverable history gap.
      if (this.readSnapshot) {
        void this.readSnapshot(session.sessionId).then(snapshot => {
          if (snapshot) this.suspendStream(session);
        }).catch(() => { /* Keep a working attachment on a transient read failure. */ });
      } else this.suspendStream(session);
    }, HIDDEN_STREAM_SUSPEND_DELAY_MS);
    session.suspendTimer.unref?.();
  }

  private suspendStream(session: NativeSession): void {
    if (
      session.closing ||
      session.bounds.visible ||
      session.suspended ||
      session.surfacePhase !== "mounted" ||
      !session.controllerState.connected ||
      session.controllerState.syncing ||
      session.controllerState.exited
    ) {
      return;
    }

    // The relay may still be consuming a frame. Closing now would preserve
    // the old cursor and replay already-written bytes on the next attachment.
    if (session.consuming || session.pendingAcks.size) {
      this.scheduleSuspendIfHidden(session);
      return;
    }
    session.wantControl = session.controllerState.controller || session.wantControl;
    session.streamGeneration += 1;
    session.suspended = true;
    session.controllerAttached = false;

    if (session.resizeRetryTimer) {
      clearTimeout(session.resizeRetryTimer);
      delete session.resizeRetryTimer;
    }
    session.operations.cancelPendingResizes();

    const oldController = session.controller;
    const oldSocket = session.streamSocket;
    delete session.controller;
    delete session.streamSocket;
    oldController?.close();
    try { oldSocket?.close(); } catch {}

    // Keep connected: true so NativeTerminalPane retains the hidden surface
    // without triggering teardown or auto-reconnect while suspended.
    session.controllerState = {
      ...session.controllerState,
      connected: true,
    };
    if (session.surfaceReady) this.setReadOnly(session, true);
  }

  private async openInternal(window: BrowserWindow, contentsId: number, sessionId: string, fontSize: number, requestedFontFamily: string | undefined, signal: AbortSignal): Promise<number> {
    const availability = this.availability();
    if (!availability.available) throw new Error(availability.reason ?? "Native Ghostty is unavailable");
    if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 40) throw new Error("Invalid native terminal font size");
    const fontFamilies = parseFontFamilies(requestedFontFamily);
    const primaryFontFamily = fontFamilies?.[0];
    if (!(await waitForAbortable(this.supportsSession(sessionId), signal))) throw new Error("This Rust daemon session does not support terminal streaming");
    if (signal.aborted || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.id !== contentsId) throw abortError();

    const addon = this.loadAddon();
    const bundle = this.bundle();
    const directory = mkdtempSync(join(tmpdir(), `prospero-ghostty-${randomUUID().slice(0, 8)}-`));
    chmodSync(directory, 0o700);
    const socketPath = join(directory, "relay.sock");
    const configPath = join(directory, "ghostty.conf");
    const server = createServer();
    let id: number | undefined;
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.removeListener("error", reject); resolveListen(); });
      });
      if (signal.aborted || window.isDestroyed() || window.webContents.isDestroyed()) throw abortError();
      chmodSync(socketPath, 0o600);

      const baseConfig = bundle && existsSync(join(bundle, "config"))
        ? readFileSync(join(bundle, "config"), "utf8")
        : "";
      let surfaceConfig = baseConfig;
      const fontSizeLine = `font-size = ${fontSize}`;
      surfaceConfig = /^\s*font-size\s*=.*$/m.test(surfaceConfig)
        ? surfaceConfig.replace(/^\s*font-size\s*=.*$/m, fontSizeLine)
        : `${surfaceConfig.trimEnd()}\n${fontSizeLine}\n`;
      if (fontFamilies?.length) {
        const fontLines = [
          'font-family = ""',
          ...fontFamilies.map(family => `font-family = "${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`),
        ].join("\n");
        if (/^\s*font-family\s*=.*$/m.test(surfaceConfig)) {
          let replaced = false;
          surfaceConfig = surfaceConfig.replace(/^\s*font-family\s*=.*$/gm, () => {
            if (replaced) return "";
            replaced = true;
            return fontLines;
          }).replace(/\n{3,}/g, "\n\n");
        } else {
          surfaceConfig = `${surfaceConfig.trimEnd()}\n${fontLines}\n`;
        }
      }
      for (const trigger of ["shift+enter", "shift+numpad_enter"]) {
        const pattern = new RegExp(`^\\s*keybind\\s*=\\s*${trigger.replace("+", "\\+")}\\s*=`, "m");
        if (!pattern.test(surfaceConfig)) {
          surfaceConfig = `${surfaceConfig.trimEnd()}\nkeybind = ${trigger}=csi:13;2u\n`;
        }
      }
      writeFileSync(configPath, surfaceConfig, { encoding: "utf8", mode: 0o600, flag: "wx" });

      const ghosttySessionId = Number.parseInt(randomUUID().slice(0, 8), 16) || 1;
      const queryFilter = new NativeTerminalQueryFilter();
      const pendingAcks = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      let resolveRelayPeer!: (peer: Socket) => void;
      let rejectRelayPeer!: (error: Error) => void;
      const relayPeerPromise = new Promise<Socket>((resolvePeer, rejectPeer) => { resolveRelayPeer = resolvePeer; rejectRelayPeer = rejectPeer; });
      void relayPeerPromise.catch(() => undefined);

      let sessionRef: NativeSession | undefined;
      const operations = new NativeTerminalOperationQueue((operation: NativeTerminalOperation) => {
        const currentController = sessionRef?.controller;
        if (!currentController) return Promise.reject(new Error("Terminal stream is suspended"));
        if (operation.kind === "input") return currentController.input(operation.bytes);
        return currentController.resize(operation.columns, operation.rows);
      });

      const session: NativeSession = {
        id: ghosttySessionId,
        contentsId,
        sessionId,
        directory,
        socketPath,
        server,
        decoder: new NativeRelayDecoder(),
        relayPeerPromise,
        resolveRelayPeer,
        rejectRelayPeer,
        preSurfaceBuffers: [],
        preSurfaceBytes: 0,
        filter: queryFilter,
        nextOutputId: 1,
        pendingAcks,
        operations,
        controllerState: { connected: false, syncing: true, readOnly: true, exited: false, controller: false },
        controllerAttached: false,
        hasRenderedOutput: false,
        consuming: 0,
        reconcilingResize: false,
        needsColdReset: false,
        readOnlyInputFailureNotified: false,
        streamGeneration: 0,
        suspended: false,
        wantControl: true,
        resizeRequestActive: false,
        busyInputNotified: false,
        inputQueueFullNotified: false,
        bounds: { x: 0, y: 0, width: 0, height: 0, visible: true },
        closing: false,
        surfacePhase: "pre_surface",
        surfaceReady: false,
      };
      id = ghosttySessionId;
      sessionRef = session;
      this.sessions.set(ghosttySessionId, session);
      const owned = this.surfacesByContents.get(contentsId) ?? new Set<number>();
      owned.add(ghosttySessionId);
      this.surfacesByContents.set(contentsId, owned);

      const processRelayData = (bytes: Buffer): void => {
        try {
          for (const frame of session.decoder.push(bytes)) {
            if (frame.kind === "I") {
              if (session.suspended || session.reconcilingResize || !session.controllerState.connected || !session.controllerState.controller || session.controllerState.exited) {
                if (!session.readOnlyInputFailureNotified) {
                  session.readOnlyInputFailureNotified = true;
                  this.publishError(session, "Terminal input is disabled while this session is read-only");
                }
              } else void session.operations.enqueueInput(frame.payload).then(() => {
                session.busyInputNotified = false;
                session.inputQueueFullNotified = false;
              }).catch(error => {
                if (session.closing) return;
                const message = error instanceof Error ? error.message : String(error);
                if (/\bbusy\b/i.test(message)) {
                  if (session.busyInputNotified) return;
                  session.busyInputNotified = true;
                  this.publishError(session, "The terminal was busy; this input was not accepted or replayed. Send it again when ready.");
                  return;
                }
                if (/operation queue is full/i.test(message)) {
                  if (session.inputQueueFullNotified) return;
                  session.inputQueueFullNotified = true;
                  this.publishError(session, "The terminal input queue is full; this input was not accepted. Wait, then send it again.");
                  return;
                }
                this.publishError(session, message);
              });
            } else if (frame.kind === "R") {
              const cols = frame.payload.readUInt16BE(0), rows = frame.payload.readUInt16BE(2);
              this.requestResize(session, cols, rows);
            } else if (frame.kind === "A") {
              const ackId = frame.payload.readUInt32BE(0);
              const pending = session.pendingAcks.get(ackId);
              if (!pending) throw new Error("Unknown native terminal output acknowledgement");
              clearTimeout(pending.timer); session.pendingAcks.delete(ackId); pending.resolve();
            }
          }
        } catch (error) { this.failSession(session.id, error instanceof Error ? error.message : String(error)); }
      };

      server.on("connection", peer => {
        if (session.peer || session.closing) { peer.destroy(); return; }
        if (session.relayConnectTimer) { clearTimeout(session.relayConnectTimer); delete session.relayConnectTimer; }
        session.peer = peer;
        session.resolveRelayPeer(peer);
        peer.on("data", chunk => {
          if (!session.surfaceReady) {
            session.preSurfaceBytes += chunk.byteLength;
            if (session.preSurfaceBytes > 64 * 1024) { peer.destroy(new Error("Native relay sent too much data before surface setup")); return; }
            session.preSurfaceBuffers.push(Buffer.from(chunk));
            return;
          }
          processRelayData(Buffer.from(chunk));
        });
        peer.on("error", error => this.failSession(session.id, `Native relay error: ${error.message}`));
        peer.on("close", () => { if (!session.closing) this.failSession(session.id, "Native relay process exited or disconnected"); });
      });

      // The daemon expects Attach promptly after the websocket opens. Ghostty
      // surface creation can block on Metal initialization, so attach before it.
      await this.connectStream(session, signal);
      if (signal.aborted || window.isDestroyed() || window.webContents.isDestroyed()) throw abortError();

      const relayPath = join(bundle ?? this.appPath, "prospero-terminal-relay");
      const command = surfaceCommand(relayPath, socketPath);
      const surfaceId = addon.create(window.getNativeWindowHandle(), command, { fontSize, ...(primaryFontFamily ? { fontFamily: primaryFontFamily } : {}), configPath });
      // The NSView identifier is public IPC identity; remap the internal relay/controller id.
      if (!Number.isSafeInteger(surfaceId) || surfaceId <= 0 || (surfaceId !== ghosttySessionId && this.sessions.has(surfaceId))) {
        try { addon.destroy(surfaceId); } catch {}
        throw new Error("Native Ghostty returned an invalid or duplicate surface id");
      }
      if (surfaceId !== ghosttySessionId) {
        this.sessions.delete(ghosttySessionId); owned.delete(ghosttySessionId);
        session.id = surfaceId; this.sessions.set(surfaceId, session); owned.add(surfaceId);
        id = surfaceId;
      }
      session.surfacePhase = "mounted";
      session.surfaceReady = true;
      this.setReadOnly(session, !session.controllerState.connected || !session.controllerState.controller || session.controllerState.exited);
      if (!session.peer) {
        session.relayConnectTimer = setTimeout(() => {
          delete session.relayConnectTimer;
          if (!session.peer && !session.closing) {
            if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") {
              let nativeOutput = "", nativeSize: unknown;
              try { nativeOutput = this.loadAddon().readText?.(session.id) ?? ""; nativeSize = this.loadAddon().size?.(session.id); }
              catch (error) { nativeOutput = `native inspection failed: ${error instanceof Error ? error.message : String(error)}`; }
              process.stderr.write(`[native-ghostty] relay timeout surface=${session.id} socketExists=${existsSync(session.socketPath)} size=${JSON.stringify(nativeSize)}\n${nativeOutput.slice(-2000)}\n`);
            }
            this.failSession(session.id, "Native terminal relay did not connect in time");
          }
        }, 7_000);
        session.relayConnectTimer.unref?.();
      }
      if (session.peer && session.preSurfaceBuffers.length) {
        for (const bytes of session.preSurfaceBuffers.splice(0)) processRelayData(bytes);
        session.preSurfaceBytes = 0;
      }
      if (session.daemonGrid) this.setAuthoritativeGrid(session, session.daemonGrid.columns, session.daemonGrid.rows);
      this.publishState(session);
      if (session.pendingError !== undefined) {
        const pendingError = session.pendingError;
        delete session.pendingError;
        this.publishError(session, pendingError);
      }
      return surfaceId;
    } catch (error) {
      if (id !== undefined) this.close(id);
      else {
        try { server.close(); } catch {}
        rmSync(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  update(id: number, bounds: GhosttySurfaceUpdate): void {
    const session = this.requireSession(id);
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(value => Number.isFinite(value) && Math.abs(value) <= 100_000) || bounds.width < 0 || bounds.height < 0 || typeof bounds.visible !== "boolean" || (bounds.focus !== undefined && typeof bounds.focus !== "boolean")) throw new Error("Invalid native terminal bounds");
    if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1" && bounds.focus !== undefined) {
      process.stderr.write(`[native-ghostty] explicit focus update id=${id} focus=${bounds.focus} visible=${bounds.visible} bounds=${bounds.x},${bounds.y},${bounds.height ? bounds.height : 0} syncing=${session.controllerState.syncing}\n${new Error().stack ?? ""}\n`);
    }
    session.bounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, visible: bounds.visible };
    let shouldResumeStream = false;
    if (bounds.visible) {
      if (session.suspendTimer) {
        clearTimeout(session.suspendTimer);
        delete session.suspendTimer;
      }
      if (session.suspended) {
        session.suspended = false;
        session.controllerState = {
          ...session.controllerState,
          syncing: true,
          readOnly: true,
          controller: false,
        };
        shouldResumeStream = true;
      }
    }

    this.loadAddon().update(id, { ...bounds, ...(session.controllerState.syncing ? { preserveGrid: true } : {}) });

    if (shouldResumeStream) {
      this.publishState(session);
      void this.connectStream(session);
    } else if (!bounds.visible) {
      this.scheduleSuspendIfHidden(session);
    }
  }

  async action(id: number, action: "acquire" | "takeover" | "release"): Promise<void> {
    const session = this.requireSession(id);
    if (action === "release") {
      session.wantControl = false;
      if (session.suspended || !session.controller) {
        session.controllerState = { ...session.controllerState, controller: false, readOnly: true };
        this.publishState(session);
        return;
      }
      return session.controller.release();
    }
    session.wantControl = true;
    if (session.suspended || !session.controller) {
      session.suspended = false;
      session.controllerState = { ...session.controllerState, syncing: true, readOnly: true, controller: false };
      this.publishState(session);
      await this.connectStream(session);
      if (action === "takeover" && session.controller && !session.controllerState.controller) {
        return session.controller.acquire(true);
      }
      return;
    }
    if (action === "acquire") return session.controller.acquire(false);
    return session.controller.acquire(true);
  }

  search(id: number, text: string): void {
    this.requireSession(id);
    const bindingAction = this.loadAddon().bindingAction;
    if (!bindingAction) throw new Error("Native terminal search is unavailable");
    bindingAction(id, `search:${text}`);
  }

  searchStep(id: number, step: "next" | "previous" | "end"): void {
    this.requireSession(id);
    const binding = step === "end" ? "end_search" : `navigate_search:${step}`;
    const bindingAction = this.loadAddon().bindingAction;
    if (!bindingAction) throw new Error("Native terminal search is unavailable");
    // False also means no active search/matches, not a broken native terminal.
    bindingAction(id, binding);
  }

  inputText(id: number, text: string): void {
    const session = this.requireSession(id);
    if (session.suspended || session.reconcilingResize || !session.controllerState.connected || !session.controllerState.controller || session.controllerState.exited) throw new Error("Native terminal input is unavailable while observing");
    if (Buffer.byteLength(text, "utf8") > 8192 || text.includes("\0")) throw new Error("Native terminal input is invalid");
    const inputText = this.loadAddon().inputText;
    if (!inputText) throw new Error("Native terminal text input is unavailable");
    inputText(id, text);
  }

  close(id: number): void {
    const session = this.sessions.get(id);
    if (!session || session.closing) return;
    if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") process.stderr.write(`[native-ghostty] closing surface ${id}\n${new Error().stack ?? ""}\n`);
    session.closing = true;
    session.streamGeneration += 1;
    this.sessions.delete(id);
    const owned = this.surfacesByContents.get(session.contentsId); owned?.delete(id); if (!owned?.size) this.surfacesByContents.delete(session.contentsId);
    for (const pending of session.pendingAcks.values()) { clearTimeout(pending.timer); pending.reject(new Error("Native terminal closed")); }
    session.pendingAcks.clear();
    if (!session.peer) session.rejectRelayPeer(new Error("Native terminal session closed before relay connection"));
    if (session.relayConnectTimer) clearTimeout(session.relayConnectTimer);
    if (session.resizeRetryTimer) clearTimeout(session.resizeRetryTimer);
    if (session.suspendTimer) {
      clearTimeout(session.suspendTimer);
      delete session.suspendTimer;
    }
    session.operations.close();
    session.controller?.close();
    try { session.streamSocket?.terminate?.(); session.streamSocket?.close(); } catch {}
    session.peer?.destroy();
    try { this.loadAddon().destroy(id); } catch {}
    try { session.server.close(); } catch {}
    rmSync(session.directory, { recursive: true, force: true });
  }

  private failSession(id: number, message: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.publishError(session, message);
    const disconnected: TerminalStreamState = { ...session.controllerState, connected: false, syncing: false, controller: false, readOnly: true };
    session.controllerState = disconnected;
    this.publishState(session);
    this.close(id);
  }

  closeAllForContents(contentsId: number): void {
    for (const pending of this.pendingOpens.get(contentsId) ?? []) pending.abort();
    for (const id of [...(this.surfacesByContents.get(contentsId) ?? [])]) this.close(id);
  }

  closeAll(): void {
    for (const pending of this.pendingOpens.values()) for (const controller of pending) controller.abort();
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  shutdown(): void {
    this.closeAll();
    this.addon?.shutdown?.();
    this.addon = undefined;
  }

  private requireSession(id: number): NativeSession {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid native terminal id");
    const session = this.sessions.get(id);
    if (!session) throw new Error("Native terminal is no longer open");
    return session;
  }

  private bundle(): string | undefined {
    const packaged = nativeBundlePath();
    if (packaged && existsSync(packaged)) return packaged;
    const development = developmentBundlePath(this.appPath);
    return existsSync(development) ? development : undefined;
  }

  private loadAddon(): NativeGhosttyAddon {
    if (this.addon) return this.addon;
    if (this.addonAttempted) throw new Error("Native Ghostty could not be loaded");
    this.addonAttempted = true;
    if (this.addonOverride) {
      const addon = this.addonOverride;
      this.wireAddonHandlers(addon);
      this.addon = addon;
      return addon;
    }
    const bundle = this.bundle();
    if (!bundle) throw new Error("Native Ghostty resources are missing");
    const addonPath = join(bundle, "ghostty.node");
    const relay = join(bundle, "prospero-terminal-relay");
    if (!existsSync(addonPath) || !existsSync(relay)) throw new Error("Native Ghostty resources are incomplete");
    const addon = require(addonPath) as NativeGhosttyAddon;
    const configPath = join(bundle, "config");
    const resourcePath = join(bundle, "resources");
    addon.initialize(configPath, resourcePath);
    this.wireAddonHandlers(addon);
    this.addon = addon;
    return addon;
  }

  private wireAddonHandlers(addon: NativeGhosttyAddon): void {
    addon.setShortcutHandler?.((action, id) => {
      if (action === "toggle-focus" || action === "project-search" || action === "terminal-search") this.publishShortcut(id, action);
    });
    addon.setFocusHandler?.((id, focused) => {
      if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") process.stderr.write(`[native-ghostty] native focus callback id=${id} focused=${focused}\n`);
      this.publishFocus(id, focused);
    });
    addon.setPasteImageHandler?.(id => this.sessions.has(id) && this.publishPasteImage(id));
  }

  private setAuthoritativeGrid(session: NativeSession, columns: number, rows: number): void {
    if (!Number.isInteger(columns) || columns < 20 || columns > 500 || !Number.isInteger(rows) || rows < 5 || rows > 300) return;
    session.daemonGrid = { columns, rows };
    if (session.desiredGrid?.columns === columns && session.desiredGrid.rows === rows) {
      delete session.desiredGrid;
      if (session.resizeRetryTimer) { clearTimeout(session.resizeRetryTimer); delete session.resizeRetryTimer; }
      session.operations.cancelPendingResizes();
    }
    if (!session.surfaceReady) return;
    try { this.loadAddon().setGrid?.(session.id, columns, rows); }
    catch (error) { this.publishError(session, error instanceof Error ? error.message : String(error)); }
    this.flushResizeRequest(session);
  }

  private requestResize(session: NativeSession, columns: number, rows: number): void {
    if (!Number.isInteger(columns) || columns < 20 || columns > 500 || !Number.isInteger(rows) || rows < 5 || rows > 300) return;
    if (session.daemonGrid?.columns === columns && session.daemonGrid.rows === rows) return;
    session.desiredGrid = { columns, rows };
    this.flushResizeRequest(session);
  }

  private flushResizeRequest(session: NativeSession): void {
    if (session.closing || session.suspended || session.resizeRequestActive || session.resizeRetryTimer || !session.desiredGrid || !session.controllerState.connected || !session.controllerState.controller || session.controllerState.exited) return;
    if (session.daemonGrid?.columns === session.desiredGrid.columns && session.daemonGrid.rows === session.desiredGrid.rows) {
      delete session.desiredGrid;
      return;
    }
    const sent = { ...session.desiredGrid };
    session.resizeRequestActive = true;
    void session.operations.enqueueResize(sent.columns, sent.rows).catch(error => {
      if (session.closing || session.suspended) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/\bbusy\b/i.test(message)) {
        session.resizeRetryTimer = setTimeout(() => { delete session.resizeRetryTimer; this.flushResizeRequest(session); }, 150);
        session.resizeRetryTimer.unref?.();
      } else {
        if (session.desiredGrid?.columns === sent.columns && session.desiredGrid.rows === sent.rows) delete session.desiredGrid;
        this.publishError(session, message);
      }
    }).finally(() => {
      session.resizeRequestActive = false;
      if (session.desiredGrid && (session.desiredGrid.columns !== sent.columns || session.desiredGrid.rows !== sent.rows)) this.flushResizeRequest(session);
    });
  }

  private setReadOnly(session: NativeSession, readOnly: boolean): void {
    try { this.loadAddon().setReadOnly?.(session.id, readOnly || session.reconcilingResize); }
    catch (error) { this.publishError(session, error instanceof Error ? error.message : String(error)); }
  }

  private restoreSurfaceBounds(session: NativeSession): void {
    if (session.bounds.width <= 0 || session.bounds.height <= 0) return;
    try { this.loadAddon().update(session.id, session.bounds); }
    catch (error) { this.publishError(session, error instanceof Error ? error.message : String(error)); }
  }
}
