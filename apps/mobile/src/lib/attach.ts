import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import type { Attachment } from "@prospero/protocol";

/**
 * 图片附件的选取与归一化。
 *
 * 两件必须在客户端做的事:
 *
 * 1. 【格式】iOS 相册常给 HEIC,而模型只收 jpeg/png/gif/webp。让 daemon
 *    收下再拒是最差的:用户已经等了一次上传。统一转成 JPEG。
 * 2. 【尺寸】一张 12MP 照片 base64 后约 8MB,一条 WS 消息扛不住,也没必要 ——
 *    模型看图有自己的分辨率上限,超过就是白传。长边压到 1568px。
 */

/** 长边上限。再大对模型没有增益,只是更慢更贵。 */
const MAX_EDGE = 1568;
const QUALITY = 0.75;

export interface PickedImage extends Attachment {
  /** 本地预览用 */
  uri: string;
}

async function normalize(asset: ImagePicker.ImagePickerAsset): Promise<PickedImage | null> {
  const longest = Math.max(asset.width, asset.height);
  const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;

  const ctx = ImageManipulator.ImageManipulator.manipulate(asset.uri);
  if (scale < 1) {
    ctx.resize({ width: Math.round(asset.width * scale), height: Math.round(asset.height * scale) });
  }
  const image = await ctx.renderAsync();
  const out = await image.saveAsync({
    format: ImageManipulator.SaveFormat.JPEG,
    compress: QUALITY,
    base64: true,
  });
  if (!out.base64) return null;

  return {
    mimeType: "image/jpeg",
    dataB64: out.base64,
    name: asset.fileName ?? undefined,
    uri: out.uri,
  };
}

/** 从相册选;用户拒绝权限或取消都返回空数组,调用方不必分辨 */
export async function pickFromLibrary(max: number): Promise<PickedImage[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return [];
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: max > 1,
    selectionLimit: max,
    quality: 1,
  });
  if (result.canceled) return [];
  const out: PickedImage[] = [];
  for (const asset of result.assets.slice(0, max)) {
    const norm = await normalize(asset);
    if (norm) out.push(norm);
  }
  return out;
}

/** 现拍一张 */
export async function pickFromCamera(): Promise<PickedImage[]> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return [];
  const result = await ImagePicker.launchCameraAsync({ quality: 1 });
  if (result.canceled) return [];
  const asset = result.assets[0];
  if (!asset) return [];
  const norm = await normalize(asset);
  return norm ? [norm] : [];
}

/** 估算 base64 解码后的字节数,用于提示体积 */
export function approxBytes(dataB64: string): number {
  return Math.floor((dataB64.length * 3) / 4);
}
