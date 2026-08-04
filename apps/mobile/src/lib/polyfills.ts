/**
 * 必须在任何 @prospero/protocol(tweetnacl)使用之前导入。
 * tweetnacl 依赖 crypto.getRandomValues;Hermes 无内建时用 expo-crypto 补上。
 */
import * as Crypto from "expo-crypto";

type RandomValuesFn = <T extends ArrayBufferView | null>(array: T) => T;
const g = globalThis as { crypto?: { getRandomValues?: RandomValuesFn } };

if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = ((array: Uint8Array) =>
    Crypto.getRandomValues(array)) as RandomValuesFn;
}
