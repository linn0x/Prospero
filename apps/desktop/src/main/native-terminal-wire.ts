/** Bounded protocol between the main process and the native PTY relay. */
export class NativeRelayDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): Array<{ kind: string; payload: Buffer }> {
    // Socket chunks may contain many complete frames (e.g. a large paste).
    // Bound each declared frame, not the transport's arbitrary chunk size.
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Array<{ kind: string; payload: Buffer }> = [];
    while (this.pending.length >= 5) {
      const kind = String.fromCharCode(this.pending[0]!);
      const size = this.pending.readUInt32BE(1);
      if (!((kind === "I" && size > 0 && size <= 8192) || ((kind === "A" || kind === "R") && size === 4))) throw new Error("Invalid native relay frame");
      if (this.pending.length < size + 5) break;
      frames.push({ kind, payload: Buffer.from(this.pending.subarray(5, size + 5)) });
      this.pending = this.pending.subarray(size + 5);
    }
    // Retain at most one partial frame, without retaining a large input slab.
    this.pending = Buffer.from(this.pending);
    return frames;
  }
}

/** The daemon already answers these queries. Suppress them before Ghostty
 * sees them, including when CSI/OSC sequences straddle output frames. */
export class NativeTerminalQueryFilter {
  private pending = Buffer.alloc(0);
  reset(): void { this.pending = Buffer.alloc(0); }
  push(chunk: Uint8Array): Buffer {
    const input = Buffer.concat([this.pending, chunk]); this.pending = Buffer.alloc(0);
    const parts: Buffer[] = [];
    let start = 0, i = 0;
    while (i < input.length) {
      if (input[i] !== 27) { i++; continue; }
      const escape = i;
      if (i + 1 === input.length) { this.pending = input.subarray(i); break; }
      const kind = input[++i];
      if (kind !== 91 && kind !== 93) { i++; continue; }
      i++;
      let complete = false;
      while (i < input.length) {
        if (kind === 91 && input[i]! >= 0x40 && input[i]! <= 0x7e) { i++; complete = true; break; }
        if (kind === 93 && input[i] === 7) { i++; complete = true; break; }
        if (kind === 93 && input[i] === 27 && input[i + 1] === 92) { i += 2; complete = true; break; }
        i++;
      }
      if (!complete) {
        if (input.length - escape > 1024 * 1024) throw new Error("Unterminated native terminal escape sequence");
        this.pending = Buffer.from(input.subarray(escape)); i = escape; break;
      }
      const sequence = input.subarray(escape, i).toString("latin1");
      if (/^\x1b\[(?:0?c|6n)$/.test(sequence) || /^\x1b\](?:10|11);\?(?:\x07|\x1b\\)$/.test(sequence)) {
        parts.push(input.subarray(start, escape)); start = i;
      }
    }
    parts.push(input.subarray(start, i));
    return Buffer.concat(parts);
  }
}
