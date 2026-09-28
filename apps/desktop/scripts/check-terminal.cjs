// Real desktop renderer + IPC with a synthetic event-mode terminal service.
// All state lives in a temporary profile; no installed daemon is contacted.
const { app } = require("electron");
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
const sessions=Array.from({length:6},(_,index)=>({id:`terminal-ui-${index}`,agent:"custom",kind:"pty",terminalMode:"events",title:`Terminal check ${index}`,cwd:project,status:"running",createdAt:index+1}));
const encode=text=>Buffer.from(text).toString("base64");
const events=new Map(sessions.map(s=>[s.id,[{type:"output",dataB64:encode(Array.from({length:250},(_,n)=>`${s.id} 中文 line ${n}\r\n`).join("")+"\x1b[c\x1b[6nREADY> ")}]]));
const inputs=[],resizes=[];
const server=createServer((request,response)=>{
  let raw="";request.on("data",chunk=>raw+=chunk);request.on("end",()=>{
    const url=new URL(request.url,"http://localhost");
    response.setHeader("content-type","application/json");
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
    }else if(url.pathname.endsWith("/sessions"))response.end(JSON.stringify({items:sessions,hasMore:false}));
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
        assert(await run("Boolean(document.querySelector('#workspace-session-panel [aria-label=\"恢复本地选字\"]'))"),"Mouse preference persists across sessions");
      }
      await run("document.getElementById('workspace-tab-terminal-ui-0').click()");
      await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-screen'))");
      await run("document.querySelectorAll('#workspace-session-panel canvas').forEach(canvas=>canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext())");
      await wait("document.querySelector('#workspace-session-panel .terminal-find input')?.value==='line 20'");
      await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-rows')?.firstElementChild)");
      assert.equal(await run("document.querySelector('#workspace-session-panel .xterm-rows')?.firstElementChild?.textContent"),firstRow,"Evicted terminal restores reading viewport");
      await screenshot("terminal-parity");
      assert.deepEqual(errors,[]);
      const result={ok:true,checks:["real renderer + IPC event stream","GPU context-loss DOM fallback","no replay/live duplicate query reply","keyboard exactly once","multiline Unicode paste","image paste feedback","resize during output","reading/search restoration after six-session eviction","mouse preference across sessions"],latestResize:latest,output};
      fs.writeFileSync(path.join(output,"ui-result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));clearTimeout(deadline);app.exit(0);
    }catch(error){console.error(error);console.error(errors);console.error(await run("JSON.stringify({rows:document.querySelectorAll('.xterm-rows').length,text:document.querySelector('.xterm-rows')?.textContent,screen:document.querySelector('.xterm-screen')?.innerHTML.slice(0,300),inputs:document.querySelectorAll('.xterm-helper-textarea').length})"));await screenshot("terminal-failure");clearTimeout(deadline);app.exit(1);}
  });
});
server.listen(0,"127.0.0.1",()=>{
  fs.writeFileSync(path.join(home,"status.json"),JSON.stringify({pid:process.pid,port:server.address().port,controlToken:"synthetic-terminal",sessions}));
  import(pathToFileURL(path.join(__dirname,"../out/main/index.js")).href);
});
process.on("exit",()=>fs.rmSync(fixture,{recursive:true,force:true}));
