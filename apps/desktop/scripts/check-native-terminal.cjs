// Full app + native NSView + relay + isolated Rust daemon. No production
// profile, daemon, credentials, or sessions are used by this check.
const { app, clipboard } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'prospero-native-integration-'));
const rustHome = path.join(fixture, 'rust');
const project = path.join(fixture, 'project');
const output = path.join(root, 'output/native-ghostty');
for (const dir of [path.join(rustHome, 'desktop'), project, output]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(rustHome, 'desktop/desktop.json'), JSON.stringify({ projects: [project], settings: { startDaemonOnLaunch: true, minimizeToTray: false, theme: 'dark' } }));
Object.assign(process.env, {
  PROSPERO_BACKEND: 'rust', PROSPERO_NATIVE_GHOSTTY: '1',
  PROSPERO_NATIVE_GHOSTTY_DEBUG: '1',
  PROSPERO_NATIVE_GHOSTTY_DIR: path.join(root, 'apps/desktop/.native/ghostty'),
  PROSPERO_RUST_HOME: rustHome, PROSPERO_HOME: path.join(fixture, 'legacy'),
  PROSPERO_RUST_BINARY: process.env.PROSPERO_RUST_BINARY || path.join(root, 'apps/desktop/.runtime/prosperod-rs'),
  PROSPERO_RUNTIME_SWITCH_FILE: path.join(fixture, 'backend.json'),
});
app.setPath('userData', path.join(fixture, 'electron'));
const native = require(path.join(root, 'apps/desktop/.native/ghostty/ghostty.node'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let connection;
const sessionIds = [];
async function request(route, data) {
  const response = await fetch(connection.baseUrl + route, { method: data === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(10000) });
  assert(response.ok, `${route}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response.json();
}
async function cleanup() {
  if (!connection) return;
  for (const id of sessionIds) await request(`/v1/terminals/${id}/close`, {}).catch(() => {});
  await request('/v1/shutdown', {}).catch(() => {});
  const hosts = path.join(rustHome, 'daemon/terminal-hosts');
  if (fs.existsSync(hosts)) for (const id of fs.readdirSync(hosts)) {
    try {
      const host = JSON.parse(fs.readFileSync(path.join(hosts, id, 'host.json'), 'utf8'));
      const base = new URL(host.base_url); assert.equal(base.hostname, '127.0.0.1');
      const call = action => fetch(new URL(action, base), { method: 'POST', headers: { authorization: 'Bearer ' + host.token }, signal: AbortSignal.timeout(2000) });
      await call('close').catch(() => {});
      for (let i = 0; i < 30; i++) { const result = await call('release').catch(() => undefined); if (!result || result.ok) break; await delay(50); }
    } catch {}
  }
  fs.rmSync(fixture, { recursive: true, force: true });
}
const deadline = setTimeout(() => { console.error('Native integration timed out'); void cleanup().finally(() => app.exit(1)); }, 90000);
app.on('browser-window-created', (_event, window) => window.webContents.once('did-finish-load', async () => {
  const wc = window.webContents;
  // Keep ResizeObserver/animation-frame layout checks running when another
  // isolated fixture or the user brings a different app to the foreground.
  wc.setBackgroundThrottling(false);
  wc.on('console-message', details => { if (details.message?.includes('[native-terminal-focus]')) console.log(details.message); });
  const send = wc.send.bind(wc);
  wc.send = (channel, ...args) => { if (channel.startsWith('native-terminal:')) console.log(channel, JSON.stringify(args)); return send(channel, ...args); };
  const run = source => wc.executeJavaScript(source, true);
  const wait = async (condition, label) => {
    for (let i = 0; i < 200; i++) { if (await condition()) return; await delay(50); }
    throw new Error('Timed out: ' + label);
  };
  const hostId = () => run("Number(document.querySelector('#workspace-session-panel .native-terminal-host')?.dataset.nativeId || 0)");
  try {
    window.setMinimumSize(600, 400); window.setSize(1200, 850); window.show(); app.focus({ steal: true }); window.focus();
    await wait(() => run("Boolean(document.querySelector('.prospero-shell'))"), 'shell');
    console.log('native availability', await run('window.prospero.nativeTerminal.available()'));
    const connectionFile = path.join(rustHome, 'daemon/connection.json');
    await wait(() => fs.existsSync(connectionFile), 'isolated daemon');
    connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
    const session = await request('/v1/terminals', { title: 'Native Ghostty fixture', agent: 'custom', workspace: project, size: { cols: 80, rows: 24 }, command: "stty raw -echo; printf 'NATIVE_READY\r\n中文显示\r\n'; cat" });
    sessionIds.push(session.id);
    await run(`localStorage.setItem('prospero.activeView','workspaces');localStorage.setItem('prospero.activeSession',${JSON.stringify(session.id)});localStorage.setItem('prospero.openSessions',JSON.stringify([${JSON.stringify(session.id)}]));localStorage.setItem('prospero.workspaceFocus','true')`);
    await new Promise(resolve => { wc.once('did-finish-load', resolve); wc.reload(); });
    await wait(async () => (await hostId()) > 0, 'native host');
    await wait(async () => { try { return native.readText(await hostId()).includes('NATIVE_READY'); } catch { return false; } }, 'native stream output');
    const id = await hostId();
    console.log('native id', id);
    assert(native.readText(id).includes('中文显示'), 'UTF-8 Chinese terminal output');
    assert.equal(await run("Boolean(document.querySelector('#workspace-session-panel .xterm'))"), false, 'native session must not mount xterm');
    assert.equal(await run("Boolean(document.querySelector('.workspace-focus-controls'))"), false, 'native focus has no mouse-mode toolbar');
    assert.equal(await run("Boolean(document.querySelector('#workspace-session-panel .terminal-status, #workspace-session-panel .native-terminal-footer'))"), false, 'native terminal has no persistent status or error bars');
    const sizeBefore = native.size(id);
    native.inputText(id, 'NATIVE_INPUT_中文');
    await wait(() => native.readText(id).includes('NATIVE_INPUT_中文'), 'input through native PTY relay');
    window.setSize(1050, 750);
    await wait(() => native.size(id).columns !== sizeBefore.columns, 'native resize');
    // A modal must cover the native surface; hidden native views must not steal
    // focus from Chromium. Removing it restores the same surface/session.
    await run("(()=>{const d=document.createElement('div');d.id='native-test-dialog';d.setAttribute('role','dialog');d.style.cssText='position:fixed;inset:80px;background:#222;z-index:99999';d.innerHTML='<input aria-label=\"test modal input\">';document.body.append(d);d.querySelector('input').focus()})()");
    await delay(200);
    assert.equal(native.isVisible(id), false, 'native surface hidden under DOM dialog');
    await run("document.getElementById('native-test-dialog').remove()");
    await wait(() => native.isVisible(id), 'native surface restored after modal');
    assert.equal(await hostId(), id, 'modal must not recreate the terminal');
    fs.writeFileSync(path.join(output, 'electron-shell.png'), (await wc.capturePage()).toPNG());
    if (native.capture) native.capture(id, path.join(output, 'native-terminal.png'));
    // Recreating the renderer must detach rather than terminate the session.
    await new Promise(resolve => { wc.once('did-finish-load', resolve); wc.reload(); });
    await wait(async () => (await hostId()) > 0 && (await hostId()) !== id, 'native reattach');
    const restoredId = await hostId();
    await wait(() => native.readText(restoredId).includes('NATIVE_INPUT_中文'), 'daemon snapshot restore');
    const health = await request('/v1/health');
    assert.equal(health.activeRuntimeSessions, 1, 'surface recreation did not launch a second agent');
    const result = { ok: true, checks: ['native surface (no xterm)', 'Chinese output', 'native input through relay', 'resize', 'modal occlusion', 'snapshot reattach', 'same daemon session'], size: native.size(restoredId), output };
    fs.writeFileSync(path.join(output, 'integration.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    if (process.argv.includes('--preview')) {
      const stopFile = path.join(fixture, 'finish-preview');
      console.log(`Native preview ready for visual inspection; touch ${stopFile} to finish.`);
      const end = Date.now() + Number(process.env.PROSPERO_PREVIEW_MS || 180000);
      while (Date.now() < end && !fs.existsSync(stopFile)) await delay(500);
    }
    await cleanup(); app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await run("document.querySelector('#workspace-session-panel')?.textContent").catch(() => 'renderer unavailable'));
    clearTimeout(deadline); await cleanup(); app.exit(1);
  }
}));
import(pathToFileURL(path.join(root, 'apps/desktop/out/main/index.js')).href).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
// Keep fixture metadata on native crashes so orphaned test hosts can be
// identified and stopped; only successful explicit cleanup removes it.
