import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostConnection } from "../src/lib/connection";
import type { SessionInfo } from "@prospero/protocol";
import { useTerminalActions } from "../src/lib/use-terminal-actions";

vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; });

function fixture() {
  let resolve!: (session: SessionInfo) => void;
  const completion = new Promise<SessionInfo>((done) => { resolve = done; });
  const cancel = vi.fn();
  const conn = { host: { id: "mac" }, restartTerminal: vi.fn(() => ({ completion, cancel })), deleteTerminal: vi.fn<() => Promise<void>>().mockResolvedValue() };
  let actions!: ReturnType<typeof useTerminalActions>;
  function Page({ sid }: { sid: string }) { actions = useTerminalActions(conn as unknown as HostConnection, sid); return null; }
  return { Page, conn, resolve, cancel, get actions() { return actions; } };
}

const shell: SessionInfo = { id: "restarted", agent: "shell", kind: "pty", cwd: "/tmp", title: "Shell", cols: 80, rows: 24, status: "running", createdAt: 1 };

describe("terminal action navigation", () => {
  it("deduplicates rapid taps and returns the acknowledged shell", async () => {
    const test = fixture();
    await act(async () => { renderer = create(createElement(test.Page, { sid: "old" })); });
    let pending!: Promise<SessionInfo | null>;
    await act(async () => {
      pending = test.actions.restart("old");
      expect(await test.actions.restart("old")).toBeNull();
    });
    expect(test.conn.restartTerminal).toHaveBeenCalledTimes(1);
    expect(test.actions.busy?.kind).toBe("restart");
    await act(async () => { test.resolve(shell); await expect(pending).resolves.toBe(shell); });
    expect(test.actions.busy).toBeNull();
  });

  it("does not navigate to a late restart result after switching terminal routes", async () => {
    const test = fixture();
    await act(async () => { renderer = create(createElement(test.Page, { sid: "old" })); });
    let pending!: Promise<SessionInfo | null>;
    await act(async () => { pending = test.actions.restart("old"); });
    await act(async () => { renderer!.update(createElement(test.Page, { sid: "another" })); });
    expect(test.cancel).toHaveBeenCalledTimes(1);
    await act(async () => { test.resolve(shell); await expect(pending).resolves.toBeNull(); });
    expect(test.actions.busy).toBeNull();
  });

  it("shows deletion failures and allows retry instead of staying busy", async () => {
    const test = fixture();
    test.conn.deleteTerminal.mockRejectedValueOnce(new Error("device disconnected"));
    await act(async () => { renderer = create(createElement(test.Page, { sid: "old" })); });
    await act(async () => { expect(await test.actions.remove("old")).toBeNull(); });
    expect(test.actions.error).toBe("device disconnected");
    expect(test.actions.busy).toBeNull();
    await act(async () => { expect(await test.actions.remove("old")).toBe(true); });
    expect(test.actions.error).toBeNull();
  });
});
