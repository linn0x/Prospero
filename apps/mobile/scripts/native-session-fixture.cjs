#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const args = process.argv.slice(2);
const file = process.env.PROSPERO_NATIVE_FIXTURE;
const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const save = data => {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data));
  fs.renameSync(temporary, file);
};
const flag = name => args[args.indexOf(name) + 1];
if (args.includes('--help')) {
  console.log('Codex CLI\n --remote\n - on-request: ask\n - never: skip\n --permission-mode <mode> (choices: manual, acceptEdits, bypassPermissions)');
  process.exit(0);
}
if (args.includes('app-server')) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    const data = load();
    const params = request.params || {};
    let result = {};
    if (request.method === 'thread/start') {
      const id = crypto.randomUUID();
      data[id] = { id, cwd: process.cwd(), title: 'Fixture', preview: 'Fixture history', messages: [], ephemeral: params.ephemeral === true };
      save(data);
      result = { thread: data[id] };
    } else if (request.method === 'thread/resume' || request.method === 'thread/read') {
      if (!data[params.threadId]) { console.log(JSON.stringify({ id: request.id, error: { code: -32000, message: 'no rollout found' } })); return; }
      result = { thread: data[params.threadId] };
    } else if (request.method === 'thread/list' || request.method === 'thread/search') {
      result = { data: Object.values(data) };
    } else if (request.method === 'turn/start') {
      data[params.threadId].messages.push(params.text);
      save(data);
      result = { count: data[params.threadId].messages.length };
    }
    if (request.id !== undefined) console.log(JSON.stringify({ id: request.id, result }));
  });
} else if (args.includes('--remote')) {
  const socket = new WebSocket(flag('--remote'), { headers: { authorization: 'Bearer ' + process.env[flag('--remote-auth-token-env')] } });
  let next = 0;
  let nativeId;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.on('message', bytes => {
    const value = JSON.parse(bytes.toString());
    const callback = pending.get(value.id);
    if (!callback) return;
    pending.delete(value.id);
    if (value.error) callback.reject(new Error(value.error.message)); else callback.resolve(value.result);
  });
  socket.on('close', () => process.exit(0));
  socket.on('open', async () => {
    try {
      await call('initialize');
      const resume = args[0] === 'resume';
      const result = await call(resume ? 'thread/resume' : 'thread/start', resume ? { threadId: args[1] } : { cwd: process.cwd() });
      nativeId = result.thread.id;
      console.log('NATIVE=' + nativeId + ' COUNT=' + result.thread.messages.length);
      const lines = readline.createInterface({ input: process.stdin });
      lines.on('line', async line => {
        if (line === '/clear') nativeId = (await call('thread/start', { cwd: process.cwd() })).thread.id;
        else {
          await call('turn/start', { threadId: nativeId, text: line });
          const temporary = await call('thread/start', { cwd: process.cwd(), ephemeral: true, threadSource: 'thread_title' });
          await call('turn/start', { threadId: temporary.thread.id, text: 'temporary title task' });
        }
        console.log('ACK=' + nativeId);
      });
    } catch (error) { console.error(error.message); process.exit(1); }
  });
} else {
  let id = args.includes('--resume') ? flag('--resume') : flag('--session-id');
  const data = load();
  if (args.includes('--resume') && !data[id]) { console.error('missing conversation'); process.exit(1); }
  if (!data[id]) { data[id] = { id, cwd: process.cwd(), messages: [] }; save(data); }
  const settings = JSON.parse(flag('--settings'));
  const notify = () => {
    const hook = settings.hooks.SessionStart[0].hooks[0].command;
    const result = spawnSync(hook, { shell: true, input: JSON.stringify({ session_id: id, cwd: process.cwd() }), env: process.env });
    if (result.status) process.exit(1);
  };
  notify();
  console.log('NATIVE=' + id + ' COUNT=' + data[id].messages.length);
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const data = load();
    if (line === '/clear') { id = crypto.randomUUID(); data[id] = { id, cwd: process.cwd(), messages: [] }; save(data); notify(); }
    else { data[id].messages.push(line); save(data); }
    console.log('ACK=' + id);
  });
}
