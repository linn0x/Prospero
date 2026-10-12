import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { RustClient } from "../src/main/rust-client";
import { rustTerminalView } from "../src/main/rust-runtime";
import { TerminalRecovery } from "../src/main/terminal-recovery";
import { configureRustTerminalUnicode } from "../src/renderer/src/terminal-unicode";
import { writeTerminalEvents } from "../src/renderer/src/terminal-events";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const write = (t: Terminal, bytes: Uint8Array) => new Promise<void>(done => t.write(bytes, done));
const screen = (t: Terminal) => ({ x: t.buffer.active.cursorX, y: t.buffer.active.cursorY, mode: t.buffer.active.type,
  rows: Array.from({length:t.rows},(_,y)=>{const line=t.buffer.active.getLine(t.buffer.active.baseY+y);// The snapshot intentionally starts at the viewport, without the preceding
    // scrollback line; only that first line's incoming wrap edge is outside it.
    return {wrapped:y===0?undefined:line?.isWrapped,cells:Array.from({length:t.cols},(_,x)=>{const c=line?.getCell(x);return [c?.getChars() || (c?.getWidth()===0?"":" "),c?.getWidth(),c?.getFgColor(),c?.getBgColor()];})};}) });

it("reconnects a fresh desktop to the same live PTY after history pruning and continues at the exact snapshot cursor", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "prospero-cold-recovery-"));
  let child: ChildProcess | undefined; let connection: {baseUrl:string;token:string} | undefined;
  const original = new Terminal({cols:80,rows:24,allowProposedApi:true});
  const restored = new Terminal({cols:80,rows:24,allowProposedApi:true});
  configureRustTerminalUnicode(original); configureRustTerminalUnicode(restored);
  let recovery: TerminalRecovery | undefined;
  try {
    child=spawn(process.env.PROSPERO_TEST_DAEMON || resolve("../../target/release/prosperod-rs"),["serve","--data-dir",dir],{stdio:["ignore","pipe","pipe"]});
    await new Promise<void>((done,fail)=>{let output="";const timer=setTimeout(()=>fail(new Error("daemon startup timeout")),10000);child!.once("exit",()=>{clearTimeout(timer);fail(new Error("daemon exited"));});child!.stdout!.on("data",b=>{output+=b;if(output.includes('"event":"ready"')){clearTimeout(timer);done();}});});
    connection=JSON.parse(await readFile(resolve(dir,"connection.json"),"utf8"));
    const c=connection!;
    const request=async(path:string,body?:unknown)=>{const r=await fetch(c.baseUrl+path,{method:body?"POST":"GET",headers:{authorization:`Bearer ${c.token}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});expect(r.ok).toBe(true);return r.json();};
    const session=await request("/v1/terminals",{title:"Recovery acceptance",agent:"custom",workspace:dir,size:{cols:80,rows:24},command:"stty raw -echo; printf READY; cat"});
    let cursor=0; let ready="";
    while(!ready.includes("READY")){const p=await request(`/v1/terminals/${session.id}/output?afterSeq=${cursor}&waitMs=1000`);cursor=p.nextSeq;await writeTerminalEvents(original,p.events,()=>true);for(const e of p.events)if(e.type==="output")ready+=Buffer.from(e.dataB64,"base64").toString();}
    // More than the daemon's 1 MiB retained byte budget; consume live output as
    // the old desktop would. Include the Claude mode that previously poisoned snapshots.
    for(let i=0;i<180;i++) {
      const text=(i===0?"\x1b[?2031h\x1b]9;unsupported\x07":"")+`row-${i}: 中文 🦀 `+"x".repeat(6900)+"\r\n";
      await request(`/v1/terminals/${session.id}/input`,{dataB64:Buffer.from(text).toString("base64")});
      let bytes=0;
      while(bytes<Buffer.byteLength(text)){const p=await request(`/v1/terminals/${session.id}/output?afterSeq=${cursor}&waitMs=1000`);expect(p.resyncRequired).toBe(false);cursor=p.nextSeq;await writeTerminalEvents(original,p.events,()=>true);for(const e of p.events)if(e.type==="output")bytes+=Buffer.from(e.dataB64,"base64").length;}
    }
    const retained=await request(`/v1/terminals/${session.id}/output?afterSeq=0`);
    expect(retained.floorSeq).toBe(0);
    const client = new RustClient(c.baseUrl,c.token);
    recovery=new TerminalRecovery(resolve(dir,"desktop-cache"));
    let frame=await rustTerminalView(client,session.id,undefined,0,AbortSignal.timeout(5000),recovery);
    expect(frame?.mode).toBe("events");
    restored.resize(frame!.cols as number,frame!.rows as number);
    while (frame) {
      await writeTerminalEvents(restored,frame.events,()=>true);
      if (frame.caughtUp !== false) break;
      frame=await rustTerminalView(client,session.id,frame.seq as number,0,AbortSignal.timeout(5000),recovery);
    }
    expect(screen(restored)).toEqual(screen(original));
    expect(frame!.seq).toBe(cursor);
    const suffix="\x1b[31mAFTER RESTART\x1b[0m\r\n";
    await request(`/v1/terminals/${session.id}/input`,{dataB64:Buffer.from(suffix).toString("base64")});
    const next=await rustTerminalView(client,session.id,cursor,1000,AbortSignal.timeout(5000),recovery);
    await writeTerminalEvents(original,next!.events,()=>true);await writeTerminalEvents(restored,next!.events,()=>true);
    expect(screen(restored)).toEqual(screen(original));
    await request(`/v1/terminals/${session.id}/close`,{});
  } finally {
    await recovery?.flush(); original.dispose();restored.dispose();
    if(connection)await fetch(connection.baseUrl+"/v1/shutdown",{method:"POST",headers:{authorization:`Bearer ${connection.token}`}}).catch(()=>{});
    if(child&&child.exitCode===null){const timer=setTimeout(()=>child?.kill("SIGKILL"),3000);await once(child,"exit");clearTimeout(timer);}
    await rm(dir,{recursive:true,force:true});
  }
},60000);

it("replays a closed PTY archive from sequence zero after daemon restart", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "prospero-closed-terminal-"));
  let child: ChildProcess | undefined; let connection: {baseUrl:string;token:string} | undefined;
  const start = async () => {
    child=spawn(process.env.PROSPERO_TEST_DAEMON || resolve("../../target/release/prosperod-rs"),["serve","--data-dir",dir],{stdio:["ignore","pipe","pipe"]});
    await new Promise<void>((done,fail)=>{let output="";const timer=setTimeout(()=>fail(new Error("daemon startup timeout")),10000);child!.once("exit",()=>{clearTimeout(timer);fail(new Error("daemon exited"));});child!.stdout!.on("data",b=>{output+=b;if(output.includes('"event":"ready"')){clearTimeout(timer);done();}});});
    connection=JSON.parse(await readFile(resolve(dir,"connection.json"),"utf8"));
  };
  try {
    await start();
    const request=async(path:string,body?:unknown)=>{const c=connection!;const r=await fetch(c.baseUrl+path,{method:body?"POST":"GET",headers:{authorization:`Bearer ${c.token}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});expect(r.ok).toBe(true);return r.json();};
    const session=await request("/v1/terminals",{title:"Closed archive",agent:"custom",workspace:dir,size:{cols:80,rows:24},command:"stty raw -echo; printf '\x1b]9;notification\x07ARCHIVE_A'; python3 -u -c 'import sys; [sys.stdout.write(\"x\"*4096) or sys.stdout.flush() for _ in range(400)]'; printf ARCHIVE_B; exit 0"});
    type Page = { baseSeq:number; nextSeq:number; latestSeq:number; floorSeq:number; events:Array<{type:string;dataB64?:string}>; exited:boolean };
    const pages: Page[]=[]; let cursor=0; const deadline=Date.now()+10000;
    while(Date.now()<deadline){const page=await request(`/v1/terminals/${session.id}/output?afterSeq=${cursor}&waitMs=200`) as Page; pages.push(page); expect(page.floorSeq).toBe(0); expect(page.baseSeq).toBe(cursor); expect(page.nextSeq-page.baseSeq).toBe(page.events.length); cursor=page.nextSeq; if(page.exited)break; await sleep(20);}
    expect(pages.at(-1)?.exited).toBe(true);
    const expected=Buffer.concat(pages.flatMap(page=>page.events.filter(event=>event.type==="output"&&event.dataB64).map(event=>Buffer.from(event.dataB64!,"base64"))));
    expect(expected.toString()).toContain("ARCHIVE_A"); expect(expected.toString()).toContain("ARCHIVE_B"); expect(expected.byteLength).toBeGreaterThan(1024*1024);
    const exited=once(child!,"exit"); child!.kill("SIGKILL"); await exited;
    child=undefined; await start();
    const replay: Buffer[]=[]; cursor=0; let archived: Page | undefined;
    for(let attempt=0;attempt<100;attempt++) { archived=await request(`/v1/terminals/${session.id}/output?afterSeq=${cursor}`) as Page; expect(archived.floorSeq).toBe(0); expect(archived.baseSeq).toBe(cursor); expect(archived.nextSeq-archived.baseSeq).toBe(archived.events.length); replay.push(...archived.events.filter(event=>event.type==="output"&&event.dataB64).map(event=>Buffer.from(event.dataB64!,"base64"))); cursor=archived.nextSeq; if(archived.exited&&cursor===archived.latestSeq)break; }
    expect(archived?.exited).toBe(true); expect(Buffer.concat(replay)).toEqual(expected);
  } finally {
    if(connection)await fetch(connection.baseUrl+"/v1/shutdown",{method:"POST",headers:{authorization:`Bearer ${connection.token}`}}).catch(()=>{});
    if(child&&child.exitCode===null){const timer=setTimeout(()=>child?.kill("SIGKILL"),3000);await once(child,"exit");clearTimeout(timer);}
    await rm(dir,{recursive:true,force:true});
  }
},45000);
