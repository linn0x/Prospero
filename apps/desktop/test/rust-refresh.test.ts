import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateStore } from '../src/main/state-store';
import { RustRuntime } from '../src/main/rust-runtime';
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
});
