// Real desktop renderer + IPC with a synthetic event-mode terminal service.
// All state lives in a temporary profile; no installed daemon is contacted.
const { app, clipboard } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:http");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-terminal-ui-"));
const home = path.join(fixture, "home"), project = path.join(fixture, "project");
const output = path.resolve(__dirname, "../../../output/desktop-terminal");
for(const directory of [home,project,output]) fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(home,"desktop.json"),JSON.stringify({projects:[project],settings:{startDaemonOnLaunch:false,minimizeToTray:false,theme:"dark",daemonBackend:"legacy"}}));
const sessions=Array.from({length:6},(_,index)=>({id:`terminal-ui-${index}`,agent:index===5?"codex":"custom",kind:"pty",terminalMode:"events",title:`Terminal check ${index}`,cwd:project,status:"running",createdAt:index+1}));
const historic={id:"historical-subdirectory",agent:"codex",kind:"pty",title:"Historical",cwd:path.join(project,"nested"),status:"done",createdAt:0};
fs.mkdirSync(historic.cwd);
const encode=text=>Buffer.from(text).toString("base64");
const events=new Map(sessions.map(s=>[s.id,[{type:"output",dataB64:encode(Array.from({length:250},(_,n)=>`${s.id} 中文 line ${n}\r\n`).join("")+"\x1b[c\x1b[6nREADY> ")}]]));
const inputs=[],resizes=[],launches=[];
const server=createServer((request,response)=>{
  let raw="";request.on("data",chunk=>raw+=chunk);request.on("end",()=>{
    const url=new URL(request.url,"http://localhost");
    response.setHeader("content-type","application/json");
    if(url.pathname.endsWith("/session/create")){
      const input=JSON.parse(raw);launches.push(input);
      const session={...input,id:`created-${launches.length}`,terminalMode:"events",title:"Created fixture",status:"running",createdAt:100};
      sessions.push(session);events.set(session.id,[{type:"output",dataB64:encode("CREATED> ")}]);
      response.end(JSON.stringify(session));return;
    }
    const match=url.pathname.match(/\/session\/([^/]+)\/(view|interact)$/);
    if(match){
      const id=decodeURIComponent(match[1]),stream=events.get(id);
      if(!stream){response.statusCode=404;response.end();return;}
      if(match[2]==="interact"){
        const message=JSON.parse(raw||"{}");
        if(message.type==="term.resize") {resizes.push({id,...message});stream.push({type:"resize",size:{cols:message.cols,rows:message.rows}});}
        if(message.type==="term.input") {const value=Buffer.from(message.dataB64,"base64").toString();inputs.push({id,value});stream.push({type:"output",dataB64:message.dataB64});}
        response.end(JSON.stringify({ok:true}));return;
      }
      if(!url.searchParams.has("outputAfterSeq")){response.end(JSON.stringify({kind:"pty",mode:"snapshot",seq:0,cols:120,rows:40,dataB64:"",caughtUp:false}));return;}
      const cursor=Number(url.searchParams.get("outputAfterSeq"));
      if(cursor<stream.length){const end=Math.min(cursor+64,stream.length);response.end(JSON.stringify({kind:"pty",mode:"events",seq:end,baseSeq:cursor,cols:120,rows:40,events:stream.slice(cursor,end),caughtUp:end===stream.length}));}
      else setTimeout(()=>{if(!response.destroyed){response.statusCode=204;response.end();}},40);
    }else if(url.pathname.endsWith("/sessions"))response.end(JSON.stringify({items:[...sessions,historic],hasMore:false}));
    else response.end(JSON.stringify({ok:true,items:[],available:false,models:[],modes:[]}));
  });
});
process.env.PROSPERO_HOME=home;process.env.PROSPERO_BACKEND="legacy";
process.env.PROSPERO_RUNTIME_SWITCH_FILE=path.join(fixture,"runtime-switch.json");
app.setPath("userData",path.join(fixture,"userData"));
process.argv.push("--background");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>{console.error("Terminal UI check timed out");app.exit(1);},90000);
app.on("browser-window-created",(_event,window)=>{
  window.webContents.once("did-finish-load",async()=>{
    const wc=window.webContents,run=source=>wc.executeJavaScript(source,true),errors=[];
    wc.setBackgroundThrottling(false);
    wc.on("console-message",details=>{if(details.level==="error"&&/Uncaught|Maximum update/.test(details.message))errors.push(details.message);});
    const wait=async(expression)=>{for(let n=0;n<100;n++){if(await run(expression))return;await delay(50);}throw new Error(`Timed out: ${expression}`);};
    const screenshot=async(name)=>fs.writeFileSync(path.join(output,`${name}.png`),(await wc.capturePage()).toPNG());
    try{
      window.setMinimumSize(600,400);window.setSize(1200,850);window.setOpacity(0);window.showInactive();
      await wait("Boolean(document.querySelector('.prospero-shell'))");
      await run("localStorage.setItem('prospero.activeView','workspaces');localStorage.setItem('prospero.activeSession','terminal-ui-0');localStorage.setItem('prospero.openSessions',JSON.stringify(Array.from({length:6},(_,i)=>'terminal-ui-'+i)))");
      await new Promise(resolve=>{wc.once("did-finish-load",resolve);wc.reload();});
      await wait("Boolean(document.querySelector('.xterm-screen'))");
      await run("document.querySelectorAll('.xterm-screen canvas').forEach(canvas=>canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext())");
      await wait("document.querySelector('.xterm-rows')?.textContent.includes('READY>')");
      assert.equal(inputs.length,0,"Replay must not send terminal replies as input");
      // Queries emitted after the terminal is fully connected must also have a single owner.
      events.get("terminal-ui-0").push({type:"output",dataB64:encode("\x1b[c\x1b[6n\x1b]10;?\x07\x1b]11;?\x07LIVE> ")});
      await wait("document.querySelector('.xterm-rows')?.textContent.includes('LIVE>')");
      assert.equal(inputs.length,0,"Live daemon-owned queries must not generate duplicate replies");
      await run("document.querySelector('.xterm-helper-textarea').focus()");
      for(const keyCode of ["a","b","c"]){wc.sendInputEvent({type:"keyDown",keyCode});wc.sendInputEvent({type:"char",keyCode});wc.sendInputEvent({type:"keyUp",keyCode});}
      for(let n=0;n<80&&!inputs.map(i=>i.value).join("").includes("abc");n++)await delay(25);
      assert.equal(inputs.map(i=>i.value).join(""),"abc","Keyboard input is sent exactly once");
      const before=inputs.length;
      await run("(()=>{const data=new DataTransfer();data.setData('text/plain','first\\n第二行');document.querySelector('.terminal-host').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()");
      for(let n=0;n<80&&inputs.length===before;n++)await delay(25);
      assert.equal(inputs.slice(before).map(i=>i.value).join(""),"first\r第二行");
      await run("(()=>{const data=new DataTransfer();data.items.add(new File(['image'],'image.png',{type:'image/png'}));document.querySelector('.terminal-host').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()");
      await wait("Boolean(document.querySelector('.terminal-toast'))");
      for(let n=0;n<40;n++)events.get("terminal-ui-0").push({type:"output",dataB64:encode(`resize-${n}\r\n`.repeat(20))});
      window.setSize(900,680);await delay(100);window.setSize(1080,760);
      await delay(700);
      const latest=resizes.filter(r=>r.id==="terminal-ui-0").at(-1);
      assert(latest&&latest.cols>=20&&latest.rows>=5,"PTY receives final geometry");
      // A real search scrolls the buffer. Evict this xterm by visiting five
      // others, then ensure a fresh instance restores its reading intent.
      await run("document.querySelector('.xterm-helper-textarea').focus()");
      wc.sendInputEvent({type:"keyDown",keyCode:"f",modifiers:[process.platform==="darwin"?"meta":"control",...(process.platform==="darwin"?[]:["shift"])]});
      wc.sendInputEvent({type:"keyUp",keyCode:"f"});
      await wait("Boolean(document.querySelector('.terminal-find input'))");
      await run("(()=>{const input=document.querySelector('.terminal-find input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'line 20');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await delay(50);
      await run("document.querySelector('.terminal-find button').click()");
      await delay(150);
      const firstRow=await run("document.querySelector('#workspace-session-panel .xterm-rows')?.firstElementChild?.textContent");
      await run("document.querySelector('[aria-label=\"启用应用鼠标交互\"]').click()");
      for(let index=1;index<6;index++){
        await run(`document.getElementById('workspace-tab-terminal-ui-${index}').click()`);
        await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-screen'))");
        await run("document.querySelectorAll('#workspace-session-panel canvas').forEach(canvas=>canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext())");
        await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-rows'))");
        assert(await run("Boolean(document.querySelector('#workspace-session-panel [aria-label=\"启用应用鼠标交互\"]'))"),"Mouse preference does not change other sessions");
      }
      await run("document.getElementById('workspace-tab-terminal-ui-0').click()");
      await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-screen'))");
      await run("document.querySelectorAll('#workspace-session-panel canvas').forEach(canvas=>canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext())");
      await wait("document.querySelector('#workspace-session-panel .terminal-find input')?.value==='line 20'");
      await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-rows')?.firstElementChild)");
      assert.equal(await run("document.querySelector('#workspace-session-panel .xterm-rows')?.firstElementChild?.textContent"),firstRow,"Evicted terminal restores reading viewport");
      assert(await run("Boolean(document.querySelector('#workspace-session-panel [aria-label=\"恢复本地选字\"]'))"),"Mouse preference survives eviction for its own session");
      await run("document.querySelector('#workspace-session-panel [aria-label=\"关闭查找\"]').click()");
      for(let index=1;index<6;index++){
        await run(`document.getElementById('workspace-tab-terminal-ui-${index}').click()`);
        await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-screen'))");
      }
      await run("document.getElementById('workspace-tab-terminal-ui-0').click()");
      await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-screen'))");
      assert(await run("!document.querySelector('#workspace-session-panel .terminal-find')"),"Closed search stays closed after eviction");
      await run("window.__primaryTerminal=document.querySelector('#workspace-session-panel .xterm-screen');document.querySelector('.workspace-split-controls button').click()");
      await wait("Boolean(document.querySelector('#workspace-secondary-panel .xterm-screen'))");
      await run("document.querySelectorAll('#workspace-secondary-panel canvas').forEach(canvas=>canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext())");
      await wait("document.querySelector('#workspace-secondary-panel .xterm-rows')?.textContent.includes('terminal-ui-1')");
      const splitInput=inputs.length;
      await run("document.querySelector('#workspace-secondary-panel .xterm-helper-textarea').focus()");
      await delay(50);
      for(const keyCode of ["r","h","s"]){wc.sendInputEvent({type:"keyDown",keyCode});wc.sendInputEvent({type:"char",keyCode});wc.sendInputEvent({type:"keyUp",keyCode});}
      for(let n=0;n<100&&!inputs.slice(splitInput).map(item=>item.value).join("").includes("rhs");n++)await delay(20);
      assert.equal(inputs.slice(splitInput).map(item=>item.value).join(""),"rhs");
      assert(inputs.slice(splitInput).every(item=>item.id==="terminal-ui-1"),"Split input reaches only the focused session");
      window.setSize(1450,850);await delay(200);
      assert(await run("document.activeElement?.closest('#workspace-secondary-panel')!==null"),"Resize preserves split keyboard focus");
      await screenshot("terminal-split");
      await run("document.querySelector('#workspace-secondary-panel').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
      await wait("document.querySelector('#workspace-secondary-panel').closest('.workspace-session-slot').dataset.focused==='true'");
      await run("document.querySelector('[data-tab-id=terminal-ui-1] [data-testid=workspace-tab-close]').click()");
      await wait("!document.querySelector('#workspace-secondary-panel') && document.querySelector('#workspace-session-panel').closest('.workspace-session-slot').dataset.focused==='true'");
      await run("document.querySelector('.workspace-session-link[title=\"Terminal check 1\"]').click()");
      await wait("Boolean(document.getElementById('workspace-tab-terminal-ui-1'))");
      await run("document.getElementById('workspace-tab-terminal-ui-0').click()");
      await wait("document.getElementById('workspace-tab-terminal-ui-0').getAttribute('aria-selected')==='true'");
      await run("(()=>{const button=document.querySelector('.workspace-split-controls button');if(button.getAttribute('aria-pressed')!=='true')button.click();})()");
      await wait("Boolean(document.querySelector('#workspace-secondary-panel'))");
      await run("document.querySelector('#workspace-secondary-panel').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
      await wait("document.querySelector('#workspace-secondary-panel').closest('.workspace-session-slot').dataset.focused==='true'");
      await run("(()=>{const select=document.querySelector('[aria-label=\"分屏会话\"]');select.value='terminal-ui-3';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await wait("document.querySelector('#workspace-secondary-panel .session-toolbar-identity')?.textContent.includes('Terminal check 3') && document.querySelector('#workspace-secondary-panel').closest('.workspace-session-slot').dataset.focused==='true'");
      await run("document.querySelector('[aria-label=\"关闭分屏\"]').click()");
      await wait("!document.querySelector('#workspace-secondary-panel')");
      assert(await run("window.__primaryTerminal===document.querySelector('#workspace-session-panel .xterm-screen')"),"Closing a split retains the original terminal");
      assert(await run("document.querySelectorAll('.workspace-tab .status-mark').length===6"),"Every tab exposes session status");
      if(process.platform==="darwin"){
        await run("document.querySelector('#workspace-session-panel .xterm-helper-textarea').focus()");
        wc.sendInputEvent({type:"keyDown",keyCode:"f",modifiers:["meta","shift"]});wc.sendInputEvent({type:"keyUp",keyCode:"f"});
        await wait("Boolean(document.querySelector('#workspace-session-panel').closest('.workspace-session-layout').querySelector('[data-slot=project-search]'))");
        assert(await run("!document.querySelector('#workspace-session-panel').closest('.workspace-session-layout').classList.contains('is-focus')"),"Project search does not toggle focus mode");
      }
      await run("document.querySelector('[data-tab-id=terminal-ui-1] [data-testid=workspace-tab-close]').click()");
      assert(await run("!document.getElementById('workspace-tab-terminal-ui-1')"));
      await run("document.querySelector('.workspace-session-link[title=\"Terminal check 1\"]').click()");
      await wait("document.getElementById('workspace-tab-terminal-ui-1')?.getAttribute('aria-selected')==='true'");
      const openDockTerminal=async id=>{
        await run(`document.getElementById('workspace-tab-${id}').click()`);
        await wait(`document.getElementById('workspace-tab-${id}').getAttribute('aria-selected')==='true'`);
        await run("(()=>{const button=document.querySelector('#workspace-session-panel [aria-label=\"切换工具栏\"]');if(button.getAttribute('aria-pressed')!=='true')button.click();})()");
        await wait("Boolean(document.querySelector('.workspace-session-slot[data-focused] [aria-label=\"打开工具标签\"]'))");
        await run("document.querySelector('.workspace-session-slot[data-focused] [aria-label=\"打开工具标签\"]').click()");
        await wait("[...document.querySelectorAll('[role=menuitem]')].some(item=>item.textContent==='终端')");
        await run("[...document.querySelectorAll('[role=menuitem]')].find(item=>item.textContent==='终端').click()");
        await wait("Boolean(document.querySelector('.workspace-session-slot[data-focused] .dock-terminal .xterm'))");
      };
      await openDockTerminal('terminal-ui-0');
      await openDockTerminal('terminal-ui-1');
      await run("document.getElementById('workspace-tab-terminal-ui-0').click()");
      await wait("Boolean(document.querySelector('.workspace-session-slot[data-focused] .dock-terminal .terminal-mouse-toggle'))");
      await run("document.querySelector('.workspace-session-slot[data-focused] .dock-terminal .terminal-mouse-toggle').click()");
      await run("document.getElementById('workspace-tab-terminal-ui-1').click()");
      await wait("document.querySelector('.workspace-session-slot[data-focused] .dock-terminal .terminal-mouse-toggle')?.getAttribute('aria-pressed')==='true'");
      assert.equal(launches.filter(item=>item.agent==='shell').length,1,"Both docks reuse the same shell");
      assert(await run("document.querySelector('#workspace-session-panel .session-toolbar .terminal-mouse-toggle').getAttribute('aria-pressed')==='false'"),"Shell mouse preference does not change its parent agent");
      const originalReadImage=clipboard.readImage;
      try{
        const fixtureImage=await wc.capturePage();clipboard.readImage=()=>fixtureImage;
        const saved=await run("window.prospero.saveTerminalClipboardImage('terminal-ui-5')");
        assert(saved.path.endsWith('.png')&&saved.path.startsWith(fixture));
        assert(fs.readFileSync(saved.path).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
      }finally{clipboard.readImage=originalReadImage;}
      await run("document.querySelector('.sidebar-new-session').click()");
      await wait("Boolean(document.getElementById('session-agent'))");
      await run("(()=>{const select=document.getElementById('session-agent');select.value='opencode';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await wait("document.getElementById('session-kind')?.value==='pty' && document.getElementById('session-account')?.value===''");
      await run("[...document.querySelectorAll('[role=dialog] button')].find(button=>button.textContent==='创建会话').click()");
      for(let n=0;n<100&&!launches.some(item=>item.agent==='opencode');n++)await delay(20);
      const openCodeLaunch=launches.find(item=>item.agent==='opencode');
      assert.equal(openCodeLaunch?.kind,"pty");assert.equal(openCodeLaunch?.accountId,undefined);
      await run(`window.prospero.createSession(${JSON.stringify({cwd:historic.cwd,sourceSessionId:historic.id,agent:"codex",kind:"pty",approvalPolicy:"strict",model:"fixture-model",effort:"high"})})`);
      const copiedLaunch=launches.find(item=>item.cwd===historic.cwd);
      assert.equal(copiedLaunch?.approvalPolicy,"strict");assert.equal(copiedLaunch?.model,"fixture-model");
      assert(await run(`window.prospero.createSession(${JSON.stringify({cwd:fixture,sourceSessionId:historic.id,agent:"codex",kind:"pty",approvalPolicy:"strict"})}).then(()=>false,()=>true)`),"Copy cannot replace the original directory with an unrelated path");
      await screenshot("terminal-parity");
      assert.deepEqual(errors,[]);
      const result={ok:true,checks:["real renderer + IPC event stream","GPU context-loss DOM fallback","no replay/live duplicate query reply","keyboard exactly once","multiline Unicode paste","image paste feedback","resize during output","reading/search restoration after six-session eviction","mouse preference per session","closed search survives eviction","split input and focus isolation","closed or replaced peer restores focus","shared dock shell mouse preference","split preserves terminal instances","tab session status","project search shortcut","sidebar reopens closed tab","clipboard image IPC saves PNG","native OpenCode TUI creation","historical cwd copy with source validation"],latestResize:latest,output};
      fs.writeFileSync(path.join(output,"ui-result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));clearTimeout(deadline);app.exit(0);
    }catch(error){console.error(error);console.error(errors);console.error(await run("JSON.stringify({rows:document.querySelectorAll('.xterm-rows').length,focused:[...document.querySelectorAll('.workspace-session-slot')].map(el=>({position:el.dataset.position,focused:el.dataset.focused,hidden:el.getAttribute('aria-hidden')})),split:Boolean(document.querySelector('#workspace-secondary-panel')),search:[...document.querySelectorAll('[data-slot=project-search]')].map(el=>({visible:el.getClientRects().length>0,html:el.closest('.project-tools-host')?.outerHTML.slice(0,600)})),inputs:document.querySelectorAll('.xterm-helper-textarea').length})"));await screenshot("terminal-failure");clearTimeout(deadline);app.exit(1);}
  });
});
server.listen(0,"127.0.0.1",()=>{
  fs.writeFileSync(path.join(home,"status.json"),JSON.stringify({pid:process.pid,port:server.address().port,controlToken:"synthetic-terminal",sessions}));
  import(pathToFileURL(path.join(__dirname,"../out/main/index.js")).href);
});
process.on("exit",()=>fs.rmSync(fixture,{recursive:true,force:true}));
