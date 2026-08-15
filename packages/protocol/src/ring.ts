/**
 * 会话输出环形缓冲:按字节容量保留最近的输出块,支撑断线续传。
 * daemon 每次合帧 flush 产生一个块并分配单调 seq;
 * 客户端 attach 携带 lastSeq,gap 仍在缓冲内则增量补发,否则回退全量快照。
 */

export interface RingChunk {
  seq: number;
  data: Uint8Array;
}

export class OutputRing {
  private chunks: RingChunk[] = [];
  private bytes = 0;
  private nextSeq = 1;

  constructor(private readonly capacityBytes = 1024 * 1024) {}

  /** 已分配的最后一个 seq(尚无输出时为 0) */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  push(data: Uint8Array): number {
    const seq = this.nextSeq++;
    this.chunks.push({ seq, data });
    this.bytes += data.byteLength;
    // 超容量时从最旧开始逐块淘汰;至少保留最新一块(单块超容也保留)
    while (this.bytes > this.capacityBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift()!;
      this.bytes -= evicted.data.byteLength;
    }
    return seq;
  }

  /**
   * 返回 lastSeq 之后的所有块;无法覆盖 gap(数据已被淘汰或 lastSeq 非法)
   * 时返回 null,调用方应改发全量快照。
   */
  since(lastSeq: number): Uint8Array[] | null {
    const entries = this.entriesSince(lastSeq);
    return entries?.map((entry) => entry.data) ?? null;
  }

  /**
   * 和 since() 相同，但保留每一帧的游标。Detached session host 用它把
   * owner 分配的 seq 原样交给重新连接的 daemon，不能由 client 重新编号。
   */
  entriesSince(lastSeq: number): RingChunk[] | null {
    if (lastSeq > this.lastSeq) return null; // 客户端声称的进度超前,状态不可信
    const oldest = this.chunks[0]?.seq ?? this.nextSeq;
    if (lastSeq + 1 < oldest && lastSeq < this.lastSeq) return null; // gap 已被淘汰
    return this.chunks.filter((c) => c.seq > lastSeq).map((c) => ({ ...c }));
  }
}
