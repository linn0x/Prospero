// Synthetic 130-model catalog: every row must be reachable without changing config.
const { app } = require('electron');
const assert = require('node:assert/strict');
process.argv.push('--catalog-preview');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(1), 60_000);
app.on('browser-window-created', (_, window) => window.webContents.once('did-finish-load', async () => {
  const run = source => window.webContents.executeJavaScript(source);
  const wait = async source => { for (let i=0;i<100;i++) { if(await run(source))return;await delay(100); } throw new Error('Timed out: '+source); };
  try {
    await wait("!!document.querySelector('.sidebar-resource-nav')");
    await run("[...document.querySelectorAll('.sidebar-resource-nav button')].find(e=>e.textContent.includes('Agent 与账号')).click()");
    await wait("!!document.querySelector('.model-source-catalog')");
    await run("document.querySelector('.model-source-catalog summary').click();[...document.querySelectorAll('.model-source-catalog-controls button')].find(e=>e.textContent.includes('读取目录')).click()");
    await wait("document.querySelectorAll('.model-source-catalog-list label').length===100");
    await run("[...document.querySelectorAll('.model-source-catalog button')].find(e=>e.textContent.includes('显示更多模型')).click()");
    await wait("document.querySelectorAll('.model-source-catalog-list label').length===130");
    assert(await run("document.querySelector('.model-source-catalog-list').textContent.includes('catalog-model-129')"));
    console.log(JSON.stringify({ok:true,initialRows:100,expandedRows:130}));clearTimeout(deadline);app.exit(0);
  } catch(error) { console.error(error);clearTimeout(deadline);app.exit(1); }
}));
require('./preview-ux.cjs');
