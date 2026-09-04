import { describe, expect, it, vi } from "vitest";
import { toB64 } from "@prospero/protocol";
import { downloadFileChunks, uploadFileChunks } from "../src/lib/file-transfer";

function bytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) % 256);
}

describe("file transfer", () => {
  it("streams independently padded download chunks without truncation", async () => {
    const chunkSize = 256 * 1024;
    const source = bytes(chunkSize * 2 + 17);
    const written: Uint8Array[] = [];
    const read = vi.fn(async (offset: number, length: number) => {
      const data = source.subarray(offset, Math.min(offset + length, source.length));
      return {
        offset,
        dataB64: toB64(data),
        total: source.length,
        eof: offset + data.length === source.length,
      };
    });

    await expect(downloadFileChunks(read, (chunk) => written.push(chunk), chunkSize))
      .resolves.toBe(source.length);
    expect(written).toHaveLength(3);
    expect(Buffer.concat(written.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(source));
  });

  it("streams upload chunks sequentially and waits for each acknowledgement", async () => {
    const chunkSize = 256 * 1024;
    const source = bytes(chunkSize * 2 + 17);
    let readOffset = 0;
    let release!: () => void;
    const firstAcknowledgement = new Promise<void>((resolve) => { release = resolve; });
    const sent: Array<{ offset: number; dataB64: string; final: boolean }> = [];
    const pending = uploadFileChunks({
      size: source.length,
      readBytes: (length) => {
        const chunk = source.subarray(readOffset, readOffset + length);
        readOffset += chunk.length;
        return chunk;
      },
    }, async (offset, dataB64, final) => {
      sent.push({ offset, dataB64, final });
      if (sent.length === 1) await firstAcknowledgement;
    }, chunkSize);

    await Promise.resolve();
    expect(sent).toHaveLength(1);
    release();
    await expect(pending).resolves.toBe(source.length);
    expect(sent.map(({ offset, final }) => ({ offset, final }))).toEqual([
      { offset: 0, final: false },
      { offset: chunkSize, final: false },
      { offset: chunkSize * 2, final: true },
    ]);
  });

  it("preserves empty files in both directions", async () => {
    const writes: Uint8Array[] = [];
    await expect(downloadFileChunks(
      async () => ({ offset: 0, dataB64: "", total: 0, eof: true }),
      (chunk) => writes.push(chunk),
      256 * 1024,
    )).resolves.toBe(0);
    const send = vi.fn(async () => undefined);
    await expect(uploadFileChunks({
      size: 0,
      readBytes: () => new Uint8Array(),
    }, send, 256 * 1024)).resolves.toBe(0);
    expect(writes).toEqual([new Uint8Array()]);
    expect(send).toHaveBeenCalledWith(0, "", true);
  });

  it("rejects a changing or truncated source", async () => {
    await expect(downloadFileChunks(
      async (offset) => ({ offset, dataB64: "", total: 1, eof: false }),
      () => undefined,
      8,
    )).rejects.toThrow("未完整");
    await expect(uploadFileChunks({
      size: 1,
      readBytes: () => new Uint8Array(),
    }, async () => undefined, 8)).rejects.toThrow("提前结束");
  });
});
