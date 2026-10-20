// Isolated checks for the compact workspace controls; no real daemon writes.
const {app}=require('electron');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), assert=require('node:assert/strict');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'prospero-workspace-actions-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const deadline=setTimeout(()=>app.exit(1),60000);
process.argv.push('--attention');
app.on('browser-window-created',(_,w)=>w.webContents.once('did-finish-load',async()=>{
 const wc=w.webContents, run=s=>wc.executeJavaScript(s);
 const wait=async source=>{for(let i=0;i<100;i++){if(await run(source))return;await delay(100);}throw new Error('Timed out: '+source);};
 const click=async selector=>{await run(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getBoundingClientRect().width>0&&!e.closest('[inert]'));if(!e)throw new Error('Missing control: '+${JSON.stringify(selector)});e.click();})()`);await delay(250);};
 try{
  await wait("document.querySelectorAll('.workspace-session-link').length>1");
  w.setSize(1280,860);w.show();w.focus();
  await click('.workspace-session-link');
  await run("document.querySelectorAll('.workspace-session-link')[1].click()");
  await wait("document.querySelectorAll('.workspace-tab').length===2");
  assert.equal(await run("!!document.querySelector('.workspace-split-controls')"),false);
  const buttons=await run("[...document.querySelector('.workspace-session-slot:not([inert]) .session-toolbar .pane-toolbar-actions').children].filter(e=>e.tagName==='BUTTON').map(e=>e.getAttribute('aria-label'))");
  assert.deepEqual(buttons,['停止当前轮次','切换工具栏','进入专注模式','会话操作']);
  assert(await run("[...document.querySelectorAll('.workspace-session-slot:not([inert]) .session-toolbar .pane-toolbar-actions > button')].every(e=>e.scrollWidth<=e.clientWidth+1)"), 'Toolbar labels must fit their buttons');
  await click('[aria-label="会话操作"]');
  await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.includes('分屏查看会话'))");
  assert(await run("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.includes('在外部终端打开'))"));
  await run("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('分屏查看会话')).click()");
  await wait("!!document.querySelector('.workspace-split-controls')");
  await click('[aria-label="关闭分屏"]');
  assert.equal(await run("!!document.querySelector('.workspace-split-controls')"),false);
  await click('[aria-label="切换工具栏"]');
  await wait("!!document.querySelector('.workspace-dock-aside, .workspace-dock-sheet')");
  assert(await run("['文件','搜索','Git'].every(label=>[...document.querySelectorAll('[data-slot=context-tool-tab]')].some(e=>e.getAttribute('aria-label')===label))"));
  await click('[aria-label="隐藏工具栏"]');
  await click('[aria-label="进入专注模式"]');
  await wait("!!document.querySelector('.sidebar-exit-focus')");
  await click('.sidebar-exit-focus');
  await wait("!!document.querySelector('.workspace-session-slot:not([inert]) .session-toolbar')");
  fs.writeFileSync(path.join(out,'workspace.png'),(await wc.capturePage()).toPNG());
  // The independent structured session has no linked orchestration goal.
  await run("(()=>{const p=[...document.querySelectorAll('.workspace-project-button')].find(e=>e.textContent.includes('Current project'));if(p.getAttribute('aria-expanded')!=='true')p.click();})()");
  await delay(200);
  await run("[...document.querySelectorAll('.workspace-session-link')].find(e=>e.textContent.includes('当前项目会话')).click()");
  await wait("!!document.querySelector('[data-chat-composer]')");
  assert(await run("document.querySelector('.chat-composer-options').hidden"));
  await click('.chat-composer-actions [aria-controls]');
  assert.equal(await run("document.querySelector('.chat-composer-options').hidden"),false);
  assert.equal(await run("[...document.querySelectorAll('.chat-composer-options button')].some(e=>e.textContent.trim()==='目标')"),false);
  assert(await run("[...document.querySelectorAll('.chat-composer-options button')].some(e=>e.textContent.includes('跨模型子 Agent'))"));
  fs.writeFileSync(path.join(out,'conversation.png'),(await wc.capturePage()).toPNG());
  console.log(JSON.stringify({ok:true,toolbarButtons:buttons,screenshots:out}));clearTimeout(deadline);app.exit(0);
 }catch(e){console.error(e);fs.writeFileSync(path.join(out,'failure.png'),(await wc.capturePage()).toPNG());console.error(out);clearTimeout(deadline);app.exit(1);}
}));
require('./preview-ux.cjs');
