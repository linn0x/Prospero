import { fromB64, toB64, type AgentUserAttachment } from "@prospero/protocol";

export const USER_ATTACHMENT_CHUNK_SIZE = 192 * 1024;
export const MAX_USER_ATTACHMENT_BYTES = 6 * 1024 * 1024;

export interface UserAttachmentChunk {
  mimeType: string;
  total: number;
  dataB64: string;
  eof: boolean;
}

export type UserAttachmentLoader = (
  msgId: string,
  attachment: AgentUserAttachment,
) => Promise<string>;

type AttachmentChunkReader = (
  msgId: string,
  attachmentId: string,
  offset: number,
  length: number,
) => Promise<UserAttachmentChunk>;

interface UserAttachmentLoaderOptions {
  sid: string;
  readChunk: AttachmentChunkReader;
  cache: Map<string, Promise<string>>;
}

/**
 * 按块读取历史用户图片，并缓存进行中的请求和成功结果。
 * 失败请求不能留在缓存中，否则后续点按重试会一直复用同一个 rejected promise。
 */
export function createUserAttachmentLoader({
  sid,
  readChunk,
  cache,
}: UserAttachmentLoaderOptions): UserAttachmentLoader {
  return (msgId, attachment) => {
    const key = `${sid}\u0000${msgId}\u0000${attachment.id}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const load = async (): Promise<string> => {
      let offset = 0;
      let total: number | null = null;
      let bytes: Uint8Array | null = null;
      for (;;) {
        const chunk = await readChunk(msgId, attachment.id, offset, USER_ATTACHMENT_CHUNK_SIZE);
        if (chunk.mimeType !== attachment.mimeType) throw new Error("图片类型不匹配");
        if (total === null) {
          total = chunk.total;
          if (total <= 0) throw new Error("图片文件为空");
          if (total > MAX_USER_ATTACHMENT_BYTES) throw new Error("图片超过 6 MB");
          bytes = new Uint8Array(total);
        } else if (chunk.total !== total) {
          throw new Error("读取图片时文件大小发生了变化");
        }
        const part = fromB64(chunk.dataB64);
        if (!bytes || offset + part.byteLength > bytes.byteLength) {
          throw new Error("图片分块响应无效");
        }
        bytes.set(part, offset);
        offset += part.byteLength;
        if (chunk.eof) break;
        if (part.byteLength === 0) throw new Error("图片传输提前中断");
      }
      if (!bytes || total === null || offset !== total) throw new Error("图片传输不完整");
      return `data:${attachment.mimeType};base64,${toB64(bytes)}`;
    };

    let request!: Promise<string>;
    request = load().catch((error: unknown) => {
      // 只删除属于这一次读取的条目，避免旧失败请求误删后来的重试请求。
      if (cache.get(key) === request) cache.delete(key);
      throw error;
    });
    if (cache.size >= 12) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, request);
    return request;
  };
}

export type UserAttachmentPreviewLoadState =
  | { status: "idle"; uri: null; error: null }
  | { status: "loading"; uri: null; error: null }
  | { status: "loaded"; uri: string; error: null }
  | { status: "failed"; uri: null; error: string };

export interface UserAttachmentPreviewLoadController {
  load: () => Promise<void>;
  dispose: () => void;
  subscribe: (listener: (state: UserAttachmentPreviewLoadState) => void) => () => void;
}

/**
 * 让图片预览的首次加载和重试共用一条请求：错误会先清除，重复点按不会启动并发读取。
 * dispose 后不再通知订阅者，因此组件卸载后的异步完成不会触发 state 更新。
 */
export function createUserAttachmentPreviewLoadController(
  loader: () => Promise<string>,
): UserAttachmentPreviewLoadController {
  let alive = true;
  let inFlight: Promise<void> | null = null;
  let state: UserAttachmentPreviewLoadState = { status: "idle", uri: null, error: null };
  const listeners = new Set<(next: UserAttachmentPreviewLoadState) => void>();

  const update = (next: UserAttachmentPreviewLoadState): void => {
    if (!alive) return;
    state = next;
    for (const listener of listeners) listener(state);
  };

  const load = (): Promise<void> => {
    if (!alive) return Promise.resolve();
    if (inFlight) return inFlight;

    // 重新尝试时先进入 loading 状态，旧的失败原因不会残留在界面上。
    update({ status: "loading", uri: null, error: null });
    const attempt = Promise.resolve()
      .then(loader)
      .then(
        (uri) => update({ status: "loaded", uri, error: null }),
        (reason: unknown) => update({
          status: "failed",
          uri: null,
          error: reason instanceof Error ? reason.message : String(reason),
        }),
      )
      .finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
    inFlight = attempt;
    return attempt;
  };

  return {
    load,
    dispose: () => {
      alive = false;
      listeners.clear();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
