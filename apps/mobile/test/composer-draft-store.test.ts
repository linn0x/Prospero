import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("expo-file-system", () => ({ File: class {} }));

import {
  ANDROID_PICKER_CONTEXT_TTL_MS,
  COMPOSER_DRAFT_TTL_MS,
  MAX_COMPOSER_IMAGE_BYTES,
  createComposerDraftStore,
} from "../src/lib/composer-draft-store";

const scope = { hostId: "host-a", sid: "session-a" };

function b64(bytes: number): string {
  return Buffer.alloc(bytes, 7).toString("base64");
}

function testHarness(now = 1_000) {
  const values = new Map<string, string>();
  const deleted: string[] = [];
  const files = new Map<string, { data: string; size?: number; readable?: boolean }>();
  let clock = now;
  const store = createComposerDraftStore({
    storage: {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
      removeItem: async (key) => { values.delete(key); },
    },
    files: {
      fromUri: (uri) => ({
        get exists() { return files.has(uri); },
        get size() { return files.get(uri)?.size ?? Buffer.from(files.get(uri)?.data ?? "", "base64").length; },
        base64: async () => {
          const file = files.get(uri);
          if (!file || file.readable === false) throw new Error("cache unreadable");
          return file.data;
        },
        delete: () => {
          deleted.push(uri);
          files.delete(uri);
        },
      }),
    },
    now: () => clock,
  });
  return { store, values, files, deleted, setNow: (value: number) => { clock = value; } };
}

