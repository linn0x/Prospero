import { describe, expect, it } from "vitest";
import { OutputRing } from "../src/index.js";

const bytes = (...v: number[]) => Uint8Array.from(v);

describe("OutputRing", () => {
  it("push 分配单调 seq,since 增量返回", () => {
    const ring = new OutputRing(1024);
    expect(ring.lastSeq).toBe(0);
    expect(ring.since(0)).toEqual([]);
    expect(ring.push(bytes(1))).toBe(1);
    expect(ring.push(bytes(2))).toBe(2);
    expect(ring.push(bytes(3))).toBe(3);
    expect(ring.since(0)).toEqual([bytes(1), bytes(2), bytes(3)]);
    expect(ring.since(2)).toEqual([bytes(3)]);
    expect(ring.since(3)).toEqual([]); // 已是最新
  });

  it("超前的 lastSeq 返回 null", () => {
    const ring = new OutputRing(1024);
    ring.push(bytes(1));
    expect(ring.since(5)).toBeNull();
  });

  it("按字节容量淘汰,gap 被淘汰后返回 null", () => {
    const ring = new OutputRing(6);
    ring.push(bytes(1, 1)); // seq1
    ring.push(bytes(2, 2)); // seq2
    ring.push(bytes(3, 3)); // seq3 — 共 6 字节,正好
    ring.push(bytes(4, 4)); // seq4 — 淘汰 seq1
    expect(ring.since(0)).toBeNull(); // seq1 已不在
    expect(ring.since(1)).toEqual([bytes(2, 2), bytes(3, 3), bytes(4, 4)]);
    expect(ring.since(3)).toEqual([bytes(4, 4)]);
  });

  it("单块超容也保留最新块", () => {
    const ring = new OutputRing(4);
    ring.push(bytes(1));
    ring.push(Uint8Array.from({ length: 100 }, (_, i) => i)); // seq2,远超容量
    expect(ring.since(1)).toHaveLength(1);
    expect(ring.since(0)).toBeNull();
  });
});
