import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it } from "vitest";
import type { TerminalEvent, TerminalPage } from "@prospero/protocol/rust-daemon";
import { TerminalRecovery } from "../src/main/terminal-recovery";
import { configureRustTerminalUnicode } from "../src/renderer/src/terminal-unicode";
import { writeTerminalEvents } from "../src/renderer/src/terminal-events";

const dirs: string[] = [];
const caches: TerminalRecovery[] = [];
afterEach(async () => { for (const c of caches.splice(0)) await c.flush(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function cache() { const dir = await mkdtemp(join(tmpdir(), "terminal-recovery-")); dirs.push(dir); const c = new TerminalRecovery(dir); caches.push(c); return { c, dir }; }
const size = { cols: 24, rows: 8 };
const output = (s: string | Uint8Array): TerminalEvent => ({ type: "output", dataB64: Buffer.from(s).toString("base64") });
const page = (baseSeq: number, events: TerminalEvent[]): TerminalPage => ({ initialSize: size, baseSeq, nextSeq: baseSeq + events.length, latestSeq: baseSeq + events.length, floorSeq: 0, events, resyncRequired: false, exited: false, exitCode: null });
const write = (t: Terminal, data: Uint8Array) => new Promise<void>(done => t.write(data, done));
function state(t: Terminal) {
  const b = t.buffer.active;
  return { type: b.type, x: b.cursorX, y: b.cursorY, modes: t.modes,
    rows: Array.from({ length: t.rows }, (_, y) => Array.from({ length: t.cols }, (_, x) => { const c = b.getLine(b.baseY + y)?.getCell(x); return [c?.getChars(), c?.getWidth(), c?.getFgColor(), c?.getBgColor()]; })) };
}

it.each([
  ["split escape", "hello\x1b[31;", "1m中文\x1b[0m"],
  ["saved cursor", "\x1b[32mfirst\x1b7\x1b[5;4H\x1b[31msecond", "\x1b8restored"],
  ["alternate screen", "primary\x1b[?1049h\x1b[3;4Halternate", "\x1b[?1049l next"],
  ["scroll region", "first\x1b[2;6r\x1b[?6h\x1b[3;2Hmiddle", "\r\nnext\r\nlast"],
  ["combining and modes", "e\u0301 👩‍💻\x1b[?2031h\x1b[?1006h\x1b[?2004h", " next"],
])("survives a desktop restart with exact %s state and subsequent output", async (_name, before, after) => {
  const { c, dir } = await cache();
  // Split every byte, including UTF-8/control boundaries, across persisted pages.
  const bytes = Buffer.from(before!);
  for (let i=0;i<bytes.length;i++) expect(c.append("session", page(i, [output(bytes.subarray(i,i+1))]))).toBe(true);
  await c.flush();
  const recovered = new TerminalRecovery(dir); caches.push(recovered); await recovered.load("session");
  const original = new Terminal({ ...size, allowProposedApi: true }); const restored = new Terminal({ ...size, allowProposedApi: true });
  configureRustTerminalUnicode(original); configureRustTerminalUnicode(restored);
  try {
    for (const byte of bytes) await write(original, Buffer.from([byte]));
    const initial = recovered.replay("session", undefined, bytes.length, bytes.length)!;
    await write(restored, Buffer.from(initial.dataB64 as string,"base64"));
    let cursor = initial.seq as number;
    while (cursor < bytes.length) { const frame = recovered.replay("session", cursor, bytes.length, bytes.length)!; await writeTerminalEvents(restored, frame.events, () => true); cursor = frame.seq as number; }
    expect(state(restored)).toEqual(state(original));
    await write(original, Buffer.from(after!)); await write(restored, Buffer.from(after!));
    expect(state(restored)).toEqual(state(original));
  } finally { original.dispose(); restored.dispose(); }
});

it("keeps resize events in order and compacts from trusted snapshots", async () => {
  const { c, dir } = await cache();
  c.snapshot("s", { seq: 40, size, dataB64: Buffer.from("baseline").toString("base64") });
  expect(c.append("s", page(40,[{type:"resize",size:{cols:80,rows:24}},output("next")]))).toBe(true);
  await c.flush(); const fresh=new TerminalRecovery(dir);caches.push(fresh);await fresh.load("s");
  expect(fresh.replay("s",undefined,42,42)).toMatchObject({mode:"snapshot",seq:40});
  expect(fresh.replay("s",40,42,42)).toMatchObject({mode:"events",baseSeq:40,seq:42,events:[{type:"resize",size:{cols:80,rows:24}},output("next")]});
  expect((await stat(join(dir,"s.json"))).mode & 0o777).toBe(0o600);
});

it("rejects gaps, daemon cursor rollback, corrupt caches and path traversal", async () => {
  const {c,dir}=await cache();c.append("s",page(0,[output("a")]));
  expect(c.append("s",page(2,[output("gap")]))).toBe(false);
  expect(c.replay("s",undefined,2,3)).toBeUndefined();
  expect(c.replay("s",undefined,0,0)).toBeUndefined();
  await writeFile(join(dir,"bad.json"), '{"version":1,"seq":999}');
  await c.load("bad");expect(c.replay("bad",undefined,0,999)).toBeUndefined();
  c.snapshot("../escape",{seq:0,size,dataB64:""});await c.flush();
  expect(await readdir(dir)).not.toContain("escape.json");
});

it("bounds disk entries and refuses to turn an oversized prefix into a truncated checkpoint", async () => {
  const {c,dir}=await cache();
  for(let i=0;i<10;i++) c.append(`s${i}`,page(0,[output("a")]));
  await c.flush();expect((await readdir(dir)).filter(n=>n.endsWith('.json')).length).toBe(8);
  expect(c.append("large",page(0,[output("x".repeat(1100000))]))).toBe(false);
  expect(c.replay("large",undefined,0,1)).toBeUndefined();
  expect(JSON.parse(await readFile(join(dir,"s9.json"),"utf8")).seq).toBe(1);
});
