import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionToolbar } from '../src/renderer/src/workspace/SessionToolbar';
vi.mock('../src/renderer/src/locale', () => ({ useLocale: () => ({ t: (_zh: string, en: string) => en }) }));
afterEach(() => vi.unstubAllGlobals());
function toolbar(status: 'idle' | 'running') {
  vi.stubGlobal('window', { prospero: { platform: 'darwin' } });
  return renderToStaticMarkup(<SessionToolbar session={{ id: 'one', cwd: '/repo', agent: 'codex', kind: 'pty', status }} account={undefined} contextVisible={false} onToggleContext={() => {}} onToggleFocus={() => {}} localSelection onLocalSelectionChange={() => {}} />);
}
describe('session toolbar priorities', () => {
  it('exposes tools, focus and session actions without duplicate project shortcuts', () => {
    const html = toolbar('idle');
    for (const name of ['Toggle tools', 'Enter focus mode', 'Session actions']) expect(html).toContain(`aria-label="${name}"`);
    for (const name of ['Browse project files', 'Search project contents', 'Review Git changes', 'Stop current turn', 'Enable application mouse interaction']) expect(html).not.toContain(`aria-label="${name}"`);
  });
  it('keeps stop immediately accessible while a session runs', () => {
    expect(toolbar('running')).toContain('aria-label="Stop current turn"');
  });
});
