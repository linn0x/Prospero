import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type WebSocket from "ws";
import { TerminalStreamKind, decodeTerminalFrame, encodeTerminalFrame, type TerminalStreamFrame } from "../shared/terminal-stream";
import { NativeRelayDecoder, NativeTerminalQueryFilter } from "./native-terminal-wire";
import { NativeTerminalOperationQueue, type NativeTerminalOperation } from "./native-terminal-operation-queue";
import { TerminalStreamController, type TerminalStreamState } from "../renderer/src/terminal-stream-controller";

type GhosttySurfaceUpdate = { x: number; y: number; width: number; height: number; visible: boolean; focus?: boolean; preserveGrid?: boolean };
type GhosttyAddon = {
  initialize(configPath: string, resourcePath: string): void;
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
  pendingAcks: Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  controller: TerminalStreamController;
  operations: NativeTerminalOperationQueue;
  controllerState: TerminalStreamState;
  controllerAttached: boolean;
  readOnlyInputFailureNotified: boolean;
  streamSocket: WebSocket;
  bounds: Omit<GhosttySurfaceUpdate, "focus" | "preserveGrid">;
  surfaceReady: boolean;
  daemonGrid?: { columns: number; rows: number };
  desiredGrid?: { columns: number; rows: number };
  resizeRequestActive: boolean;
  busyInputNotified: boolean;
  inputQueueFullNotified: boolean;
  resizeRetryTimer?: ReturnType<typeof setTimeout>;
  closing: boolean;
};

const ACK_TIMEOUT_MS = 5_000;
const MAX_NATIVE_CHUNK = 48 * 1024;
const MAX_PENDING_STREAM_BYTES = 256 * 1024;
const require = createRequire(import.meta.url);

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function abortError(): Error { return new Error("Native terminal open was cancelled because its window is closing or reloading"); }
function firstFontFamily(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const family = (value.match(/(?:"[^"]*"|'[^']*'|[^,])+/)?.[0] ?? "").trim().replace(/^(?:"(.*)"|'(.*)')$/, (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined) => doubleQuoted ?? singleQuoted ?? "");
  if (!family || family.length > 200 || /[\u0000-\u001f\u007f]/.test(family)) throw new Error("Native terminal font family is invalid");
  return family;
}
function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const abort = (): void => rejectOperation(abortError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolveOperation(value); }, error => { signal.removeEventListener("abort", abort); rejectOperation(error); });
  });
}
function nativeBundlePath(): string {
  return process.env["PROSPERO_NATIVE_GHOSTTY_DIR"]
    ? resolve(process.env["PROSPERO_NATIVE_GHOSTTY_DIR"])
    : resolve(process.resourcesPath, "native-ghostty");
}
function developmentBundlePath(appPath: string): string { return resolve(appPath, ".native", "ghostty"); }

/** Owns the Ghostty NSViews and bridges their PTY relay to existing daemon sessions. */
export class NativeGhosttyManager {
  private addon: GhosttyAddon | undefined;
  private addonAttempted = false;
  private readonly sessions = new Map<number, NativeSession>();
  private readonly surfacesByContents = new Map<number, Set<number>>();
  private readonly pendingOpens = new Map<number, Set<AbortController>>();

  constructor(
    private readonly appPath: string,
    private readonly openSocket: (sessionId: string) => WebSocket,
    private readonly supportsSession: (sessionId: string) => Promise<boolean>,
    private readonly publishState: (id: number, state: TerminalStreamState) => void,
    private readonly publishError: (id: number, message: string) => void,
    private readonly publishShortcut: (id: number, action: "toggle-focus" | "project-search" | "terminal-search") => void,
    private readonly publishFocus: (id: number, focused: boolean) => void,
  private readonly publishPasteImage: (id: number) => boolean,
  ) {}