describe("composer draft store", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores text, selection and metadata only, and restores attachment bytes from cache", async () => {
    const h = testHarness();
    h.files.set("file:///cache/one.jpg", { data: b64(3) });
    await h.store.save(scope, {
      text: "look at this",
      selection: { start: 4, end: 7 },
      images: [{ uri: "file:///cache/one.jpg", mimeType: "image/jpeg", dataB64: b64(3), name: "one.jpg" }],
    });

    const raw = [...h.values.values()][0] ?? "";
    expect(raw).toContain("one.jpg");
    expect(raw).not.toContain(b64(3));
    await expect(h.store.load(scope)).resolves.toMatchObject({
      discardedAttachments: 0,
      draft: {
        text: "look at this",
        selection: { start: 4, end: 7 },
        images: [{ uri: "file:///cache/one.jpg", dataB64: b64(3) }],
      },
    });
  });

  it("keeps drafts isolated by host, session and subagent", async () => {
    const h = testHarness();
    await h.store.save(scope, { text: "main", selection: { start: 1, end: 1 }, images: [] });
    await h.store.save({ ...scope, sid: "session-b" }, { text: "other session", selection: { start: 0, end: 0 }, images: [] });
    await h.store.save({ ...scope, subagentId: "sub-1" }, { text: "subagent", selection: { start: 0, end: 0 }, images: [] });

    await expect(h.store.load(scope)).resolves.toMatchObject({ draft: { text: "main" } });
    await expect(h.store.load({ ...scope, sid: "session-b" })).resolves.toMatchObject({ draft: { text: "other session" } });
    await expect(h.store.load({ ...scope, subagentId: "sub-1" })).resolves.toMatchObject({ draft: { text: "subagent" } });
  });

  it("preserves text but drops unavailable/corrupt cache attachments", async () => {
    const h = testHarness();
    h.files.set("file:///cache/broken.jpg", { data: "not-base64", readable: true });
    await h.store.save(scope, {
      text: "keep this text",
      selection: { start: 0, end: 0 },
      images: [{ uri: "file:///cache/broken.jpg", mimeType: "image/jpeg", dataB64: b64(3) }],
    });
    h.files.get("file:///cache/broken.jpg")!.data = "not-base64";

    await expect(h.store.load(scope)).resolves.toMatchObject({
      discardedAttachments: 1,
      draft: { text: "keep this text", images: [] },
    });
    expect(h.deleted).toContain("file:///cache/broken.jpg");
  });

  it("does not revive a ghost draft when its cache file is missing", async () => {
    const h = testHarness();
    const image = { uri: "file:///cache/missing.jpg", mimeType: "image/jpeg" as const, dataB64: b64(3) };
    h.files.set(image.uri, { data: image.dataB64 });
    await h.store.save(scope, { text: "text survives", selection: { start: 2, end: 2 }, images: [image] });
    h.files.delete(image.uri);

    await expect(h.store.load(scope)).resolves.toMatchObject({
      discardedAttachments: 1,
      draft: { text: "text survives", images: [] },
    });
  });

  it("accepts exactly 6 MiB and rejects larger decoded files", async () => {
    const h = testHarness();
    const exact = b64(MAX_COMPOSER_IMAGE_BYTES);
    h.files.set("file:///cache/exact.jpg", { data: exact, size: MAX_COMPOSER_IMAGE_BYTES });
    await h.store.save(scope, {
      text: "edge",
      selection: { start: 0, end: 0 },
      images: [{ uri: "file:///cache/exact.jpg", mimeType: "image/jpeg", dataB64: exact }],
    });
    await expect(h.store.load(scope)).resolves.toMatchObject({ discardedAttachments: 0 });

    h.files.set("file:///cache/too-big.jpg", { data: b64(3), size: MAX_COMPOSER_IMAGE_BYTES + 1 });
    await h.store.save(scope, {
      text: "edge",
      selection: { start: 0, end: 0 },
      images: [{ uri: "file:///cache/too-big.jpg", mimeType: "image/jpeg", dataB64: b64(3) }],
    });
    await expect(h.store.load(scope)).resolves.toMatchObject({
      discardedAttachments: 1,
      draft: { text: "edge", images: [] },
    });
  });

  it("cleans files when sending/clearing, removing, or expiring a draft", async () => {
    const h = testHarness();
    const image = { uri: "file:///cache/clear.jpg", mimeType: "image/jpeg" as const, dataB64: b64(3) };
    h.files.set(image.uri, { data: image.dataB64 });
    await h.store.save(scope, { text: "send", selection: { start: 0, end: 0 }, images: [image] });
    await h.store.clear(scope);
    expect(h.deleted).toContain(image.uri);

    h.files.set(image.uri, { data: image.dataB64 });
    await h.store.save(scope, { text: "remove", selection: { start: 0, end: 0 }, images: [image] });
    await h.store.removeAttachment(scope, image.uri);
    expect(h.deleted.filter((uri) => uri === image.uri)).toHaveLength(2);

    h.files.set(image.uri, { data: image.dataB64 });
    await h.store.save(scope, { text: "expire", selection: { start: 0, end: 0 }, images: [image] });
    h.setNow(1_000 + COMPOSER_DRAFT_TTL_MS + 1);
    await expect(h.store.load(scope)).resolves.toEqual({ draft: null, discardedAttachments: 0 });
    expect(h.deleted.filter((uri) => uri === image.uri)).toHaveLength(3);
  });

  it("only exposes a pending picker result to its matching scope and expires it after one hour", async () => {
    const h = testHarness();
    const context = { ...scope, source: "library" as const, createdAt: 1_000 };
    await h.store.savePendingPickerContext(context);

    await expect(h.store.getPendingPickerContext({ ...scope, sid: "different" })).resolves.toEqual({
      context: null,
      expired: false,
    });
    await expect(h.store.getPendingPickerContext(scope)).resolves.toEqual({ context, expired: false });

    h.setNow(1_000 + ANDROID_PICKER_CONTEXT_TTL_MS + 1);
    await expect(h.store.getPendingPickerContext(scope)).resolves.toEqual({ context: null, expired: true });
    await expect(h.store.getPendingPickerContext(scope)).resolves.toEqual({ context: null, expired: false });
  });
});
