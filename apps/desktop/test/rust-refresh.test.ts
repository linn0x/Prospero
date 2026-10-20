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
  const store = { backend: 'api', setApiState: vi.fn(), appendLog: vi.fn() };
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
});
