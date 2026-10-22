// Synthetic UI only: no user sessions or model calls.
const { app } = require('electron');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
process.argv.push('--branch-preview');
const deadline = setTimeout(() => app.exit(1), 60000);
app.on('browser-window-created', (_, window) => window.webContents.once('did-finish-load', async () => {
  const run = source => window.webContents.executeJavaScript(source);
  const wait = async source => {
    for (let i = 0; i < 100; i++) {
      if (await run(source)) return;
      await delay(100);
    }
    throw new Error('Timed out: ' + source);
  };
  const menu = async title => {
    await run(`document.querySelector('[role=menu]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await delay(100);
    await run(`[...document.querySelectorAll('.workspace-session-link')].find(e=>e.textContent.includes(${JSON.stringify(title)})).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:160,clientY:260}))`);
    await wait("!!document.querySelector('[role=menu]')");
  };
  try {
    await wait("!!document.querySelector('.workspace-project-button')");
    await run("(()=>{const p=[...document.querySelectorAll('.workspace-project-button')].find(e=>e.textContent.includes('Current project'));if(p.getAttribute('aria-expanded')!=='true')p.click()})()");
    await wait("[...document.querySelectorAll('.workspace-session-link')].some(e=>e.textContent.includes('Terminal branch preview'))");
    await menu('Terminal branch preview');
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.includes('选择聊天并创建分支'))");
    assert(await run("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('选择聊天并创建分支')).getAttribute('aria-disabled')!=='true'"));
    assert(await run("document.querySelector('[role=menu]').textContent.includes('在新终端选择原生聊天')"));
    await menu('Busy branch preview');
    await wait("document.querySelector('[role=menu]')?.textContent.includes('请等待当前轮次结束')");
    assert(await run("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('创建聊天分支')).getAttribute('aria-disabled')==='true'"));
    console.log(JSON.stringify({ ok: true, checks: ['live terminal picker enabled', 'picker explanation visible', 'structured busy reason visible'] }));
    clearTimeout(deadline); app.exit(0);
  } catch (error) {
    console.error(error); clearTimeout(deadline); app.exit(1);
  }
}));
require('./preview-ux.cjs');
