const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const isMac = process.platform === "darwin";
const collapsedWidth = isMac ? 88 : 52;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-chrome-check-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, "desktop.json"), JSON.stringify({ settings: { startDaemonOnLaunch: false, theme: "dark" } }));
process.env.PROSPERO_HOME = home;
app.setPath("userData", path.join(root, "userData"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error("Window chrome check timed out", root); app.exit(1); }, 60_000);

app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    const wc = window.webContents;
    const run = (js) => wc.executeJavaScript(js);
    const measure = () => run(`(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        return r ? {x:r.x, y:r.y, width:r.width, height:r.height} : null;
      };
      return { sidebar: rect('[data-slot="sidebar-container"]'), toolbar: rect('.windows-titlebar'),
        main: rect('.prospero-main'), viewport: rect('.main-viewport'), header: rect('.sidebar-shell-header'),
        trigger: rect('.sidebar-header-toggle'), drawerTrigger: rect('.sidebar-drawer-trigger'),
        nativeDrag: rect('.windows-titlebar'),
        headerDrag: document.querySelector('.sidebar-shell-header') && getComputedStyle(document.querySelector('.sidebar-shell-header')).webkitAppRegion,
        headerButtons: [...document.querySelectorAll('.sidebar-shell-header button')].map(element => ({ label: element.getAttribute('aria-label'), region: getComputedStyle(element).webkitAppRegion, x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y })),
        expanded: document.querySelector('[data-slot="sidebar"][data-state]')?.dataset.state === 'expanded',
        navHeights: [...document.querySelectorAll('.sidebar-nav-fixed [data-sidebar="menu-button"]')].map(e=>e.getBoundingClientRect().height),
        resizing: document.documentElement.dataset.sidebarResizing,
        savedWidth: Number(localStorage.getItem('prospero.sidebarWidth')), saves: window.widthSaves || 0 };
    })()`);
    const rail = () => run(`(() => { const r=document.querySelector('[data-sidebar="rail"]').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:150}; })()`);
    const click = async (selector, clickCount = 1) => {
      const point = await run(`(() => { const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})]; const element=candidates.find(element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(element).visibility!=='hidden'}); if(!element)throw new Error('No visible control: '+${JSON.stringify(selector)}); const r=element.getBoundingClientRect(); const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2); if(!element.contains(document.elementFromPoint(x,y)))throw new Error('Control is covered: '+${JSON.stringify(selector)}); return {x,y}; })()`);
      wc.sendInputEvent({ type: "mouseMove", ...point });
      wc.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount });
      wc.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount });
      await delay(250);
    };
    const toggle = async () => { await click(isMac ? '.sidebar-header-toggle, .sidebar-drawer-trigger' : '.windows-titlebar > button:first-child'); };
    const key = async (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await delay(250);
    };
    const assertHeader = async () => {
      const state = await measure();
      if (isMac) assert.equal(state.toolbar, null, "macOS uses native traffic lights and menu bar");
      else { assert.equal(state.toolbar.y, 0); assert(state.toolbar.height >= 40); }
      if (isMac) {
        assert.equal(state.headerDrag, "drag");
        assert(state.headerButtons.length >= 2);
      } else if (!await run(`Boolean(document.querySelector('.sidebar-exit-focus'))`)) {
        assert.equal(state.header, null, "Windows navigation starts without a duplicate titlebar header");
      }
      assert(state.headerButtons.every(button => button.region === "no-drag"), "Sidebar actions must remain clickable inside native drag chrome");
      if (isMac) assert(state.headerButtons.every(button => button.x >= 88 || button.y >= 44), "Sidebar controls must avoid native traffic lights");
      return state;
    };
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
      const initial = await assertHeader();
      assert.equal(initial.sidebar.y, isMac ? 0 : initial.toolbar.height);
      assert.equal(initial.main.y, isMac ? 0 : initial.toolbar.height);
      assert.equal(initial.viewport.y, isMac ? 0 : initial.toolbar.height);
      if (isMac) assert(initial.header.width <= initial.sidebar.width);
      assert(initial.navHeights.every(h => h === 28));
      if (isMac) {
        assert.deepEqual(window.getWindowButtonPosition(), { x: 14, y: 16 });
        assert(initial.trigger.x >= 88);
      }
      await click(isMac ? '.sidebar-new-session' : '[data-slot="sidebar-group-action"][aria-label="新增工作区"]');
      assert(await run(`Boolean(document.querySelector('[role="dialog"]'))`), "The sidebar new-session button must open its dialog");
      await key("Escape");
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
      assert.equal(dragCollapsed.sidebar.width, collapsedWidth, "Dragging left past the threshold collapses the sidebar");
      assert.equal(dragCollapsed.savedWidth, resized.sidebar.width, "Collapsing preserves the expanded width");
      assert.equal(dragCollapsed.resizing, undefined);
      await toggle();
      assert.equal((await measure()).sidebar.width, resized.sidebar.width);
      await toggle();
      const collapsed = await assertHeader();
      assert.equal(collapsed.sidebar.width, collapsedWidth);
      assert.equal(collapsed.sidebar.y, isMac ? 0 : collapsed.toolbar.height);
      assert(collapsed.navHeights.every(h => h === 28));
      await screenshot("collapsed");
      await toggle();
      assert.equal((await measure()).sidebar.width, resized.sidebar.width);
      await toggle();
      await drag(200, true);
      assert.equal((await measure()).sidebar.width, collapsedWidth, "Cancelling an expansion restores the collapsed state");
      await drag(200);
      assert.equal((await measure()).sidebar.width, collapsedWidth + 200, "A collapsed sidebar can be dragged open");
      await drag(600);
      assert.equal((await measure()).sidebar.width, 420);
      await click('[data-sidebar="rail"]', 2);
      assert.equal((await measure()).sidebar.width, 240, "Double-click restores the default expanded width");
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
      const narrow = await assertHeader();
      assert.equal(narrow.sidebar.y, isMac ? 0 : narrow.toolbar.height);
      assert.equal(narrow.sidebar.width, 320, "Keep at least 480px for content");
      assert.equal(narrow.main.width, 480);
      await screenshot("narrow");
      await toggle();
      await run(`Array.from(document.querySelectorAll('.sidebar-nav-fixed button')).find(e=>['工作台','Workspaces'].includes(e.textContent.trim()))?.click()`);
      await delay(300);
      const focusShortcut = isMac ? ["meta", "shift"] : ["control", "alt"];
      await key("F", focusShortcut);
      assert(await run(`Boolean(document.querySelector('.sidebar-exit-focus'))`), "Focus mode keeps its exit in the sidebar");
      await assertHeader();
      await screenshot("focus-collapsed");
      await click('.sidebar-exit-focus');
      assert.equal(await run(`Boolean(document.querySelector('.sidebar-exit-focus'))`), false, "Clicking the focus exit must work inside sidebar chrome");
      await key("F", focusShortcut);
      window.setSize(720, 780);
      await delay(250);
      await click(isMac ? '.sidebar-drawer-trigger' : '.windows-titlebar > button:first-child');
      assert(await run(`Boolean(document.querySelector('[data-slot="sidebar"][data-mobile="true"]'))`), "A floating trigger opens the drawer in a narrow window");
      if (isMac) assert.equal((await measure()).toolbar, null);
      await assertHeader();
      await screenshot("narrow-drawer");
      await click('.sidebar-exit-focus');
      assert.equal(await run(`Boolean(document.querySelector('.sidebar-exit-focus'))`), false);
      await click(isMac ? '.sidebar-header-toggle' : '.prospero-sidebar[data-mobile="true"] > [data-slot="sheet-close"]');
      assert.equal(await run(`Boolean(document.querySelector('[data-slot="sidebar"][data-mobile="true"]'))`), false, "The drawer can be collapsed from its own header");
      await screenshot("narrow-floating-trigger");
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
