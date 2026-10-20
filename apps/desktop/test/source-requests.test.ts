import { describe, expect, it, vi } from 'vitest';
import type { S2CModelSourceResult } from '../src/shared/types';
import { createSourceRequester } from '../src/renderer/src/model-sources/source-requests';
const result = { type: 'model.source.result', requestId: 'test', ok: true, sources: [] } as S2CModelSourceResult;
describe('model source concurrent reads', () => {
  it('turns 20 concurrent reads into one request without caching later reads', async () => {
    const send = vi.fn().mockResolvedValue(result);
    const run = createSourceRequester(send);
    await Promise.all(Array.from({ length: 20 }, () => run({ kind: 'list' })));
    expect(send).toHaveBeenCalledTimes(1);
    await run({ kind: 'list' });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('allows retry after a failed list', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ...result, ok: false, error: { message: 'offline' } }).mockResolvedValue(result);
    const run = createSourceRequester(send);
    await expect(run({ kind: 'list' })).rejects.toThrow('offline');
    await expect(run({ kind: 'list' })).resolves.toBe(result);
  });
  it('does not join an old list across a configuration write', async () => {
    let complete!: (value: S2CModelSourceResult) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<S2CModelSourceResult>(resolve => { complete = resolve; })).mockResolvedValue(result);
    const run = createSourceRequester(send);
    const old = run({ kind: 'list' });
    await run({ kind: 'update', sourceId: 'source', revision: 1, name: 'New name' });
    const fresh = run({ kind: 'list' });
    expect(fresh).not.toBe(old);
    complete(result);
    await Promise.all([old, fresh]);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

it('coalesces matching catalogs but separates versions, credentials and forced refresh', async () => {
  const send = vi.fn().mockResolvedValue(result);
  const run = createSourceRequester(send);
  const action = { kind: 'models' as const, sourceId: 'source', revision: 1, protocol: 'anthropic' as const, credentialId: 'key' };
  await Promise.all([
    ...Array.from({ length: 20 }, () => run(action)),
    run({ ...action, revision: 2 }),
    run({ ...action, credentialId: 'other' }),
    run({ ...action, refresh: true }),
  ]);
  expect(send).toHaveBeenCalledTimes(4);
  await run(action);
  expect(send).toHaveBeenCalledTimes(5);
});

it('does not retain a failed catalog or reuse it across configuration writes', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(result);
  const run = createSourceRequester(send);
  const action = { kind: 'models' as const, sourceId: 'source', revision: 1, protocol: 'anthropic' as const, credentialId: 'key' };
  await expect(run(action)).rejects.toThrow('offline');
  const old = run(action);
  const update = run({ kind: 'update', sourceId: 'source', revision: 1, name: 'Changed' });
  const fresh = run(action);
  expect(fresh).not.toBe(old);
  await Promise.all([old, update, fresh]);
  expect(send).toHaveBeenCalledTimes(4);
});
