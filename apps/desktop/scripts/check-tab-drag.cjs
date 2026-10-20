// Isolated regression: a stationary tab drag must stop measuring layout.
// Run after building: electron scripts/check-tab-drag.cjs
const { app } = require('electron');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Tab drag check timed out'); app.exit(1); }, 60_000);
process.argv.push('--attention');
app.on('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    const wc = window.webContents;
    const run = source => wc.executeJavaScript(source);
    try {
      for (let i = 0; i < 100; i++) {
        if (await run("document.querySelectorAll('.workspace-session-link').length >= 2")) break;
        await delay(100);
      }
      window.setSize(1280, 860);
      window.show(); window.focus();
      await run("document.querySelectorAll('.workspace-session-link')[0].click()");
      await delay(300);
      await run("document.querySelectorAll('.workspace-session-link')[1].click()");
      await delay(800);
      const point = await run(`(() => {
        const tabs = document.querySelectorAll('.topbar-workspace-tabs [data-tab-id]');
        if (tabs.length < 2) throw new Error('Expected two session tabs');
        const rect = tabs[0].querySelector('[role=tab]').getBoundingClientRect();
        window.tabMeasurements = 0;
        const original = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function() {
          if (this.matches('.workspace-tab')) window.tabMeasurements++;
          return original.call(this);
        };
        return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};
      })()`);
      wc.sendInputEvent({ type: 'mouseMove', ...point });
      wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseMove', x: point.x + 30, y: point.y, modifiers: ['leftButtonDown'] });
      await delay(150);
      assert(await run("!!document.querySelector('.topbar-workspace-tabs [data-sorting=true]')"), 'Drag should be active');
      await run('window.tabMeasurements = 0');
      await delay(350);
      const idleMeasurements = await run('window.tabMeasurements');
      assert.equal(idleMeasurements, 0, 'A stationary drag should not repeatedly read tab layout');
      wc.sendInputEvent({ type: 'mouseMove', x: point.x + 50, y: point.y, modifiers: ['leftButtonDown'] });
      await delay(150);
      assert(await run('window.tabMeasurements > 0'), 'Moving again should resume painting');
      wc.sendInputEvent({ type: 'mouseUp', x: point.x + 50, y: point.y, button: 'left', clickCount: 1 });
      await delay(250);
      assert.equal(await run("!!document.querySelector('.topbar-workspace-tabs [data-sorting=true]')"), false);
      console.log(JSON.stringify({ ok: true, idleMeasurements }));
      clearTimeout(deadline); app.exit(0);
    } catch (error) {
      console.error(error); clearTimeout(deadline); app.exit(1);
    }
  });
});
require('./preview-ux.cjs');
