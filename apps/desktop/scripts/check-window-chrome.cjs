// Run with Electron after `npm run build`. Uses an isolated home and no daemon.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-chrome-check-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, "desktop.json"), JSON.stringify({ settings: { startDaemonOnLaunch: false, theme: "dark" } }));
process.env.PROSPERO_HOME = home;
app.setPath("userData", path.join(root, "userData"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error("Window chrome check timed out", root); app.exit(1); }, 40_000);

app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    const wc = window.webContents;
    const run = (js) => wc.executeJavaScript(js);
    const measure = () => run(`(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        return r ? {x:r.x, y:r.y, width:r.width, height:r.height} : null;
      };
      return { sidebar: rect('[data-slot="sidebar-container"]'), toolbar: rect('.desktop-topbar'),
        main: rect('.prospero-main'), trigger: rect('.topbar-sidebar-trigger'),
        expanded: document.querySelector('[data-slot="sidebar"][data-state]')?.dataset.state === 'expanded',
        navHeights: [...document.querySelectorAll('.sidebar-nav-fixed [data-sidebar="menu-button"]')].map(e=>e.getBoundingClientRect().height),
        resizing: document.documentElement.dataset.sidebarResizing,
        savedWidth: Number(localStorage.getItem('prospero.sidebarWidth')), saves: window.widthSaves || 0 };
    })()`);
    const rail = () => run(`(() => { const r=document.querySelector('[data-sidebar="rail"]').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:150}; })()`);
    const toggle = async () => { await run(`document.querySelector('.topbar-sidebar-trigger').click()`); await delay(250); };
    const drag = async (delta, cancel = false) => {
      const start = await rail();
      wc.sendInputEvent({ type: "mouseMove", ...start });
      wc.sendInputEvent({ type: "mouseDown", ...start, button: "left", clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        wc.sendInputEvent({ type: "mouseMove", x: start.x + Math.round(delta * i / 10), y: start.y, modifiers: ["leftButtonDown"] });
        await delay(18);
      }
      if (cancel) { wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); }
      wc.sendInputEvent({ type: "mouseUp", x: start.x + delta, y: start.y, button: "left", clickCount: 1 });
      await delay(250);
    };
    const screenshot = async (name) => {
      fs.writeFileSync(path.join(root, name + ".png"), (await wc.capturePage()).toPNG());
    };
    try {
      window.setMinimumSize(700, 600);
      window.setSize(1280, 860);
      window.show(); window.focus();
      await delay(1000);
      if (!(await measure()).expanded) await toggle();
      await run(`window.widthSaves=0;const originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='prospero.sidebarWidth')window.widthSaves++;return originalSetItem.call(this,key,value)};void 0;`);
      const initial = await measure();
      assert.equal(initial.toolbar.height, 44);
      assert.equal(initial.sidebar.y, 44);
      assert.equal(initial.main.y, 44);
      assert(initial.navHeights.every(h => h === 28));
      if (process.platform === "darwin") {
        assert.deepEqual(window.getWindowButtonPosition(), { x: 14, y: 16 });
        assert(initial.trigger.x >= 82);
      }
      await drag(100);
      const resized = await measure();
      assert.equal(resized.sidebar.width, initial.sidebar.width + 100);
      assert(resized.expanded, "A drag must not trigger the rail's click-to-collapse");
      assert.equal(resized.savedWidth, resized.sidebar.width);
      assert.equal(resized.saves, 1, "Pointer movement must persist only once after release");
      await screenshot("expanded");
      await drag(50, true);
      const cancelled = await measure();
      assert.equal(cancelled.sidebar.width, resized.sidebar.width);
      assert.equal(cancelled.resizing, undefined);
      assert.equal(cancelled.saves, 1);
      await drag(130 - resized.sidebar.width, true);
      assert.equal((await measure()).sidebar.width, resized.sidebar.width, "Cancelling a collapse restores the previous width");
      await drag(130 - resized.sidebar.width);
      const dragCollapsed = await measure();
      assert.equal(dragCollapsed.sidebar.width, 52, "Dragging left past the threshold collapses the sidebar");
      assert.equal(dragCollapsed.savedWidth, resized.sidebar.width, "Collapsing preserves the expanded width");
      assert.equal(dragCollapsed.resizing, undefined);
      await toggle();
      assert.equal((await measure()).sidebar.width, resized.sidebar.width);
      await toggle();
      const collapsed = await measure();
      assert.equal(collapsed.sidebar.width, 52);
      assert.equal(collapsed.sidebar.y, 44);
      assert(collapsed.navHeights.every(h => h === 28));
      await screenshot("collapsed");
      await toggle();
      assert.equal((await measure()).sidebar.width, resized.sidebar.width);
      await toggle();
      await drag(200, true);
      assert.equal((await measure()).sidebar.width, 52, "Cancelling an expansion restores the collapsed state");
      await drag(200);
      assert.equal((await measure()).sidebar.width, 252, "A collapsed sidebar can be dragged open");
      await drag(600);
      assert.equal((await measure()).sidebar.width, 420);
      await run(`document.querySelector('[data-sidebar="rail"]').focus()`);
      wc.sendInputEvent({ type: "keyDown", keyCode: "Home" }); wc.sendInputEvent({ type: "keyUp", keyCode: "Home" });
      await delay(250);
      assert.equal((await measure()).sidebar.width, 200);
      wc.sendInputEvent({ type: "keyDown", keyCode: "Right" }); wc.sendInputEvent({ type: "keyUp", keyCode: "Right" });
      await delay(250);
      assert.equal((await measure()).sidebar.width, 210);
      await drag(130);
      await new Promise(resolve => { wc.once("did-finish-load", resolve); wc.reload(); });
      await delay(600);
      if (!(await measure()).expanded) await toggle();
      assert.equal((await measure()).sidebar.width, 340, "Width must survive a renderer reload");
      window.setSize(800, 780);
      await delay(300);
      if (!(await measure()).expanded) await toggle();
      const narrow = await measure();
      assert.equal(narrow.toolbar.height, 44);
      assert.equal(narrow.sidebar.y, narrow.toolbar.height);
      assert.equal(narrow.sidebar.width, 320, "Keep at least 480px for content");
      assert.equal(narrow.main.width, 480);
      await toggle();
      await screenshot("narrow");
      await run(`Array.from(document.querySelectorAll('.sidebar-nav-fixed button')).find(e=>['工作台','Workspaces'].includes(e.textContent.trim()))?.click()`);
      await delay(300);
      if (!(await run(`Boolean(document.querySelector('.desktop-topbar button[aria-label="退出专注"], .desktop-topbar button[aria-label="Exit focus"]'))`))) {
        wc.sendInputEvent({type:"keyDown",keyCode:"F",modifiers:process.platform === "darwin" ? ["meta","shift"] : ["control","alt"]});
        wc.sendInputEvent({type:"keyUp",keyCode:"F"});
        await delay(250);
      }
      assert(await run(`Boolean(document.querySelector('.desktop-topbar button[aria-label="退出专注"], .desktop-topbar button[aria-label="Exit focus"]'))`), "Focus mode keeps a reachable exit in the native toolbar");
      assert.equal((await measure()).toolbar.height, 44);
      window.setSize(720, 780);
      await delay(250);
      await toggle();
      assert(await run(`Boolean(document.querySelector('[data-slot="sidebar"][data-mobile="true"]'))`), "The toolbar also opens the drawer in a narrow window");
      console.log(JSON.stringify({ ok: true, root, initial, resized, collapsed, narrow }));
      clearTimeout(deadline); app.quit();
    } catch (error) {
      console.error(error);
      console.error("UI state", await measure());
      await screenshot("failure");
      clearTimeout(deadline); app.exit(1);
    }
  });
});

import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href);
