// Exercise a failed model catalog and an in-place retry using synthetic data.
// Run after building: electron scripts/check-model-retry.cjs
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prospero-model-retry-'));
process.env.PROSPERO_PREVIEW_MODEL_READY_FILE = path.join(root, 'ready');
process.argv.push('--model-retry');
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Model retry check timed out'); app.exit(1); }, 60_000);
app.on('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    const wc = window.webContents;
    const run = source => wc.executeJavaScript(source);
    const until = async predicate => {
      for (let i = 0; i < 100; i++) { if (await run(predicate)) return; await delay(100); }
      throw new Error(`Timed out waiting for: ${predicate}`);
    };
    try {
      await until("!!document.querySelector('.sidebar-new-session')");
      await run("document.querySelector('.sidebar-new-session').click()");
      await until("!!document.querySelector('#session-model-error') && !!document.querySelector('.session-retry-models')");
      await run("document.getElementById('session-approval').value='strict';document.getElementById('session-approval').dispatchEvent(new Event('change',{bubbles:true}))");
      const choices = () => run("JSON.stringify(['session-project','session-agent','session-kind','session-approval'].map(id=>document.getElementById(id).value))");
      const before = await choices();
      fs.writeFileSync(process.env.PROSPERO_PREVIEW_MODEL_READY_FILE, 'ready');
      await run("document.querySelector('.session-retry-models').click()");
      await until("document.getElementById('session-model')?.value==='preview-model'");
      assert.equal(await choices(), before, 'Retry must not reset session choices');
      assert.equal(await run("!!document.querySelector('#session-model-error')"), false);
      assert.equal(await run("document.getElementById('session-model').disabled"), false);
      assert.equal(await run("!!document.querySelector('#session-create-status')"), false);
      console.log(JSON.stringify({ ok: true, recoveredModel: 'preview-model', choicesPreserved: true }));
      clearTimeout(deadline); app.exit(0);
    } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
  });
});
require('./preview-ux.cjs');
