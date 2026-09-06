import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventBody, SessionInfo } from "@prospero/protocol";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";
import { StructuredSession } from "../src/structured-session.js";
import { SessionManager } from "../src/session-manager.js";
import { SessionDatabase } from "../src/session-database.js";
import {
  projectSessionQueue,
  queueDisplayText,
  QUEUE_DISPLAY_TEXT_LIMIT,
  QUEUE_DISPLAY_TRUNCATION_MARKER,
} from "../src/queue-display.js";

class QueueAdapter implements AgentAdapter {
  private context: AdapterContext | undefined;
  readonly sends: string[] = [];
  readonly steers: string[] = [];
  steerResult = true;
  async start(context: AdapterContext) { this.context = context; }
  async send(text: string) { this.sends.push(text); }
  async steer(text: string) { this.steers.push(text); return this.steerResult; }
  async respondPermission() {}
  async interrupt() {}
  async dispose() {}
  emit(body: AgentEventBody) { this.context?.emit(body); }
}

const homes: string[] = [];
function home() {
  const value = mkdtempSync(path.join(os.tmpdir(), "prospero-queue-display-"));
  homes.push(value);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

function makeSession(adapter: QueueAdapter, cwd: string, restored?: ReturnType<StructuredSession["persistentState"]>) {
  return new StructuredSession({ id: "queue-display", agent: "codex", title: "Queue fixture", cwd, adapter,
    ...(restored ? { restored } : {}),
  });
}

describe("bounded display of durable queued messages", () => {
  it("keeps short text exact and marks an oversized preview without splitting a surrogate pair", () => {
    expect(queueDisplayText("")).toBe("");
    expect(queueDisplayText("🙂".repeat(500))).toBe("🙂".repeat(500));
    const prefixLength = QUEUE_DISPLAY_TEXT_LIMIT - QUEUE_DISPLAY_TRUNCATION_MARKER.length;
    const text = "a".repeat(prefixLength - 1) + "🙂" + "tail".repeat(100);
    expect(queueDisplayText(text)).toBe("a".repeat(prefixLength - 1) + QUEUE_DISPLAY_TRUNCATION_MARKER);
    const large = queueDisplayText("x".repeat(1024 * 1024));
    expect(large).toHaveLength(QUEUE_DISPLAY_TEXT_LIMIT);
    expect(large.endsWith(QUEUE_DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });

  it("projects only oversized rows and leaves the source and already bounded objects unchanged", () => {
    const text = "full input ".repeat(20_000);
    const info: SessionInfo = {
      id: "old-owner", agent: "codex", kind: "structured", cwd: "/synthetic", title: "Fixture", status: "running",
      createdAt: 1, cols: 80, rows: 24,
      messageQueue: [
        { id: "large", text, kind: "queue", createdAt: 2, attachmentCount: 1 },
        { id: "short", text: "short input", kind: "guide", createdAt: 3, attachmentCount: 0 },
      ],
    };
    const shown = projectSessionQueue(info);
    expect(shown).not.toBe(info);
    expect(shown.messageQueue?.[0]).toMatchObject({ id: "large", kind: "queue", createdAt: 2, attachmentCount: 1 });
    expect(shown.messageQueue?.[0]?.text).toHaveLength(QUEUE_DISPLAY_TEXT_LIMIT);
    expect(shown.messageQueue?.[1]).toBe(info.messageQueue?.[1]);
    expect(info.messageQueue?.[0]?.text).toBe(text);
    expect(projectSessionQueue(shown)).toBe(shown);
  });

  it("keeps full input for guide, guide fallback, persistence and automatic draining", async () => {
    const adapter = new QueueAdapter();
    const session = makeSession(adapter, home());
    const first = "Synthetic queued guide🙂\n".repeat(12_000);
    const second = "Synthetic queued next turn🙂\n".repeat(12_000);
    try {
      await session.start();
      await session.send("running turn");
      await session.send(first, undefined, "queue");
      const shown = session.info().messageQueue![0]!;
      expect(shown.text).toHaveLength(QUEUE_DISPLAY_TEXT_LIMIT);
      expect(shown.text.endsWith(QUEUE_DISPLAY_TRUNCATION_MARKER)).toBe(true);
      expect(session.persistentState().messageQueue![0]).toMatchObject({ id: shown.id, displayText: first, outgoingText: first });
      expect(await session.guideQueued(shown.id)).toBe(true);
      expect(adapter.steers).toEqual([first]);
      await session.send(second, undefined, "queue");
      adapter.steerResult = false;
      expect(await session.guideQueued(session.info().messageQueue![0]!.id)).toBe(false);
      expect(session.persistentState().messageQueue![0]).toMatchObject({ kind: "guide", displayText: second, outgoingText: second });
      adapter.emit({ kind: "turn.end", msgId: "running-turn", finish: "done" });
      await vi.waitFor(() => expect(adapter.sends).toEqual(["running turn", second]));
      expect(session.info().messageQueue).toEqual([]);
    } finally { await session.dispose(); }
  });

  it("restores and sends the complete queued body from SQLite after displaying only a summary", async () => {
    const cwd = home();
    const first = makeSession(new QueueAdapter(), cwd);
    const original = "Durable original input🙂\n".repeat(20_000);
    const database = new SessionDatabase(path.join(cwd, "sessions.sqlite"));
    let restored: StructuredSession | undefined;
    try {
      await first.start();
      await first.send("running turn");
      await first.send(original, undefined, "queue");
      expect(first.info().messageQueue![0]!.text.length).toBeLessThanOrEqual(QUEUE_DISPLAY_TEXT_LIMIT);
      const state = first.persistentState();
      database.saveSession(state);
      const stored = database.readSession(first.id, { events: true, toolOutputs: false, messageQueue: true, maxBytes: 8 * 1024 * 1024 })!;
      expect(stored.messageQueue![0]).toMatchObject({ displayText: original, outgoingText: original });
      await first.dispose();
      const adapter = new QueueAdapter();
      restored = makeSession(adapter, cwd, stored);
      await restored.start();
      await vi.waitFor(() => expect(adapter.sends).toEqual([original]));
      expect(restored.info().messageQueue).toEqual([]);
    } finally {
      await first.dispose();
      await restored?.dispose();
      database.close();
    }
  });

  it("bounds central list/info/state projections from an active owner with an older info implementation", async () => {
    const cwd = home();
    const adapter = new QueueAdapter();
    const manager = new SessionManager({ home: cwd, adapterFactory: () => adapter });
    try {
      const created = await manager.create({ agent: "codex", kind: "structured", cwd, cols: 80, rows: 24, allowShell: true });
      const owner = manager.requireStructured(created.id);
      const text = "Old active owner complete input ".repeat(20_000);
      const oldInfo: SessionInfo = { ...owner.info(), messageQueue: [{ id: "old-queue", text, kind: "queue", createdAt: 1, attachmentCount: 0 }] };
      vi.spyOn(owner, "info").mockReturnValue(oldInfo);
      expect(manager.infoOf(created.id).messageQueue![0]!.text).toHaveLength(QUEUE_DISPLAY_TEXT_LIMIT);
      expect(manager.list()[0]!.messageQueue![0]!.text).toHaveLength(QUEUE_DISPLAY_TEXT_LIMIT);
      const emitted: SessionInfo[] = [];
      manager.on("state", (info) => emitted.push(info));
      owner.emit("state", oldInfo);
      expect(emitted.at(-1)?.messageQueue?.[0]?.text).toHaveLength(QUEUE_DISPLAY_TEXT_LIMIT);
      expect(oldInfo.messageQueue![0]!.text).toBe(text);
    } finally { await manager.disposeAll(); }
  });
});
