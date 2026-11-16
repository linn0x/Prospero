import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEvent, ResyncRequired, SessionHead } from '@prospero/protocol/rust-daemon';
import { StateStore } from '../src/main/state-store';
import { EVENT_COALESCE_WINDOW_MS, RustRuntime, TIMELINE_LONG_POLL_WAIT_MS } from '../src/main/rust-runtime';
const projection = vi.hoisted(() => vi.fn());
vi.mock('../src/main/rust-orchestration', () => ({ readOrchestrationWindow: projection, orchestrationAction: vi.fn(), settleDispatchInput: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function fixture() {
  let revision = 1;
  const client = {
    events: vi.fn(async () => ({ latestSeq: revision, resyncRequired: false })),
    summary: vi.fn(async () => ({ latestSeq: 1, total: 0, active: 0, archived: 0, attention: 0 })),
    sidebarSessions: vi.fn(async () => ({ latestSeq: 1, items: [] })),
    workspaces: vi.fn(async () => ({ latestSeq: 1, items: [] })),
    health: vi.fn(async () => ({ capabilities: [], persistence: {} })),
    devices: vi.fn(async () => ({ items: [] })), schedules: vi.fn(async () => []),
    agentQueues: vi.fn(async () => ({ queues: [] })), agentControls: vi.fn(async () => ({ controls: [] })),
  };
  const store = { snapshot: () => ({ daemon: { sessions: [] } }), backend: 'api', setApiState: vi.fn(), appendLog: vi.fn() };
  const runtime = new RustRuntime(store as unknown as StateStore, '/synthetic/binary', '/synthetic/directory');
  const connection = { client, pid: 1, baseUrl: 'http://127.0.0.1:1234' };
  Object.assign(runtime, { connection });
  const internal = runtime as unknown as { refresh: (force?: boolean) => Promise<void>; orchestrationSequence: number; orchestrationRetryPending: boolean };
  projection.mockResolvedValue({ runs: [{ id: 'run' }] });
  return { internal, store, connection, setRevision: (value: number) => { revision = value; } };
}
describe('Rust desktop orchestration refresh', () => {
  it('reuses a same-revision snapshot briefly, then refreshes observations', async () => {
    vi.useFakeTimers();
    const { internal, store } = fixture();
    for (let i = 0; i < 10; i++) await internal.refresh();
    expect(projection).toHaveBeenCalledTimes(1);
    expect(store.setApiState.mock.lastCall?.[0].orchestration.runs).toEqual([{ id: 'run' }]);
    vi.advanceTimersByTime(2001);
    await internal.refresh();
    expect(projection).toHaveBeenCalledTimes(2);
  });
  it('refreshes immediately for revision changes, explicit operations and reconnects', async () => {
    const { internal, connection, setRevision } = fixture();
    await internal.refresh();
    setRevision(2); await internal.refresh();
    await internal.refresh(true);
    connection.pid = 2; await internal.refresh();
    expect(projection).toHaveBeenCalledTimes(4);
  });
  it('preserves the last good data and cursor on failure and retries the same version', async () => {
    const { internal, store, setRevision } = fixture();
    await internal.refresh();
    setRevision(2); projection.mockRejectedValueOnce(new Error('temporary'));
    await internal.refresh();
    expect(internal.orchestrationSequence).toBe(1);
    expect(internal.orchestrationRetryPending).toBe(true);
    expect(store.setApiState.mock.lastCall?.[0].orchestration.runs).toEqual([{ id: 'run' }]);
    await internal.refresh();
    expect(internal.orchestrationSequence).toBe(2);
    expect(internal.orchestrationRetryPending).toBe(false);
    expect(projection).toHaveBeenCalledTimes(3);
  });
  it('retains forced refresh intent while another refresh is in flight', async () => {
    const { internal } = fixture();
    await internal.refresh();
    const first = internal.refresh();
    const forced = internal.refresh(true);
    await Promise.all([first, forced]);
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it('coalesces a storm of concurrent refresh(true) calls into at most one queued follow-up readWindow', async () => {
    const { internal, connection } = fixture();
    await internal.refresh();
    projection.mockClear();
    connection.client.sidebarSessions.mockClear();

    let releaseFirst!: () => void;
    connection.client.events.mockImplementationOnce(
      () => new Promise(resolve => { releaseFirst = () => resolve({ latestSeq: 1, resyncRequired: false }); }),
    );

    const inFlight = internal.refresh(true);
    const storm = Array.from({ length: 12 }, () => internal.refresh(true));
    releaseFirst();
    await Promise.all([inFlight, ...storm]);

    // 1 initial in-flight + 1 coalesced queued refresh = 2 total refreshes instead of 13!
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it('skips slow metadata and orchestration refetches on setWorkspaceTabs tab-selection updates', async () => {
    const { internal, store, connection } = fixture();
    const setWorkspaceTabsRpc = vi.fn(async () => ({ ok: true }));
    Object.assign(connection.client, { setWorkspaceTabs: setWorkspaceTabsRpc });
    await internal.refresh();
    projection.mockClear();
    connection.client.health.mockClear();
    connection.client.devices.mockClear();
    connection.client.schedules.mockClear();

    const runtime = internal as unknown as RustRuntime;
    await runtime.setWorkspaceTabs({ workspace: '/project', openSessionIds: ['s1', 's2'], activeSessionId: 's2' });

    expect(setWorkspaceTabsRpc).toHaveBeenCalledTimes(1);
    expect(projection).not.toHaveBeenCalled();
    expect(connection.client.health).not.toHaveBeenCalled();
    expect(connection.client.devices).not.toHaveBeenCalled();
    expect(connection.client.schedules).not.toHaveBeenCalled();
    expect(store.setApiState).toHaveBeenCalled();
  });

  it('paginates active sidebarSessions beyond 100 up to 500 sessions without dropping tabs 101+', async () => {
    const { internal, store, connection } = fixture();
    const allActive = Array.from({ length: 240 }, (_, index) => ({
      id: `active-${index + 1}`,
      agent: 'codex',
      kind: 'pty',
      title: `Tab ${index + 1}`,
      workspace: '/project',
      lifecycle: 'active',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      revision: 1,
    }));
    connection.client.summary.mockResolvedValue({ latestSeq: 5, total: 240, active: 240, archived: 0, attention: 0 });
    connection.client.sidebarSessions.mockImplementation(async (query?: { lifecycle?: string; cursor?: string | null; limit?: number }) => {
      if (query?.lifecycle === 'archived') return { latestSeq: 5, items: [], total: 0 };
      const offset = query?.cursor ? Number(query.cursor) : 0;
      const limit = query?.limit ?? 100;
      const slice = allActive.slice(offset, offset + limit);
      const nextOffset = offset + slice.length;
      return {
        latestSeq: 5,
        items: slice,
        total: allActive.length,
        ...(nextOffset < allActive.length ? { nextCursor: String(nextOffset) } : {}),
      };
    });

    await internal.refresh(true);
    const apiState = store.setApiState.mock.lastCall?.[0];
    expect(apiState.status.sessions).toHaveLength(240);
    expect(apiState.status.sessions[239].id).toBe('active-240');
    expect(apiState.status.sessionSummary.activeLimit).toBe(500);
  });

  it('passes waitMs: 15_000 when reading timeline changes from the daemon', async () => {
    const { internal, connection } = fixture();
    const runtime = internal as unknown as RustRuntime;
    const abort = new AbortController();
    await runtime.readTimelineChanges('session-1', 42, abort.signal);
    expect(connection.client.events).toHaveBeenCalledWith(
      { scope: 'timeline:session-1', afterSeq: 42, limit: 100, waitMs: TIMELINE_LONG_POLL_WAIT_MS },
      expect.any(AbortSignal),
    );
  });

  it('coalesces bursty SSE session.updated events over 16ms into a single targeted sidebarLookup + patchApiSessions', async () => {
    vi.useFakeTimers();
    const sessionHeads: SessionHead[] = Array.from({ length: 5 }, (_, index) => ({
      id: `s-${index + 1}`,
      agent: 'codex',
      kind: 'structured',
      title: `Session ${index + 1}`,
      workspace: '/synthetic',
      lifecycle: 'active',
      status: 'idle',
      createdAt: index + 1,
      updatedAt: index + 1,
      revision: 1,
    }));

    const streamHandlers = new Map<string, { onChange: (event: ChangeEvent) => void; onResync: (resync: ResyncRequired) => void }>();
    const subscribeEvents = vi.fn((
      query: { scope: string; afterSeq: number },
      handlers: { onChange: (event: ChangeEvent) => void; onResync: (resync: ResyncRequired) => void },
      signal: AbortSignal,
    ) => {
      streamHandlers.set(query.scope, handlers);
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const sidebarLookup = vi.fn(async (ids: string[]) => ({
      items: ids.map((id) => {
        const base = sessionHeads.find((head) => head.id === id)!;
        return { ...base, status: 'running' as const, busySince: 500, revision: 2 };
      }),
    }));

    const client = {
      events: vi.fn(async () => ({ latestSeq: 10, resyncRequired: false })),
      subscribeEvents,
      sidebarLookup,
      summary: vi.fn(async () => ({ latestSeq: 10, total: 5, active: 5, archived: 0, attention: 0 })),
      sidebarSessions: vi.fn(async (query?: { lifecycle?: string }) => ({
        latestSeq: 10,
        items: query?.lifecycle === 'archived' ? [] : sessionHeads,
      })),
      workspaces: vi.fn(async () => ({
        latestSeq: 10,
        items: [{ workspace: '/synthetic', summary: { revision: 10, total: 5, active: 5, archived: 0, attention: 0 } }],
      })),
      health: vi.fn(async () => ({ capabilities: ['session.lifecycle.v1'], persistence: { pty: true, structured: true } })),
      devices: vi.fn(async () => ({ items: [] })),
      schedules: vi.fn(async () => []),
      agentQueues: vi.fn(async () => ({ queues: [] })),
      agentControls: vi.fn(async () => ({ controls: [] })),
    };

    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const tempHome = mkdtempSync(resolve(tmpdir(), 'prospero-sse-runtime-'));
    try {
      const store = new StateStore(tempHome, 'api');
      const patchSpy = vi.spyOn(store, 'patchApiSessions');
      const setApiSpy = vi.spyOn(store, 'setApiState');
      projection.mockResolvedValue({ runs: [] });

      const runtime = new RustRuntime(store, '/synthetic/binary', tempHome);
      const internal = runtime as unknown as {
        connection: unknown;
        ready: boolean;
        refresh: (force?: boolean) => Promise<void>;
        ensureEventStreams: () => void;
        stopEventStreams: () => void;
      };
      internal.connection = { client, pid: 77, baseUrl: 'http://127.0.0.1:1234' };
      await internal.refresh();
      internal.ready = true;
      internal.ensureEventStreams();

      expect(subscribeEvents).toHaveBeenCalledTimes(2);
      const beforeSnapshot = store.snapshot();
      client.sidebarSessions.mockClear();
      client.summary.mockClear();
      client.workspaces.mockClear();
      setApiSpy.mockClear();
      patchSpy.mockClear();

      const sessionStream = streamHandlers.get('sessions')!;
      // Emit 3 rapid session.updated ticks within the 16ms micro-batch window (2 for s-2, 1 for s-4)
      sessionStream.onChange({ scope: 'sessions', seq: 11, kind: 'session.updated', entityId: 's-2', data: {} });
      sessionStream.onChange({ scope: 'sessions', seq: 12, kind: 'session.updated', entityId: 's-4', data: {} });
      sessionStream.onChange({ scope: 'sessions', seq: 13, kind: 'session.updated', entityId: 's-2', data: {} });

      await vi.advanceTimersByTimeAsync(EVENT_COALESCE_WINDOW_MS);

      expect(sidebarLookup).toHaveBeenCalledTimes(1);
      expect(sidebarLookup.mock.calls[0]?.[0]).toEqual(['s-2', 's-4']);
      expect(patchSpy).toHaveBeenCalledTimes(1);
      expect(setApiSpy).not.toHaveBeenCalled();
      expect(client.sidebarSessions).not.toHaveBeenCalled();
      expect(client.summary).not.toHaveBeenCalled();
      expect(client.workspaces).not.toHaveBeenCalled();

      const afterSnapshot = store.snapshot();
      expect(afterSnapshot.daemon.metadataRevision).toBe('77:13');
      expect(afterSnapshot.daemon.sessions.find((item) => item.id === 's-2')?.status).toBe('running');
      expect(afterSnapshot.daemon.sessions.find((item) => item.id === 's-4')?.status).toBe('running');
      // Untouched sessions retain exact === object identity
      expect(afterSnapshot.daemon.sessions[0]).toBe(beforeSnapshot.daemon.sessions[0]);
      expect(afterSnapshot.daemon.sessions[2]).toBe(beforeSnapshot.daemon.sessions[2]);
      expect(afterSnapshot.daemon.sessions[4]).toBe(beforeSnapshot.daemon.sessions[4]);

      // Non-targeted session.created falls back to full refresh()
      sessionStream.onChange({ scope: 'sessions', seq: 14, kind: 'session.created', entityId: 's-new', data: {} });
      await vi.advanceTimersByTimeAsync(EVENT_COALESCE_WINDOW_MS);
      expect(client.sidebarSessions).toHaveBeenCalled();
      expect(setApiSpy).toHaveBeenCalledTimes(1);

      internal.stopEventStreams();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
