import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalEvent, TerminalPage, TerminalSnapshot } from "@prospero/protocol/rust-daemon";
import type { JsonObject } from "../shared/types";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 4096;
const MAX_ENTRIES = 8;
type Checkpoint = { version: 1; snapshot: TerminalSnapshot; events: TerminalEvent[]; seq: number };
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validSeq = (n: number) => Number.isSafeInteger(n) && n >= 0;
const validSize = (s: TerminalSnapshot["size"]) => s && Number.isInteger(s.cols) && s.cols >= 20 && s.cols <= 500 && Number.isInteger(s.rows) && s.rows >= 5 && s.rows <= 300;
const validData = (s: string) => typeof s === "string" && s.length <= MAX_BYTES && s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
function valid(value: Checkpoint): boolean {
  return value?.version === 1 && validSeq(value.seq) && validSeq(value.snapshot?.seq)
    && validSize(value.snapshot.size) && validData(value.snapshot.dataB64)
    && Array.isArray(value.events) && value.events.length <= MAX_EVENTS
    && value.snapshot.seq + value.events.length === value.seq
    && value.events.every(e => e.type === "output" ? validData(e.dataB64) : e.type === "resize" && validSize(e.size));
}

// A trusted initial snapshot plus every ordered byte/resize event, not a screen
// re-serialization. This preserves parser tails, Unicode, saved cursors and modes.
export class TerminalRecovery {
  private entries = new Map<string, Checkpoint>();
  private sizes = new Map<string, number>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving = Promise.resolve();
  constructor(private readonly directory: string) {}

  async load(id: string): Promise<void> {
    if (!validId(id) || this.entries.has(id)) return;
    try {
      const file = await open(join(this.directory, `${id}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let data: string;
      try { const info = await file.stat(); if (!info.isFile() || info.size > MAX_BYTES) return; data = await file.readFile("utf8"); }
      finally { await file.close(); }
      const value = JSON.parse(data) as Checkpoint;
      if (valid(value) && !this.entries.has(id)) this.put(id, value, false);
    } catch { /* A missing/invalid cache never substitutes for daemon state. */ }
  }

  private put(id: string, value: Checkpoint, dirty = true, bytes = JSON.stringify(value).length): void {
    if (!validId(id)) return;
    this.entries.delete(id); this.entries.set(id, value); this.sizes.set(id, bytes);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest); this.dirty.delete(oldest); this.sizes.delete(oldest);
    }
    if (dirty) {
      this.dirty.add(id);
      if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, 1000); this.timer.unref(); }
    }
  }

  snapshot(id: string, snapshot: TerminalSnapshot): void {
    if ((this.entries.get(id)?.seq ?? -1) > snapshot.seq) return;
    const value: Checkpoint = { version: 1, snapshot, events: [], seq: snapshot.seq };
    if (valid(value) && JSON.stringify(value).length <= MAX_BYTES / 2) this.put(id, value);
  }

  append(id: string, page: TerminalPage): boolean {
    if (page.resyncRequired || page.nextSeq - page.baseSeq !== page.events.length) return false;
    let entry = this.entries.get(id);
    if (entry && page.baseSeq === entry.seq && !page.events.length) return true;
    if (!entry && page.baseSeq === 0) entry = { version: 1, snapshot: { seq: 0, size: page.initialSize, dataB64: "" }, events: [], seq: 0 };
    if (!entry || page.baseSeq !== entry.seq) return false;
    const next: Checkpoint = { ...entry, events: [...entry.events, ...page.events], seq: page.nextSeq };
    const bytes = (this.sizes.get(id) ?? JSON.stringify(entry).length) + JSON.stringify(page.events).length + 32;
    if (next.events.length > MAX_EVENTS || bytes > MAX_BYTES / 2) return false;
    if (!page.events.every(e => e.type === "output" ? validData(e.dataB64) : e.type === "resize" && validSize(e.size))) return false;
    this.put(id, next, true, bytes);
    return true;
  }

  replay(id: string, cursor: number | undefined, floor: number, latest: number): JsonObject | undefined {
    const entry = this.entries.get(id);
    // Cached history must bridge all the way into the daemon's retained range.
    if (!entry || entry.seq < floor || entry.seq > latest) return undefined;
    if (cursor === undefined) return { kind: "pty", mode: "snapshot", seq: entry.snapshot.seq, cols: entry.snapshot.size.cols, rows: entry.snapshot.size.rows, dataB64: entry.snapshot.dataB64, caughtUp: entry.snapshot.seq === latest };
    if (cursor < entry.snapshot.seq || cursor >= entry.seq) return undefined;
    const events = entry.events.slice(cursor - entry.snapshot.seq, cursor - entry.snapshot.seq + 64);
    const seq = cursor + events.length;
    return { kind: "pty", mode: "events", baseSeq: cursor, seq, cols: entry.snapshot.size.cols, rows: entry.snapshot.size.rows, events, caughtUp: seq === latest } as unknown as JsonObject;
  }

  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const batch = [...this.dirty].flatMap(id => { const value = this.entries.get(id); return value ? [[id, JSON.stringify(value)] as const] : []; });
    this.dirty.clear();
    const save = this.saving.catch(() => {}).then(async () => {
      if (!batch.length) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const [id, data] of batch) {
        const temporary = join(this.directory, `${id}.pending`);
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { await file.writeFile(data); } finally { await file.close(); }
        await rename(temporary, join(this.directory, `${id}.json`));
      }
      const files = await Promise.all((await readdir(this.directory)).filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n)).map(async name => ({ name, time: (await stat(join(this.directory, name))).mtimeMs })));
      files.sort((a,b) => b.time - a.time);
      for (const file of files.slice(MAX_ENTRIES)) await rm(join(this.directory, file.name), { force: true });
    });
    this.saving = save;
    return save;
  }
}
