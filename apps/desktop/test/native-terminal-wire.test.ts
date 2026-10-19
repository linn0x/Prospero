import { describe, expect, it } from "vitest";
import { NativeRelayDecoder, NativeTerminalQueryFilter } from "../src/main/native-terminal-wire";

describe("native Ghostty relay", () => {
  it("decodes fragmented and coalesced input without accepting unknown or oversized messages", () => {
    const frame = Buffer.from([73, 0, 0, 0, 3, 97, 98, 99]);
    const decoder = new NativeRelayDecoder();
    expect(decoder.push(frame.subarray(0, 6))).toEqual([]);
    expect(decoder.push(Buffer.concat([frame.subarray(6), frame])).map(x => x.payload.toString())).toEqual(["abc", "abc"]);
    expect(() => new NativeRelayDecoder().push(Buffer.from([73, 0, 1, 0, 0]))).toThrow();
    expect(() => new NativeRelayDecoder().push(Buffer.from([79, 0, 0, 0, 4]))).toThrow();
  });
  it("accepts large coalesced paste bursts while bounding individual frames", () => {
    const payload = Buffer.alloc(8192, 97);
    const header = Buffer.from([73, 0, 0, 32, 0]);
    const frame = Buffer.concat([header, payload]);
    const decoder = new NativeRelayDecoder();
    expect(decoder.push(frame.subarray(0, 20))).toEqual([]);
    const result = decoder.push(Buffer.concat([frame.subarray(20), ...Array.from({ length: 12 }, () => frame)]));
    expect(result).toHaveLength(13);
    expect(result.every(f => f.payload.equals(payload))).toBe(true);
  });
  it("removes daemon-owned reports at every possible stream boundary and preserves rendering escapes", () => {
    const source = Buffer.from("中文\x1b[31mred\x1b[0m\x1b[c\x1b[0c\x1b[6n\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]0;title\x07end");
    const expected = "中文\x1b[31mred\x1b[0m\x1b]0;title\x07end";
    for (let split = 0; split <= source.length; split++) {
      const filter = new NativeTerminalQueryFilter();
      expect(Buffer.concat([filter.push(source.subarray(0, split)), filter.push(source.subarray(split))]).toString()).toBe(expected);
    }
  });
});