  availability(): { available: boolean; reason?: string } {
    if (process.env["PROSPERO_NATIVE_GHOSTTY"] === "0") return { available: false, reason: "Native Ghostty is disabled" };
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

  private async openInternal(window: BrowserWindow, contentsId: number, sessionId: string, fontSize: number, requestedFontFamily: string | undefined, signal: AbortSignal): Promise<number> {
    const availability = this.availability();
    if (!availability.available) throw new Error(availability.reason ?? "Native Ghostty is unavailable");
    if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 40) throw new Error("Invalid native terminal font size");
    const fontFamily = firstFontFamily(requestedFontFamily);
    if (!(await waitForAbortable(this.supportsSession(sessionId), signal))) throw new Error("This Rust daemon session does not support terminal streaming");
    if (signal.aborted || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.id !== contentsId) throw abortError();

    const addon = this.loadAddon();
    const bundle = this.bundle()!;
    const directory = mkdtempSync(join(tmpdir(), `prospero-ghostty-${randomUUID().slice(0, 8)}-`));
    chmodSync(directory, 0o700);
    const socketPath = join(directory, "relay.sock");
    const configPath = join(directory, "ghostty.conf");
    const server = createServer();
    let id: number | undefined;
    let streamSocket: WebSocket | undefined;
    let controller: TerminalStreamController | undefined;
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.removeListener("error", reject); resolveListen(); });
      });
      if (signal.aborted || window.isDestroyed() || window.webContents.isDestroyed()) throw abortError();
      chmodSync(socketPath, 0o600);

      const baseConfig = readFileSync(join(bundle, "config"), "utf8");
      let surfaceConfig = baseConfig;
      const fontSizeLine = `font-size = ${fontSize}`;
      surfaceConfig = /^\s*font-size\s*=.*$/m.test(surfaceConfig)
        ? surfaceConfig.replace(/^\s*font-size\s*=.*$/m, fontSizeLine)
        : `${surfaceConfig.trimEnd()}\n${fontSizeLine}\n`;
      if (fontFamily) {
        const fontLine = `font-family = "${fontFamily.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
        surfaceConfig = /^\s*font-family\s*=.*$/m.test(surfaceConfig)
          ? surfaceConfig.replace(/^\s*font-family\s*=.*$/m, fontLine)
          : `${surfaceConfig.trimEnd()}\n${fontLine}\n`;
      }
      writeFileSync(configPath, surfaceConfig, { encoding: "utf8", mode: 0o600, flag: "wx" });

      streamSocket = this.openSocket(sessionId);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        const timer = setTimeout(() => rejectOpen(new Error("Terminal stream connection timed out")), 7_000);
        timer.unref?.();
        const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        const abort = (): void => { cleanup(); streamSocket?.terminate?.(); rejectOpen(abortError()); };
        streamSocket!.once("open", () => { cleanup(); resolveOpen(); });
        streamSocket!.once("error", error => { cleanup(); rejectOpen(error); });
        streamSocket!.once("close", () => { cleanup(); rejectOpen(new Error("Terminal stream closed before attach")); });
        signal.addEventListener("abort", abort, { once: true });
      });
      if (signal.aborted || window.isDestroyed() || window.webContents.isDestroyed()) throw abortError();

      const ghosttySessionId = Number.parseInt(randomUUID().slice(0, 8), 16) || 1;
      const queryFilter = new NativeTerminalQueryFilter();
      const pendingAcks = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      let resolveRelayPeer!: (peer: Socket) => void;
      let rejectRelayPeer!: (error: Error) => void;
      const relayPeerPromise = new Promise<Socket>((resolvePeer, rejectPeer) => { resolveRelayPeer = resolvePeer; rejectRelayPeer = rejectPeer; });
      void relayPeerPromise.catch(() => undefined);
      let nextOutputId = 1;
      let sessionRef: NativeSession | undefined;
      const waitForNativeAck = (bytes: Uint8Array): Promise<void> => {
        if (!bytes.byteLength) return Promise.resolve();
        const ackId = nextOutputId++;
        if (nextOutputId > 0xffff_ffff) nextOutputId = 1;
        const payload = Buffer.allocUnsafe(4 + bytes.byteLength);
        payload.writeUInt32BE(ackId, 0);
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(payload, 4);
        const header = Buffer.allocUnsafe(5);
        header[0] = "O".charCodeAt(0); header.writeUInt32BE(payload.byteLength, 1);
        const session = sessionRef;
        if (!session) return Promise.reject(new Error("Native terminal session is unavailable"));
        return session.relayPeerPromise.then(peer => new Promise<void>((resolveAck, rejectAck) => {
          if (session.closing || peer.destroyed) { rejectAck(new Error("Native terminal relay disconnected")); return; }
          const timer = setTimeout(() => { pendingAcks.delete(ackId); rejectAck(new Error("Native terminal relay acknowledgement timed out")); }, ACK_TIMEOUT_MS);
          timer.unref?.(); pendingAcks.set(ackId, { resolve: resolveAck, reject: rejectAck, timer });
          try {
            peer.write(Buffer.concat([header, payload]), error => {
              if (!error) return;
              const pending = pendingAcks.get(ackId); if (!pending) return;
              clearTimeout(pending.timer); pendingAcks.delete(ackId); pending.reject(error);
            });
          } catch (error) {
            clearTimeout(timer); pendingAcks.delete(ackId); rejectAck(error instanceof Error ? error : new Error(String(error)));
          }
        }));
      };
      const consume = async (frame: TerminalStreamFrame): Promise<void> => {
        if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") process.stderr.write(`[native-ghostty] stream frame kind=${frame.kind} seq=${frame.sequence} bytes=${frame.payload.byteLength}\n`);
        if (frame.kind === TerminalStreamKind.Resize) {
          const size = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
          this.setAuthoritativeGrid(sessionRef!, size.getUint16(0, false), size.getUint16(2, false));
          return;
        }
        if (frame.kind !== TerminalStreamKind.Snapshot && frame.kind !== TerminalStreamKind.Output) return;
        if (frame.kind === TerminalStreamKind.Snapshot) queryFilter.reset();
        const content = queryFilter.push(frame.payload);
        const filtered = frame.kind === TerminalStreamKind.Snapshot
          ? Buffer.concat([Buffer.from("\x1bc", "binary"), content])
          : content;
        for (let offset = 0; offset < filtered.byteLength; offset += MAX_NATIVE_CHUNK) {
          await waitForNativeAck(filtered.subarray(offset, Math.min(filtered.byteLength, offset + MAX_NATIVE_CHUNK)));
        }
      };
      const terminalController = new TerminalStreamController({
        sessionId,
        cursor: () => undefined,
        epoch: () => undefined,
        wantControl: true,
        consume,
        onHello: ({ cols, rows }) => { if (sessionRef) this.setAuthoritativeGrid(sessionRef, cols, rows); },
        onState: state => {
          if (sessionRef) {
            const wasSyncing = sessionRef.controllerState.syncing;
            sessionRef.controllerState = state;
            if (sessionRef.surfaceReady) this.setReadOnly(sessionRef, !state.connected || !state.controller || state.exited);
            if (state.connected && state.controller && !state.exited) sessionRef.readOnlyInputFailureNotified = false;
            if (state.connected && state.controller && !state.exited) this.flushResizeRequest(sessionRef);
            if (wasSyncing && state.connected && !state.syncing) this.restoreSurfaceBounds(sessionRef);
          }
          this.publishState(id ?? ghosttySessionId, state);
        },
        onError: message => this.publishError(id ?? ghosttySessionId, message),
        onHistoryGap: message => this.publishError(id ?? ghosttySessionId, message),
      });
      controller = terminalController;
      const operations = new NativeTerminalOperationQueue((operation: NativeTerminalOperation) => {
        if (operation.kind === "input") return terminalController.input(operation.bytes);
        return terminalController.resize(operation.columns, operation.rows);
      });

      const session: NativeSession = {
        id: ghosttySessionId, contentsId, sessionId, directory, socketPath, server, decoder: new NativeRelayDecoder(),
        relayPeerPromise, resolveRelayPeer, rejectRelayPeer,
        preSurfaceBuffers: [], preSurfaceBytes: 0,
        filter: queryFilter, pendingAcks, controller: terminalController, operations, controllerState: { connected: false, syncing: true, readOnly: true, exited: false, controller: false }, controllerAttached: false, readOnlyInputFailureNotified: false, resizeRequestActive: false, busyInputNotified: false, inputQueueFullNotified: false,
        streamSocket, bounds: { x: 0, y: 0, width: 0, height: 0, visible: true }, closing: false,
        surfaceReady: false,
      };
      id = ghosttySessionId;
      sessionRef = session;
      this.sessions.set(ghosttySessionId, session);
      const owned = this.surfacesByContents.get(contentsId) ?? new Set<number>(); owned.add(ghosttySessionId); this.surfacesByContents.set(contentsId, owned);

      const controllerPortLike = {
        onmessage: undefined as ((event: MessageEvent) => void) | null | undefined,
        onmessageerror: undefined as ((event: MessageEvent) => void) | null | undefined,
        start: () => { session.controllerAttached = true; },
        close: () => { if (session.streamSocket.readyState === 1) session.streamSocket.close(); },
        postMessage: (value: unknown) => {
          if (session.closing) return;
          if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error("Invalid terminal stream client frame");
          if (session.streamSocket.bufferedAmount > MAX_PENDING_STREAM_BYTES) throw new Error("Terminal stream input queue is full");
          const frame = decodeTerminalFrame(value as ArrayBuffer | ArrayBufferView, "client");
          if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") process.stderr.write(`[native-ghostty] client frame kind=${frame.kind} seq=${frame.sequence} bytes=${frame.payload.byteLength}\n`);
          session.streamSocket.send(Buffer.from(encodeTerminalFrame(frame)), error => { if (error) this.failSession(session.id, `Terminal stream write failed: ${error.message}`); });
        },
      };
      const tryAttach = (): void => {
        if (session.controllerAttached) return;
        terminalController.attach(controllerPortLike as unknown as MessagePort);
        session.controllerAttached = true;
      };
      const processRelayData = (bytes: Buffer): void => {
        try {
          for (const frame of session.decoder.push(bytes)) {
            if (frame.kind === "I") {
              if (!session.controllerState.connected || !session.controllerState.controller || session.controllerState.exited) {
                if (!session.readOnlyInputFailureNotified) {
                  session.readOnlyInputFailureNotified = true;
                  this.publishError(session.id, "Terminal input is disabled while this session is read-only");
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
                  this.publishError(session.id, "The terminal was busy; this input was not accepted or replayed. Send it again when ready.");
                  return;
                }
                if (/operation queue is full/i.test(message)) {
                  if (session.inputQueueFullNotified) return;
                  session.inputQueueFullNotified = true;
                  this.publishError(session.id, "The terminal input queue is full; this input was not accepted. Wait, then send it again.");
                  return;
                }
                this.publishError(session.id, message);
              });
            }
            else if (frame.kind === "R") {
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

      session.streamSocket.on("message", raw => {
        if (session.closing || !session.controllerAttached) return;
        try {
          const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
          controllerPortLike.onmessage?.({ data: bytes } as MessageEvent);
        } catch { this.failSession(session.id, "Terminal stream frame could not be forwarded to Ghostty"); }
      });
      session.streamSocket.on("error", error => this.failSession(session.id, `Terminal stream error: ${error.message}`));
      session.streamSocket.on("close", (code, reason) => {
        if (session.closing) return;
        if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") {
          let nativeOutput = "";
          try { nativeOutput = this.loadAddon().readText?.(session.id) ?? ""; }
          catch (error) { nativeOutput = `readText failed: ${error instanceof Error ? error.message : String(error)}`; }
          process.stderr.write(`[native-ghostty] websocket closed code=${code} reason=${reason.toString("utf8")} peer=${Boolean(session.peer && !session.peer.destroyed)} queuedRelayBytes=${session.preSurfaceBytes}\n${nativeOutput.slice(-2000)}\n`);
        }
        this.failSession(session.id, `Terminal stream closed unexpectedly (code ${code}${reason.byteLength ? `: ${reason.toString("utf8").slice(0, 256)}` : ""})`);
      });

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
        tryAttach();
      });

      // The daemon expects Attach promptly after the websocket opens. Ghostty
      // surface creation can block on Metal initialization, so attach before it.
      tryAttach();
      // Ghostty's shell integration already prepends `exec -l` to an explicit
      // command, so this must be the quoted executable and arguments only.
      const command = `${shellQuote(join(bundle, "prospero-terminal-relay"))} ${shellQuote(socketPath)}`;
      if (signal.aborted || window.isDestroyed() || window.webContents.isDestroyed()) throw abortError();
      const surfaceId = addon.create(window.getNativeWindowHandle(), command, { fontSize, ...(fontFamily ? { fontFamily } : {}), configPath });
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
      session.surfaceReady = true;
      this.setReadOnly(session, true);
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
      tryAttach();
      if (session.peer && session.preSurfaceBuffers.length) {
        for (const bytes of session.preSurfaceBuffers.splice(0)) processRelayData(bytes);
        session.preSurfaceBytes = 0;
      }
      if (session.daemonGrid) this.setAuthoritativeGrid(session, session.daemonGrid.columns, session.daemonGrid.rows);
      this.publishState(surfaceId, session.controllerState);
      return surfaceId;
    } catch (error) {
      if (id !== undefined) this.close(id);
      else {
        controller?.close();
        try { streamSocket?.close(); } catch {}
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
      process.stderr.write(`[native-ghostty] explicit focus update id=${id} focus=${bounds.focus} visible=${bounds.visible} bounds=${bounds.x},${bounds.y},${bounds.width},${bounds.height} syncing=${session.controllerState.syncing}\n${new Error().stack ?? ""}\n`);
    }
    session.bounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, visible: bounds.visible };
    this.loadAddon().update(id, { ...bounds, ...(session.controllerState.syncing ? { preserveGrid: true } : {}) });
  }

  async action(id: number, action: "acquire" | "takeover" | "release"): Promise<void> {
    const session = this.requireSession(id);
    if (action === "acquire") return session.controller.acquire(false);
    if (action === "takeover") return session.controller.acquire(true);
    return session.controller.release();
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
    if (!session.controllerState.connected || !session.controllerState.controller || session.controllerState.exited) throw new Error("Native terminal input is unavailable while observing");
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
    this.sessions.delete(id);
    const owned = this.surfacesByContents.get(session.contentsId); owned?.delete(id); if (!owned?.size) this.surfacesByContents.delete(session.contentsId);
    for (const pending of session.pendingAcks.values()) { clearTimeout(pending.timer); pending.reject(new Error("Native terminal closed")); }
    session.pendingAcks.clear();
    if (!session.peer) session.rejectRelayPeer(new Error("Native terminal session closed before relay connection"));
    if (session.relayConnectTimer) clearTimeout(session.relayConnectTimer);
    if (session.resizeRetryTimer) clearTimeout(session.resizeRetryTimer);
    session.operations.close();
    session.controller.close();
    try { session.streamSocket.terminate?.(); session.streamSocket.close(); } catch {}
    session.peer?.destroy();
    try { this.loadAddon().destroy(id); } catch {}
    try { session.server.close(); } catch {}
    rmSync(session.directory, { recursive: true, force: true });
  }

  private failSession(id: number, message: string): void {
    if (!this.sessions.has(id)) return;
    this.publishError(id, message);
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

  private requireSession(id: number): NativeSession {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid native terminal id");
    const session = this.sessions.get(id);
    if (!session) throw new Error("Native terminal is no longer open");
    return session;
  }

  private bundle(): string | undefined {
    const packaged = nativeBundlePath();
    if (existsSync(packaged)) return packaged;
    const development = developmentBundlePath(this.appPath);
    return existsSync(development) ? development : undefined;
  }

  private loadAddon(): GhosttyAddon {
    if (this.addon) return this.addon;
    if (this.addonAttempted) throw new Error("Native Ghostty could not be loaded");
    this.addonAttempted = true;
    const bundle = this.bundle();
    if (!bundle) throw new Error("Native Ghostty resources are missing");
    const addonPath = join(bundle, "ghostty.node");
    const relay = join(bundle, "prospero-terminal-relay");
    if (!existsSync(addonPath) || !existsSync(relay)) throw new Error("Native Ghostty resources are incomplete");
    const addon = require(addonPath) as GhosttyAddon;
    const configPath = join(bundle, "config");
    const resourcePath = join(bundle, "resources");
    addon.initialize(configPath, resourcePath);
    addon.setShortcutHandler?.((action, id) => {
      if (action === "toggle-focus" || action === "project-search" || action === "terminal-search") this.publishShortcut(id, action);
    });
    addon.setFocusHandler?.((id, focused) => {
      if (process.env["PROSPERO_NATIVE_GHOSTTY_DEBUG"] === "1") process.stderr.write(`[native-ghostty] native focus callback id=${id} focused=${focused}\n`);
      this.publishFocus(id, focused);
    });
    addon.setPasteImageHandler?.(id => this.sessions.has(id) && this.publishPasteImage(id));
    this.addon = addon;
    return addon;
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
    catch (error) { this.publishError(session.id, error instanceof Error ? error.message : String(error)); }
    this.flushResizeRequest(session);
  }

  private requestResize(session: NativeSession, columns: number, rows: number): void {
    if (!Number.isInteger(columns) || columns < 20 || columns > 500 || !Number.isInteger(rows) || rows < 5 || rows > 300) return;
    if (session.daemonGrid?.columns === columns && session.daemonGrid.rows === rows) return;
    session.desiredGrid = { columns, rows };
    this.flushResizeRequest(session);
  }

  private flushResizeRequest(session: NativeSession): void {
    if (session.closing || session.resizeRequestActive || session.resizeRetryTimer || !session.desiredGrid || !session.controllerState.connected || !session.controllerState.controller || session.controllerState.exited) return;
    if (session.daemonGrid?.columns === session.desiredGrid.columns && session.daemonGrid.rows === session.desiredGrid.rows) {
      delete session.desiredGrid;
      return;
    }
    const sent = { ...session.desiredGrid };
    session.resizeRequestActive = true;
    void session.operations.enqueueResize(sent.columns, sent.rows).catch(error => {
      if (session.closing) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/\bbusy\b/i.test(message)) {
        session.resizeRetryTimer = setTimeout(() => { delete session.resizeRetryTimer; this.flushResizeRequest(session); }, 150);
        session.resizeRetryTimer.unref?.();
      } else {
        if (session.desiredGrid?.columns === sent.columns && session.desiredGrid.rows === sent.rows) delete session.desiredGrid;
        this.publishError(session.id, message);
      }
    }).finally(() => {
      session.resizeRequestActive = false;
      if (session.desiredGrid && (session.desiredGrid.columns !== sent.columns || session.desiredGrid.rows !== sent.rows)) this.flushResizeRequest(session);
    });
  }

  private setReadOnly(session: NativeSession, readOnly: boolean): void {
    try { this.loadAddon().setReadOnly?.(session.id, readOnly); }
    catch (error) { this.publishError(session.id, error instanceof Error ? error.message : String(error)); }
  }

  private restoreSurfaceBounds(session: NativeSession): void {
    if (session.bounds.width <= 0 || session.bounds.height <= 0) return;
    try { this.loadAddon().update(session.id, session.bounds); }
    catch (error) { this.publishError(session.id, error instanceof Error ? error.message : String(error)); }
  }
}
