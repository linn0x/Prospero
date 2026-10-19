// Isolated PTY-daemon output throughput benchmark. It uses a private profile,
// daemon, workspace, and terminal; it never connects to the user's daemon.
// Run from apps/desktop with Electron after `npm run build`.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '../../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'prospero-output-throughput-'));
const rustHome = path.join(fixture, 'rust');
const workspace = path.join(fixture, 'workspace');
const cols = Number(process.env.PROSPERO_BENCH_COLS || 174);
const rows = Number(process.env.PROSPERO_BENCH_ROWS || 64);
const frames = Number(process.env.PROSPERO_BENCH_FRAMES || 600);
const outputDir = path.join(root, 'output/daemon-output-throughput');
fs.mkdirSync(path.join(rustHome, 'desktop'), { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(rustHome, 'desktop/desktop.json'), JSON.stringify({
  projects: [workspace],
  settings: { startDaemonOnLaunch: true, minimizeToTray: false, theme: 'dark' },
}));
Object.assign(process.env, {
  PROSPERO_BACKEND: 'rust',
  PROSPERO_RUST_HOME: rustHome,
  PROSPERO_HOME: path.join(fixture, 'legacy'),
  PROSPERO_RUST_BINARY: process.env.PROSPERO_RUST_BINARY || path.join(root, 'apps/desktop/.runtime/prosperod-rs'),
  PROSPERO_RUNTIME_SWITCH_FILE: path.join(fixture, 'backend.json'),
  PROSPERO_NATIVE_GHOSTTY: '0',
});
app.setPath('userData', path.join(rustHome, 'electron'));

const Kind = { Snapshot: 2, Output: 3, Resize: 4, Error: 6, Ready: 8, Input: 16, Applied: 17, Result: 20, Attach: 32 };
const json = value => Buffer.from(JSON.stringify(value));
function encode(kind, sequence, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(16);
  header[0] = 1;
  header[1] = kind;
  header.writeBigUInt64BE(BigInt(sequence), 4);
  header.writeUInt32BE(payload.length, 12);
  return Buffer.concat([header, payload]);
}
function decode(raw) {
  const bytes = Buffer.from(raw);
  return { kind: bytes[1], sequence: Number(bytes.readBigUInt64BE(4)), payload: bytes.subarray(16) };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let connection;
let sessionId;
let peer;
let finished = false;

async function request(route, data) {
  const response = await fetch(connection.baseUrl + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function cleanup() {
  try { peer?.close(); } catch {}
  if (connection) {
    if (sessionId) await request(`/v1/terminals/${sessionId}/close`, {}).catch(() => {});
    await request('/v1/shutdown', {}).catch(() => {});
  }
  const hosts = path.join(rustHome, 'daemon/terminal-hosts');
  if (fs.existsSync(hosts)) {
    for (const id of fs.readdirSync(hosts)) {
      try {
        const host = JSON.parse(fs.readFileSync(path.join(hosts, id, 'host.json'), 'utf8'));
        const call = action => fetch(new URL(action, host.base_url), {
          method: 'POST', headers: { authorization: `Bearer ${host.token}` }, signal: AbortSignal.timeout(2000),
        });
        await call('close').catch(() => {});
        for (let attempt = 0; attempt < 30; attempt++) {
          const result = await call('release').catch(() => undefined);
          if (!result || result.ok) break;
          await delay(50);
        }
      } catch {}
    }
  }
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}

const deadline = setTimeout(() => {
  if (finished) return;
  finished = true;
  console.error('daemon output throughput benchmark timed out');
  void cleanup().finally(() => app.exit(1));
}, 30000);

app.on('browser-window-created', (_event, window) => window.webContents.once('did-finish-load', async () => {
  try {
    window.hide();
    const connectionPath = path.join(rustHome, 'daemon/connection.json');
    for (let i = 0; i < 200 && !fs.existsSync(connectionPath); i++) await delay(50);
    connection = JSON.parse(fs.readFileSync(connectionPath, 'utf8'));

    const python = `import os\nrows=${rows}; cols=${cols}\ndef write_all(data):\n    remaining=memoryview(data)\n    while remaining:\n        remaining=remaining[os.write(1,remaining):]\nwrite_all(bytes([10])+b"PROSPERO_BENCH_START_7A31"+bytes([10]))\nfor i in range(${frames}):\n    row=(f"frame={i:04d} " + ("0123456789abcdef"*((cols//16)+1)))[:cols]\n    body=("\\x1b[2J\\x1b[H" + "\\n".join([row]+[f"{j:02d} "+(chr(65+(i+j)%26)*(cols-3)) for j in range(1,rows)]) + "\\n").encode()\n    write_all(body)\nwrite_all(bytes([10])+b"PROSPERO_BENCH_END_7A31"+bytes([10]))`;
    const keepAlive = process.env.PROSPERO_BENCH_KEEPALIVE !== '0';
    const shellQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
    const terminal = await request('/v1/terminals', {
      title: 'Isolated output-throughput fixture', agent: 'custom', workspace,
      size: { cols, rows },
      command: `stty -echo; IFS= read -r start; python3 -u -c ${shellQuote(python)}${keepAlive ? '; cat' : ''}`,
    });
    sessionId = terminal.id;
    peer = new WebSocket(connection.baseUrl.replace(/^http/, 'ws') + `/v1/terminals/${sessionId}/stream`, {
      headers: { authorization: `Bearer ${connection.token}` },
    });
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    let startInputResolve;
    let startInputReject;
    const startInputResult = new Promise((resolve, reject) => { startInputResolve = resolve; startInputReject = reject; });
    const startInputSequence = 1;
    const beginMarker = Buffer.from('PROSPERO_BENCH_START_7A31');
    const endMarker = Buffer.from('PROSPERO_BENCH_END_7A31');
    let markerCarry = Buffer.alloc(0);
    let startedAt = null;
    let lastAt = null;
    let endedAt = null;
    let measuredBytes = 0;
    let outputBytes = 0;
    let outputFrames = 0;
    const gaps = [];
    peer.on('message', raw => {
      const frame = decode(raw);
      if ([Kind.Snapshot, Kind.Output, Kind.Resize].includes(frame.kind)) {
        if (frame.kind === Kind.Output) {
          outputBytes += frame.payload.length;
          outputFrames++;
          const now = performance.now();
          const searchable = markerCarry.length ? Buffer.concat([markerCarry, frame.payload]) : frame.payload;
          if (startedAt === null && searchable.includes(beginMarker)) {
            startedAt = now;
            lastAt = now;
            console.log(`benchmark start marker at frame ${outputFrames}`);
          } else if (startedAt !== null && endedAt === null) {
            gaps.push(now - lastAt);
            lastAt = now;
            measuredBytes += frame.payload.length;
            if (searchable.includes(endMarker)) {
              endedAt = now;
              console.log(`benchmark end marker at frame ${outputFrames}`);
            }
          }
          markerCarry = searchable.subarray(Math.max(0, searchable.length - Math.max(beginMarker.length, endMarker.length) + 1));
          if (outputFrames % 1000 === 0) console.log(`benchmark output progress: frames=${outputFrames}, bytes=${outputBytes}, started=${startedAt !== null}`);
        }
        peer.send(encode(Kind.Applied, frame.sequence));
        if (endedAt !== null && !finished) {
          finished = true;
          const sorted = [...gaps].sort((a, b) => a - b);
          const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0;
          const elapsedMs = endedAt - startedAt;
          const result = {
            isolatedDaemon: true,
            fixture: `${frames} full-screen ANSI clears/repaints at ${cols}x${rows}`,
            keepAlive,
            elapsedMs: +elapsedMs.toFixed(2),
            approximateMeasuredBytes: measuredBytes,
            throughputMiBps: +(measuredBytes / 1048576 / (elapsedMs / 1000)).toFixed(2),
            outputFrames,
            outputBytes,
            interFrameGapsMs: {
              samples: gaps.length,
              p50: +percentile(0.5).toFixed(2),
              p95: +percentile(0.95).toFixed(2),
              p99: +percentile(0.99).toFixed(2),
              max: +Math.max(0, ...gaps).toFixed(2),
            },
          };
          fs.mkdirSync(outputDir, { recursive: true });
          fs.writeFileSync(path.join(outputDir, 'latest.json'), JSON.stringify(result, null, 2));
          console.log(JSON.stringify(result));
          clearTimeout(deadline);
          void cleanup().finally(() => app.exit(0));
        }
      } else if (frame.kind === Kind.Ready) readyResolve();
      else if (frame.kind === Kind.Result && frame.sequence === startInputSequence) {
        const result = JSON.parse(frame.payload.toString('utf8'));
        if (result.ok) startInputResolve();
        else startInputReject(new Error(`fixture start input rejected: ${result.code}`));
      }
      else if (frame.kind === Kind.Error && !finished) {
        finished = true;
        console.error('terminal stream error:', frame.payload.toString());
        clearTimeout(deadline);
        void cleanup().finally(() => app.exit(2));
      }
    });
    peer.on('error', error => {
      if (!finished) {
        finished = true;
        console.error(error);
        clearTimeout(deadline);
        void cleanup().finally(() => app.exit(2));
      }
    });
    peer.on('close', (code, reason) => {
      if (!finished) {
        finished = true;
        console.error(`terminal stream closed before benchmark completion: code=${code} reason=${reason.toString()} frames=${outputFrames} bytes=${outputBytes}`);
        clearTimeout(deadline);
        void cleanup().finally(() => app.exit(2));
      }
    });
    await new Promise((resolve, reject) => {
      peer.once('open', resolve);
      peer.once('error', reject);
    });
    peer.send(encode(Kind.Attach, 0, json({ wantControl: true })));
    await ready;
    peer.send(encode(Kind.Input, startInputSequence, Buffer.from('\n')));
    await startInputResult;
  } catch (error) {
    if (!finished) {
      finished = true;
      console.error(error);
      clearTimeout(deadline);
      await cleanup();
      app.exit(1);
    }
  }
}));

import(pathToFileURL(path.join(root, 'apps/desktop/out/main/index.js')).href)
  .catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
