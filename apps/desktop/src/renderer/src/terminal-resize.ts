export type TerminalResizeSize = { cols: number; rows: number };

function key(size: TerminalResizeSize): string {
  return `${size.cols}x${size.rows}`;
}

/** Coalesces geometry changes while a terminal page is being replayed. */
export class TerminalResizeCoordinator {
  private pending: TerminalResizeSize | undefined;
  private inFlight: { generation: number; requested: string } | undefined;
  private generation = 0;

  request(
    size: TerminalResizeSize,
    stable: boolean,
    canSend: boolean,
    send: (size: TerminalResizeSize) => Promise<unknown> | unknown,
    applyLocal: (size: TerminalResizeSize) => void,
  ): void {
    const normalized = { cols: Math.round(size.cols), rows: Math.round(size.rows) };
    const requested = key(normalized);
    if (!stable) {
      this.pending = normalized;
      return;
    }
    if (!canSend) {
      this.pending = undefined;
      this.inFlight = undefined;
      applyLocal(normalized);
      return;
    }
    if (this.inFlight) { this.pending = normalized; return; }
    this.pending = undefined;
    const flight = { generation: this.generation, requested };
    this.inFlight = flight;
    void Promise.resolve(send(normalized)).then(result => result !== false, () => false).then(success => {
      if (this.inFlight !== flight) return;
      this.inFlight = undefined;
      if (!success) { this.pending = normalized; return; }
      const next = this.pending;
      this.pending = undefined;
      if (next && key(next) !== requested) this.request(next, true, canSend, send, applyLocal);
    });
  }

  flush(
    canSend: boolean,
    send: (size: TerminalResizeSize) => Promise<unknown> | unknown,
    applyLocal: (size: TerminalResizeSize) => void,
  ): void {
    const next = this.pending;
    if (!next) return;
    this.request(next, true, canSend, send, applyLocal);
  }

  clear(): void {
    this.pending = undefined;
    this.inFlight = undefined;
    this.generation += 1;
  }
}
