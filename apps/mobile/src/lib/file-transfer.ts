import { fromB64, toB64 } from "@prospero/protocol";

export interface FileDownloadChunk {
  offset: number;
  dataB64: string;
  total: number;
  eof: boolean;
}

export interface FileChunkReader {
  readonly size: number | null;
  readBytes(length: number): Uint8Array;
}

export async function downloadFileChunks(
  read: (offset: number, length: number) => Promise<FileDownloadChunk>,
  write: (bytes: Uint8Array) => void,
  chunkSize: number,
): Promise<number> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("下载分块大小无效");
  let offset = 0;
  let total: number | null = null;
  for (;;) {
    const chunk = await read(offset, chunkSize);
    if (chunk.offset !== offset) throw new Error("下载分块偏移不一致");
    if (total !== null && chunk.total !== total) throw new Error("下载期间文件已变更");
    total = chunk.total;
    const bytes = fromB64(chunk.dataB64);
    const nextOffset = offset + bytes.byteLength;
    if (nextOffset > total) throw new Error("下载分块超出文件大小");
    if (bytes.byteLength === 0 && !chunk.eof) throw new Error("下载分块未完整");
    if (chunk.eof !== (nextOffset === total)) throw new Error("下载分块未完整");
    write(bytes);
    offset = nextOffset;
    if (chunk.eof) return total;
  }
}

export async function uploadFileChunks(
  reader: FileChunkReader,
  send: (offset: number, dataB64: string, final: boolean) => Promise<unknown>,
  chunkSize: number,
): Promise<number> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("上传分块大小无效");
  const total = reader.size;
  if (total === null || !Number.isSafeInteger(total) || total < 0) {
    throw new Error("无法读取上传文件大小");
  }
  let offset = 0;
  for (;;) {
    const length = Math.min(chunkSize, total - offset);
    const bytes = length === 0 ? new Uint8Array() : reader.readBytes(length);
    if (bytes.byteLength === 0 && length > 0) throw new Error("上传文件提前结束");
    if (bytes.byteLength > length) throw new Error("上传分块超出请求大小");
    const nextOffset = offset + bytes.byteLength;
    const final = nextOffset === total;
    await send(offset, toB64(bytes), final);
    if (final) return total;
    offset = nextOffset;
  }
}
