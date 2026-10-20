// Verify the actual renderer consumes one snapshot, then idle HTTP 204s.
const { app } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const createServer = http.createServer;
const counts = { snapshots: 0, idle: 0 };
http.createServer = function(handler) {
  return createServer.call(this, (req, res) => {
    if (/\/session\/preview-shell-\d+\/view/.test(req.url)) {
      res.once('finish', () => { if (res.statusCode === 204) counts.idle++; else if (res.statusCode === 200) counts.snapshots++; });
    }
    handler(req, res);
  });
};
process.argv.push('--attention');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Preview terminal check timed out', counts); app.exit(1); }, 60_000);
app.on('browser-window-created', (_, window) => window.webContents.once('did-finish-load', async () => {
  try {
    const run = source => window.webContents.executeJavaScript(source);
    for (let i = 0; i < 100; i++) {
      if (await run("!!document.querySelector('.workspace-session-link')")) break;
      await delay(100);
    }
    window.show();
    await run("document.querySelector('.workspace-session-link').click()");
    for (let i = 0; i < 100 && counts.idle < 6; i++) await delay(100);
    assert.equal(counts.snapshots, 1, 'Idle terminal must not repeatedly fetch/reset full snapshots');
    assert(counts.idle >= 6, 'Expected sustained idle polling');
    assert(await run("!!document.querySelector('.workspace-session-slot:not([inert]) .xterm')"));
    console.log(JSON.stringify({ ok: true, ...counts }));
    clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error, counts); clearTimeout(deadline); app.exit(1); }
}));
require('./preview-ux.cjs');
