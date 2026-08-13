import AsyncStorage from "@react-native-async-storage/async-storage";
import { File } from "expo-file-system";

/** The transport limit is deliberately enforced on decoded JPEG bytes. */
export const MAX_COMPOSER_IMAGES = 6;
export const MAX_COMPOSER_IMAGE_BYTES = 6 * 1024 * 1024;
export const COMPOSER_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ANDROID_PICKER_CONTEXT_TTL_MS = 60 * 60 * 1000;

const DRAFT_KEY_PREFIX = "prospero.composerDraft.v1";
const PICKER_CONTEXT_KEY = "prospero.composerPickerContext.v1";

export type PickerSource = "library" | "camera";

export interface ComposerDraftScope {
  hostId: string;
  sid: string;
  subagentId?: string;
}

export interface ComposerSelection {
  start: number;
  end: number;
}

/** This is intentionally the in-memory shape. dataB64 is never written to AsyncStorage. */
export interface ComposerDraftImage {
  mimeType: "image/jpeg";
  dataB64: string;
  name?: string;
  uri: string;
}

export interface ComposerDraftInput {
  text: string;
  selection: ComposerSelection;
  images: readonly ComposerDraftImage[];
}

export interface RestoredComposerDraft {
  draft: ComposerDraftInput | null;
  /** Files in cache can be purged by the OS; keep the text rather than reviving a ghost thumbnail. */
  discardedAttachments: number;
}

export interface PendingPickerContext extends ComposerDraftScope {
  source: PickerSource;
  createdAt: number;
}

export interface PendingPickerLookup {
  context: PendingPickerContext | null;
  expired: boolean;
}

interface StoredAttachment {
  uri: string;
  mimeType: "image/jpeg";
  name?: string;
}

interface StoredDraft {
  version: 1;
  updatedAt: number;
  text: string;
  selection: ComposerSelection;
  attachments: StoredAttachment[];
}

interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface DraftFile {
  readonly exists: boolean;
  readonly size: number;
  base64(): Promise<string>;
  delete(): void;
}

interface FileAccess {
  fromUri(uri: string): DraftFile;
}

export interface ComposerDraftStoreOptions {
  storage?: StorageLike;
  files?: FileAccess;
  now?: () => number;
}

function storageKey(scope: ComposerDraftScope): string {
  return `${DRAFT_KEY_PREFIX}:${encodeURIComponent(scope.hostId)}:${encodeURIComponent(scope.sid)}:${encodeURIComponent(scope.subagentId ?? "")}`;
}

function sameScope(a: ComposerDraftScope, b: ComposerDraftScope): boolean {
  return a.hostId === b.hostId && a.sid === b.sid && a.subagentId === b.subagentId;
}

export function pendingPickerContextMatches(
  scope: ComposerDraftScope,
  context: PendingPickerContext,
): boolean {
  return sameScope(scope, context);
}

function decodedBytes(dataB64: string): number {
  const padding = dataB64.endsWith("==") ? 2 : dataB64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((dataB64.length * 3) / 4) - padding);
}

function isUsableBase64(dataB64: string): boolean {
  return dataB64.length > 0 && dataB64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(dataB64);
}

function validSelection(value: unknown, textLength: number): ComposerSelection {
  const candidate = value as Partial<ComposerSelection> | null;
  const start = Number.isFinite(candidate?.start)
    ? Math.max(0, Math.min(textLength, Math.floor(candidate!.start!)))
    : textLength;
  const end = Number.isFinite(candidate?.end)
    ? Math.max(start, Math.min(textLength, Math.floor(candidate!.end!)))
    : start;
  return { start, end };
}

function parseStoredDraft(raw: string | null): StoredDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredDraft>;
    const updatedAt = value.updatedAt;
    if (
      value.version !== 1 ||
      typeof updatedAt !== "number" || !Number.isFinite(updatedAt) ||
      typeof value.text !== "string" ||
      !Array.isArray(value.attachments)
    ) {
      return null;
    }
    const attachments = value.attachments
      .filter((item): item is StoredAttachment => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<StoredAttachment>;
        return candidate.mimeType === "image/jpeg" && typeof candidate.uri === "string";
      })
      .slice(0, MAX_COMPOSER_IMAGES)
      .map((item) => ({
        uri: item.uri,
        mimeType: "image/jpeg" as const,
        ...(typeof item.name === "string" && item.name.length > 0 ? { name: item.name } : {}),
      }));
    return {
      version: 1,
      updatedAt,
      text: value.text,
      selection: validSelection(value.selection, value.text.length),
      attachments,
    };
  } catch {
    return null;
  }
}

