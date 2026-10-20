import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
const execute = promisify(execFile);

it('forks real SDK transcripts offline with independent IDs and frozen history', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prospero-claude-fork-')));
  try {
    const workspace = join(root, 'project'); mkdirSync(workspace);
    const config = join(root, 'claude');
    const project = join(config, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    const sessionId = randomUUID(), userId = randomUUID(), assistantId = randomUUID();
    const common = { sessionId, cwd: workspace, isSidechain: false, timestamp: new Date().toISOString(), version: '2.1.0' };
    const records = [
      { ...common, type: 'user', uuid: userId, parentUuid: null, message: { role: 'user', content: 'Original question' } },
      { ...common, type: 'assistant', uuid: assistantId, parentUuid: userId, message: { role: 'assistant', type: 'message', id: 'msg_fixture', model: 'fixture', content: [{ type: 'text', text: 'Original answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const source = join(project, sessionId + '.jsonl');
    const original = records.map(value => JSON.stringify(value)).join('\n') + '\n';
    writeFileSync(source, original);
    const helper = resolve(import.meta.dirname, '../dist/claude-session-fork.js');
    const { stdout } = await execute(process.execPath, [helper, sessionId, workspace], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, timeout: 20_000 });
    const fork = JSON.parse(stdout) as { sessionId: string };
    expect(fork.sessionId).not.toBe(sessionId);
    expect(readFileSync(source, 'utf8')).toBe(original);
    const target = join(project, fork.sessionId + '.jsonl');
    const copied = readFileSync(target, 'utf8');
    expect(copied).toContain('Original question'); expect(copied).toContain('Original answer');
    const messages = copied.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'user' || row.type === 'assistant');
    expect(messages).toHaveLength(2);
    expect(messages[0].uuid).not.toBe(userId);
    expect(messages[1].parentUuid).toBe(messages[0].uuid);
    appendFileSync(source, JSON.stringify({ ...common, type: 'user', uuid: randomUUID(), parentUuid: assistantId, message: { role: 'user', content: 'Later source message' } }) + '\n');
    expect(readFileSync(target, 'utf8')).toBe(copied);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
