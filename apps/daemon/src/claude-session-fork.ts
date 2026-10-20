/** Offline Claude transcript fork. Runs in the source account's environment. */
import { isAbsolute } from 'node:path';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';

const [source, directory] = process.argv.slice(2);
try {
  if (!source || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source)
    || !directory || !isAbsolute(directory)) throw new Error('Invalid Claude session or workspace');
  const fork = await forkSession(source, { dir: directory });
  if (!fork.sessionId || fork.sessionId === source) throw new Error('Claude did not create an independent session');
  process.stdout.write(JSON.stringify({ sessionId: fork.sessionId }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 2000) : 'Unable to fork Claude session' }) + '\n');
  process.exitCode = 1;
}
