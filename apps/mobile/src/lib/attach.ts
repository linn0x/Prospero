import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Directory, File, Paths } from "expo-file-system";
import type { Attachment } from "@prospero/protocol";
import {
  MAX_COMPOSER_IMAGE_BYTES,
  type ComposerDraftImage,
  type PendingPickerContext,
  type PickerSource,
  clearPendingPickerContext,
  savePendingPickerContext,
} from "./composer-draft-store";

/** 长边上限。再大对模型没有增益，只会让上传更慢。 */
const MAX_EDGE = 1568;
const JPEG_QUALITIES = [0.75, 0.62, 0.5, 0.4];
const DRAFT_IMAGE_DIRECTORY = "prospero-composer-drafts";

export type { PickerSource } from "./composer-draft-store";

export interface PickedImage extends Omit<Attachment, "mimeType">, ComposerDraftImage {
  /** 本地预览用；图像数据只在内存和专用 cache 文件中存在。 */
  uri: string;
}

export type ImagePickResult =
  | { status: "selected"; source: PickerSource; images: PickedImage[] }
  | { status: "cancelled"; source: PickerSource }
  | { status: "permission_denied"; source: PickerSource; canAskAgain: boolean }
  | { status: "error"; source: PickerSource; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cacheDirectory(): Directory {
  const directory = new Directory(Paths.cache, DRAFT_IMAGE_DIRECTORY);
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function jpegFileName(): string {
  return `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.jpg`;
}

function normalizedName(fileName: string | null | undefined): string | undefined {
  if (!fileName) return undefined;
  const stem = fileName.replace(/\.[^/.]+$/, "") || "image";
  return `${stem.slice(0, 196)}.jpg`;
}

async function persistNormalizedJpeg(uri: string): Promise<string> {
  const destination = new File(cacheDirectory(), jpegFileName());
  const source = new File(uri);
  await source.copy(destination, { overwrite: true });
  return destination.uri;
}

/**
 * Normalize every source (including the Android recovery result) through one JPEG pipeline.
 * Iteratively reducing dimensions/quality keeps the decoded payload below the protocol cap.
 */
async function normalize(asset: ImagePicker.ImagePickerAsset): Promise<PickedImage> {
  const sourceLongest = Math.max(asset.width, asset.height, 1);
  for (let attempt = 0; attempt < JPEG_QUALITIES.length; attempt++) {
    const maxEdge = Math.max(320, Math.round(MAX_EDGE * Math.pow(0.72, attempt)));
    const scale = sourceLongest > maxEdge ? maxEdge / sourceLongest : 1;
    const ctx = ImageManipulator.ImageManipulator.manipulate(asset.uri);
    if (scale < 1) {
      ctx.resize({
        width: Math.max(1, Math.round(asset.width * scale)),
        height: Math.max(1, Math.round(asset.height * scale)),
      });
    }
    const image = await ctx.renderAsync();
    const out = await image.saveAsync({
      format: ImageManipulator.SaveFormat.JPEG,
      compress: JPEG_QUALITIES[attempt],
      base64: true,
    });
    if (!out.base64 || approxBytes(out.base64) > MAX_COMPOSER_IMAGE_BYTES) continue;
    const uri = await persistNormalizedJpeg(out.uri);
    return {
      mimeType: "image/jpeg",
      dataB64: out.base64,
      name: normalizedName(asset.fileName),
      uri,
    };
  }
  throw new Error("图片压缩后仍超过 6 MiB，请选择更小的图片。");
}

function isPickerError(
  result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult,
): result is ImagePicker.ImagePickerErrorResult {
  return "code" in result && "message" in result;
}

/** Convert a native picker response into the app's explicit result union. */
export async function normalizePickerResult(
  source: PickerSource,
  result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null,
  max: number,
): Promise<ImagePickResult> {
  if (result === null) return { status: "cancelled", source };
  if (isPickerError(result)) return { status: "error", source, message: result.message };
  if (result.canceled) return { status: "cancelled", source };
  try {
    const images: PickedImage[] = [];
    const assets = result.assets;
    if (!assets) return { status: "error", source, message: "没有可用的图片。" };
    for (const asset of assets.slice(0, max)) images.push(await normalize(asset));
    if (images.length === 0) {
      return { status: "error", source, message: "没有可用的图片。" };
    }
    return { status: "selected", source, images };
  } catch (error) {
    return { status: "error", source, message: errorMessage(error) };
  }
}

async function requestPermission(source: PickerSource): Promise<{ granted: boolean; canAskAgain: boolean }> {
  const response = source === "library"
    ? await ImagePicker.requestMediaLibraryPermissionsAsync()
    : await ImagePicker.requestCameraPermissionsAsync();
  return { granted: response.granted, canAskAgain: response.canAskAgain };
}

async function pick(
  source: PickerSource,
  max: number,
  pendingContext?: PendingPickerContext,
): Promise<ImagePickResult> {
  let permission: { granted: boolean; canAskAgain: boolean };
  try {
    permission = await requestPermission(source);
  } catch (error) {
    return { status: "error", source, message: errorMessage(error) };
  }
  if (!permission.granted) {
    return { status: "permission_denied", source, canAskAgain: permission.canAskAgain };
  }

  if (pendingContext) {
    try {
      // This write intentionally happens immediately before opening Android's external activity.
      await savePendingPickerContext(pendingContext);
    } catch (error) {
      return { status: "error", source, message: `无法保存图片选择上下文：${errorMessage(error)}` };
    }
  }

  try {
    const result = source === "library"
      ? await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: max > 1,
        selectionLimit: max,
        quality: 1,
      })
      : await ImagePicker.launchCameraAsync({ quality: 1 });
    return await normalizePickerResult(source, result, max);
  } catch (error) {
    return { status: "error", source, message: errorMessage(error) };
  } finally {
    // When Android destroys MainActivity this JS continuation does not run; recovery owns that case.
    if (pendingContext) {
      try {
        await clearPendingPickerContext(pendingContext);
      } catch {
        // The picker result itself remains useful even when cache-context cleanup is temporarily unavailable.
      }
    }
  }
}

/** From the library. A caller supplies context only for Android activity-recreation recovery. */
export function pickFromLibrary(
  max: number,
  pendingContext?: PendingPickerContext,
): Promise<ImagePickResult> {
  return pick("library", max, pendingContext);
}

/** Take one photo. */
export function pickFromCamera(
  pendingContext?: PendingPickerContext,
): Promise<ImagePickResult> {
  return pick("camera", 1, pendingContext);
}

/**
 * Android returns this after MainActivity was reclaimed. It deliberately shares normalizePickerResult
 * with normal picker completion so restored attachments obey the same JPEG and size constraints.
 */
export async function recoverPendingPickerResult(
  source: PickerSource,
  max: number,
): Promise<ImagePickResult> {
  try {
    return await normalizePickerResult(source, await ImagePicker.getPendingResultAsync(), max);
  } catch (error) {
    return { status: "error", source, message: errorMessage(error) };
  }
}

/** Estimate decoded bytes without retaining a second binary copy. */
export function approxBytes(dataB64: string): number {
  const padding = dataB64.endsWith("==") ? 2 : dataB64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((dataB64.length * 3) / 4) - padding);
}
