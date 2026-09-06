import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { fromB64, fromB64Url, toB64, toB64Url } from "../src/b64.js";

describe("portable base64", () => {
  it.each([0, 1, 2, 3, 4, 12_287, 12_288, 12_289, 24_577, 4 * 1024 * 1024])(
    "matches the platform codec and round trips %i binary bytes",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 73 + 19) & 255);
      const encoded = toB64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(Buffer.from(fromB64(encoded)).equals(Buffer.from(bytes))).toBe(true);
    },
  );

  it("preserves URL-safe encoding and unpadded final groups", () => {
    for (const value of ["f", "fo", "foo", "中文提示 😀"]) {
      const bytes = Buffer.from(value);
      expect(toB64Url(bytes)).toBe(bytes.toString("base64url"));
      expect(Buffer.from(fromB64Url(toB64Url(bytes))).equals(bytes)).toBe(true);
      expect(Buffer.from(fromB64(toB64(bytes).replace(/=+$/, "")))).toEqual(bytes);
    }
  });

  it.each(["a", "AA!A", "AA中A", "AA A", "AA=A"])("rejects malformed input %s", (value) => {
    expect(() => fromB64(value)).toThrow();
  });
});
