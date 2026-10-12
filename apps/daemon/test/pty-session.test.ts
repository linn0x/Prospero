import { afterEach, describe, expect, it, vi } from "vitest";
import { PtySession } from "../src/pty-session.js";

const sessions: PtySession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

describe("PtySession snapshot", () => {
  it("binds the cursor to the output rendered before its barrier", async () => {
    const session = new PtySession({
      id: "snapshot-cursor",
      agent: "custom",
      title: "snapshot-cursor",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" },
    });
    sessions.push(session);
    const internals = session as unknown as {
      onProcData(data: string): void;
      term: { write(data: string, callback?: () => void): void };
      serializer: { serialize(): string };
    };
    const writes: Array<() => void> = [];
    let rendered = "";
    vi.spyOn(internals.term, "write").mockImplementation((data, callback) => {
      writes.push(() => {
        rendered += data;
        callback?.();
      });
    });
    vi.spyOn(internals.serializer, "serialize").mockImplementation(() => rendered);

    internals.onProcData("first");
    const pending = session.snapshot();
    internals.onProcData("second");
    session.flushNow();
    writes.shift()?.();
    writes.shift()?.();

    await expect(pending).resolves.toMatchObject({ ansi: "first", seq: 1 });
    expect(session.ring.lastSeq).toBe(2);
  });

  it("tracks input activity and clears stale busy state", async () => {
    vi.useFakeTimers();
    try {
      const session = new PtySession({
        id: "activity",
        agent: "custom",
        title: "activity",
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        file: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: { PATH: process.env.PATH ?? "" },
      });
      sessions.push(session);
      const proc = (session as unknown as { proc: { write: ReturnType<typeof vi.fn> } }).proc;
      proc.write = vi.fn();
      expect((session as unknown as { screenLooksIdle(): boolean }).screenLooksIdle()).toBe(false);
      session.writeInput("input");
      expect(session.info().busySince).toEqual(expect.any(Number));
      vi.advanceTimersByTime(30_000);
      expect(session.info().busySince).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
