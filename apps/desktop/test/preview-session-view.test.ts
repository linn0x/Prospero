import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const view = createRequire(import.meta.url)('../scripts/preview-session-view.cjs');
describe('isolated preview terminal protocol', () => {
  it('bootstraps once and does not reset an idle terminal on subsequent polls', () => {
    const session = { kind: 'pty' };
    const first = view(session, null);
    expect(first).toMatchObject({ kind: 'pty', mode: 'snapshot', seq: 1, caughtUp: true });
    expect(first.ansi).toContain('Prospero isolated terminal preview');
    for (let poll = 0; poll < 100; poll++) expect(view(session, String(first.seq))).toBeNull();
    // A newly opened renderer still receives the authoritative snapshot.
    expect(view(session, null)).toEqual(first);
  });
  it('recovers a stale cursor with a full snapshot, never a malformed delta', () => {
    for (const cursor of ['0', '2', 'invalid']) expect(view({ kind: 'pty' }, cursor).mode).toBe('snapshot');
  });
  it('does not send PTY data to a structured conversation', () => {
    expect(view({ kind: 'structured' }, null)).toEqual({ mode: 'snapshot', events: [], evSeq: 0 });
  });
});
