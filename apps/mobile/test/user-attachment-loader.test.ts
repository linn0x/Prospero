import { describe, expect, it, vi } from "vitest";
import type { AgentUserAttachment } from "@prospero/protocol";
import {
  createUserAttachmentLoader,
  createUserAttachmentPreviewLoadController,
} from "../src/lib/user-attachment-loader";

const attachment: AgentUserAttachment = {
  id: "image-1.png",
  mimeType: "image/png",
  name: "诊断截图.png",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("历史用户图片加载", () => {
  it("首次失败会显示失败状态，并从缓存删除 rejected promise", async () => {
    const cache = new Map<string, Promise<string>>();
    const readChunk = vi.fn().mockRejectedValueOnce(new Error("主机暂时离线"));
    const loadAttachment = createUserAttachmentLoader({ sid: "sid-1", readChunk, cache });
    const states: string[] = [];
    const controller = createUserAttachmentPreviewLoadController(() =>
      loadAttachment("msg-1", attachment),
    );
    controller.subscribe((state) => states.push(state.status));

    await controller.load();

    expect(states).toEqual(["loading", "failed"]);
    expect(cache).toHaveLength(0);
    expect(readChunk).toHaveBeenCalledTimes(1);
  });

  it("恢复后重试会清除旧错误、重新读取，并缓存成功图片", async () => {
    const cache = new Map<string, Promise<string>>();
    const readChunk = vi.fn()
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce({
        mimeType: "image/png",
        total: 3,
        dataB64: "AQID",
        eof: true,
      });
    const loadAttachment = createUserAttachmentLoader({ sid: "sid-1", readChunk, cache });
    const states: Array<{ status: string; error: string | null }> = [];
    const controller = createUserAttachmentPreviewLoadController(() =>
      loadAttachment("msg-1", attachment),
    );
    controller.subscribe((state) => states.push({ status: state.status, error: state.error }));

    await controller.load();
    const retry = controller.load();
    expect(states.at(-1)).toEqual({ status: "loading", error: null });
    await retry;

    expect(states.at(-1)).toEqual({ status: "loaded", error: null });
    expect(readChunk).toHaveBeenCalledTimes(2);
    const cached = loadAttachment("msg-1", attachment);
    await expect(cached).resolves.toBe("data:image/png;base64,AQID");
    expect(readChunk).toHaveBeenCalledTimes(2);
  });

  it("重复失败不会缓存旧错误，下一次仍能发起新的请求", async () => {
    const cache = new Map<string, Promise<string>>();
    const readChunk = vi.fn()
      .mockRejectedValueOnce(new Error("第一次失败"))
      .mockRejectedValueOnce(new Error("第二次失败"));
    const loadAttachment = createUserAttachmentLoader({ sid: "sid-1", readChunk, cache });
    const errors: string[] = [];
    const controller = createUserAttachmentPreviewLoadController(() =>
      loadAttachment("msg-1", attachment),
    );
    controller.subscribe((state) => {
      if (state.status === "failed") errors.push(state.error);
    });

    await controller.load();
    await controller.load();

    expect(errors).toEqual(["第一次失败", "第二次失败"]);
    expect(cache).toHaveLength(0);
    expect(readChunk).toHaveBeenCalledTimes(2);
  });

  it("连续点按重试只保留一个进行中的分块读取", async () => {
    const pending = deferred<string>();
    const loader = vi.fn(() => pending.promise);
    const controller = createUserAttachmentPreviewLoadController(loader);

    const first = controller.load();
    const second = controller.load();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);

    pending.resolve("data:image/png;base64,AQID");
    await first;
  });

  it("组件卸载后，未完成加载不会再通知 state", async () => {
    const pending = deferred<string>();
    const states: string[] = [];
    const controller = createUserAttachmentPreviewLoadController(() => pending.promise);
    controller.subscribe((state) => states.push(state.status));

    const request = controller.load();
    await Promise.resolve();
    controller.dispose();
    pending.resolve("data:image/png;base64,AQID");
    await request;

    expect(states).toEqual(["loading"]);
  });
});