function parsePendingContext(raw: string | null): PendingPickerContext | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingPickerContext>;
    const createdAt = value.createdAt;
    if (
      typeof value.hostId !== "string" ||
      value.hostId.length === 0 ||
      typeof value.sid !== "string" ||
      value.sid.length === 0 ||
      (value.subagentId !== undefined && typeof value.subagentId !== "string") ||
      (value.source !== "library" && value.source !== "camera") ||
      typeof createdAt !== "number" || !Number.isFinite(createdAt)
    ) {
      return null;
    }
    return {
      hostId: value.hostId,
      sid: value.sid,
      ...(value.subagentId ? { subagentId: value.subagentId } : {}),
      source: value.source,
      createdAt,
    };
  } catch {
    return null;
  }
}

function nativeFileAccess(): FileAccess {
  return {
    fromUri: (uri) => new File(uri),
  };
}

/**
 * A tiny, injectable persistence boundary so lifecycle handling is testable without a device.
 * One serialized mutation chain prevents a late autosave from recreating a draft after send/clear.
 */
export function createComposerDraftStore(options: ComposerDraftStoreOptions = {}) {
  const storage = options.storage ?? AsyncStorage;
  const files = options.files ?? nativeFileAccess();
  const now = options.now ?? Date.now;
  let mutations: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutations.then(operation, operation);
    mutations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const deleteFiles = async (attachments: readonly StoredAttachment[]): Promise<void> => {
    for (const attachment of attachments) {
      try {
        const file = files.fromUri(attachment.uri);
        if (file.exists) file.delete();
      } catch {
        // Cache cleanup must never make a draft unreadable.
      }
    }
  };

  const clearUnsafe = async (scope: ComposerDraftScope): Promise<void> => {
    const key = storageKey(scope);
    const existing = parseStoredDraft(await storage.getItem(key));
    await storage.removeItem(key);
    if (existing) await deleteFiles(existing.attachments);
  };

  const save = async (scope: ComposerDraftScope, input: ComposerDraftInput): Promise<void> =>
    serialize(async () => {
      const acceptedImages = input.images
        .filter((image) => isUsableBase64(image.dataB64) && decodedBytes(image.dataB64) <= MAX_COMPOSER_IMAGE_BYTES)
        .slice(0, MAX_COMPOSER_IMAGES);
      const rejectedImages = input.images.filter((image) => !acceptedImages.includes(image));
      const attachments = acceptedImages.map<StoredAttachment>((image) => ({
        uri: image.uri,
        mimeType: "image/jpeg",
        ...(image.name ? { name: image.name } : {}),
      }));
      const key = storageKey(scope);
      const previous = parseStoredDraft(await storage.getItem(key));
      const currentUris = new Set(attachments.map((attachment) => attachment.uri));
      const cleanupByUri = new Map<string, StoredAttachment>();
      for (const attachment of previous?.attachments ?? []) {
        if (!currentUris.has(attachment.uri)) cleanupByUri.set(attachment.uri, attachment);
      }
      for (const image of rejectedImages) {
        if (!currentUris.has(image.uri)) {
          cleanupByUri.set(image.uri, { uri: image.uri, mimeType: "image/jpeg" });
        }
      }
      if (input.text.length === 0 && attachments.length === 0) {
        await storage.removeItem(key);
        await deleteFiles([...cleanupByUri.values()]);
        return;
      }
      const stored: StoredDraft = {
        version: 1,
        updatedAt: now(),
        text: input.text,
        selection: validSelection(input.selection, input.text.length),
        attachments,
      };
      await storage.setItem(key, JSON.stringify(stored));
      await deleteFiles([...cleanupByUri.values()]);
    });

  const clear = async (scope: ComposerDraftScope): Promise<void> =>
    serialize(() => clearUnsafe(scope));

  const removeAttachment = async (scope: ComposerDraftScope, uri: string): Promise<void> =>
    serialize(async () => {
      const key = storageKey(scope);
      const current = parseStoredDraft(await storage.getItem(key));
      if (current) {
        const attachments = current.attachments.filter((attachment) => attachment.uri !== uri);
        if (current.text.length === 0 && attachments.length === 0) {
          await storage.removeItem(key);
        } else {
          await storage.setItem(key, JSON.stringify({ ...current, updatedAt: now(), attachments }));
        }
      }
      try {
        const file = files.fromUri(uri);
        if (file.exists) file.delete();
      } catch {
        // The metadata still needs to be removed when the cache file is already gone.
      }
    });

  const load = async (scope: ComposerDraftScope): Promise<RestoredComposerDraft> => {
    await mutations;
    const key = storageKey(scope);
    const stored = parseStoredDraft(await storage.getItem(key));
    if (!stored) return { draft: null, discardedAttachments: 0 };
    if (now() - stored.updatedAt > COMPOSER_DRAFT_TTL_MS) {
      await clear(scope);
      return { draft: null, discardedAttachments: 0 };
    }

    const images: ComposerDraftImage[] = [];
    let discardedAttachments = 0;
    for (const attachment of stored.attachments) {
      try {
        const file = files.fromUri(attachment.uri);
        if (!file.exists || file.size <= 0 || file.size > MAX_COMPOSER_IMAGE_BYTES) {
          discardedAttachments++;
          continue;
        }
        const dataB64 = await file.base64();
        if (!isUsableBase64(dataB64) || decodedBytes(dataB64) > MAX_COMPOSER_IMAGE_BYTES) {
          discardedAttachments++;
          continue;
        }
        images.push({
          uri: attachment.uri,
          mimeType: "image/jpeg",
          dataB64,
          ...(attachment.name ? { name: attachment.name } : {}),
        });
      } catch {
        discardedAttachments++;
      }
    }
    const draft: ComposerDraftInput = {
      text: stored.text,
      selection: stored.selection,
      images,
    };
    if (discardedAttachments > 0) {
      // Persist the valid subset and delete invalid cache files so a future launch stays clean.
      await save(scope, draft);
    }
    return { draft, discardedAttachments };
  };

  const savePendingPickerContext = async (context: PendingPickerContext): Promise<void> =>
    serialize(async () => {
      await storage.setItem(PICKER_CONTEXT_KEY, JSON.stringify(context));
    });

  const getPendingPickerContext = async (
    scope: ComposerDraftScope,
  ): Promise<PendingPickerLookup> => {
    await mutations;
    const context = parsePendingContext(await storage.getItem(PICKER_CONTEXT_KEY));
    if (!context) return { context: null, expired: false };
    if (now() - context.createdAt > ANDROID_PICKER_CONTEXT_TTL_MS) {
      await clearPendingPickerContext(context);
      return { context: null, expired: true };
    }
    return {
      context: pendingPickerContextMatches(scope, context) ? context : null,
      expired: false,
    };
  };

  const clearPendingPickerContext = async (expected?: PendingPickerContext): Promise<void> =>
    serialize(async () => {
      if (expected) {
        const current = parsePendingContext(await storage.getItem(PICKER_CONTEXT_KEY));
        if (
          !current ||
          current.createdAt !== expected.createdAt ||
          current.source !== expected.source ||
          !sameScope(current, expected)
        ) {
          return;
        }
      }
      await storage.removeItem(PICKER_CONTEXT_KEY);
    });

  return {
    save,
    load,
    clear,
    removeAttachment,
    savePendingPickerContext,
    getPendingPickerContext,
    clearPendingPickerContext,
  };
}

const defaultStore = createComposerDraftStore();

export const saveComposerDraft = defaultStore.save;
export const loadComposerDraft = defaultStore.load;
export const clearComposerDraft = defaultStore.clear;
export const removeComposerDraftAttachment = defaultStore.removeAttachment;
export const savePendingPickerContext = defaultStore.savePendingPickerContext;
export const getPendingPickerContext = defaultStore.getPendingPickerContext;
export const clearPendingPickerContext = defaultStore.clearPendingPickerContext;
