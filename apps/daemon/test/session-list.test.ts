import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import { StatusFile } from "../src/status-file.js";
import {
  STATUS_ACTIVE_LIMIT,
  STATUS_ATTENTION_LIMIT,
  STATUS_RECENT_TERMINAL_LIMIT,
  pageSessions,
  selectStatusSessions,
} from "../src/session-list.js";
import type { SessionManager } from "../src/session-manager.js";

function session(
  id: string,
  createdAt: number,
  status: SessionInfo["status"] = "done",
  extra: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    title: `Session ${id}`,
    cwd: `/workspace/${id}`,
    status,
    createdAt,
    cols: 120,
    rows: 40,
    ...extra,
  };
}

class FakeSessionManager extends EventEmitter {
  constructor(private readonly sessions: SessionInfo[]) {
    super();
  }

  list(): SessionInfo[] {
    return [...this.sessions];
  }
}

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("bounded daemon session views", () => {
  it("keeps status.json small while exposing honest counts and recent history", () => {
    const sessions: SessionInfo[] = [
      ...Array.from({ length: STATUS_ATTENTION_LIMIT + 25 }, (_, i) => session(
        `attention-${String(i).padStart(3, "0")}`,
        i,
        "waiting_input",
        { pendingQuestions: 1 },
      )),
      ...Array.from({ length: STATUS_ACTIVE_LIMIT + 25 }, (_, i) => session(
        `active-${String(i).padStart(3, "0")}`,
        1_000 + i,
        "running",
      )),
      ...Array.from({ length: STATUS_RECENT_TERMINAL_LIMIT + 25 }, (_, i) => session(
        `done-${String(i).padStart(3, "0")}`,
        2_000 + i,
      )),
    ];

    const selected = selectStatusSessions(sessions);
    expect(selected.summary).toMatchObject({
      total: sessions.length,
      active: STATUS_ATTENTION_LIMIT + 25 + STATUS_ACTIVE_LIMIT + 25,
      attention: STATUS_ATTENTION_LIMIT + 25,
      terminal: STATUS_RECENT_TERMINAL_LIMIT + 25,
      activeLimit: STATUS_ACTIVE_LIMIT,
      attentionLimit: STATUS_ATTENTION_LIMIT,
      recentTerminalLimit: STATUS_RECENT_TERMINAL_LIMIT,
      truncated: true,
    });
    expect(selected.summary.included).toBeLessThan(sessions.length);
    expect(selected.summary.omitted).toBe(sessions.length - selected.summary.included);
    expect(selected.sessions.filter((item) => item.status === "done")).toHaveLength(STATUS_RECENT_TERMINAL_LIMIT);
    expect(selected.sessions.some((item) => item.id === "done-074")).toBe(true);
    expect(selected.sessions.some((item) => item.id === "done-000")).toBe(false);
  });

  it("writes the bounded selection and summary to status.json", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-status-list-"));
    homes.push(home);
    const sessions = Array.from({ length: STATUS_RECENT_TERMINAL_LIMIT + 3 }, (_, i) =>
      session(`done-${String(i).padStart(3, "0")}`, i),
    );
    const manager = new FakeSessionManager(sessions);
    const status = new StatusFile(home, manager as unknown as SessionManager, {
      port: 7423,
      bind: null,
      controlToken: "test-control-token",
      persistence: { pty: true, structured: true },
      startedAt: 123,
    });

    status.start();
    const snapshot = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as {
      sessions: Array<{ id: string }>;
      sessionSummary: { total: number; terminal: number; included: number; omitted: number; truncated: boolean };
    };
    expect(snapshot.sessionSummary).toEqual(expect.objectContaining({
      total: STATUS_RECENT_TERMINAL_LIMIT + 3,
      terminal: STATUS_RECENT_TERMINAL_LIMIT + 3,
      included: STATUS_RECENT_TERMINAL_LIMIT,
      omitted: 3,
      truncated: true,
    }));
    expect(snapshot.sessions).toHaveLength(STATUS_RECENT_TERMINAL_LIMIT);
    expect(snapshot.sessions[0]?.id).toBe("done-003");
    status.stop();
  });

  it("paginates terminal history with an opaque stable cursor and applies search before totals", () => {
    const sessions = [
      session("active", 99, "running"),
      session("terminal-a", 50),
      session("terminal-b", 40),
      session("terminal-c", 30),
      session("terminal-d", 20),
      session("terminal-e", 10),
    ];
    const first = pageSessions(sessions, { terminalOnly: true, limit: 2 });
    expect(first).toMatchObject({ total: 5, active: 1, terminal: 5 });
    expect(first.items.map((item) => item.id)).toEqual(["terminal-a", "terminal-b"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = pageSessions(sessions, { terminalOnly: true, limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(["terminal-c", "terminal-d"]);
    const searched = pageSessions(sessions, { terminalOnly: true, query: "-c", limit: 10 });
    expect(searched).toMatchObject({ total: 1, items: [expect.objectContaining({ id: "terminal-c" })] });
    const exact = pageSessions(sessions, { ids: ["active", "terminal-d"], limit: 10 });
    expect(exact).toMatchObject({
      total: 2,
      items: [expect.objectContaining({ id: "active" }), expect.objectContaining({ id: "terminal-d" })],
    });
    expect(() => pageSessions(sessions, { cursor: "not-a-cursor" })).toThrow("invalid session cursor");
  });
});
