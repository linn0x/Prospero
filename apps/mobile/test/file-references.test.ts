import { describe, expect, it } from "vitest";
import { resolveProjectFileReference } from "../src/lib/file-references";

const root = "/Users/me/My Project";

describe("agent 文件引用", () => {
  it("解析相对路径与行列号", () => {
    expect(resolveProjectFileReference("src/app.ts:42:7", root)).toEqual({
      path: "src/app.ts",
      line: 42,
      column: 7,
    });
    expect(resolveProjectFileReference("./README#L8", root)).toEqual({
      path: "README",
      line: 8,
    });
  });

  it("把项目内绝对路径降成相对路径", () => {
    expect(
      resolveProjectFileReference("/Users/me/My Project/src/index.ts:12", root, true),
    ).toEqual({ path: "src/index.ts", line: 12 });
    expect(
      resolveProjectFileReference("file:///Users/me/My%20Project/package.json#L2C4", root, true),
    ).toEqual({ path: "package.json", line: 2, column: 4 });
  });

  it("拒绝 URL、越界绝对路径与相对穿越", () => {
    expect(resolveProjectFileReference("https://example.com/app.ts", root, true)).toBeNull();
    expect(resolveProjectFileReference("/Users/me/secret.txt", root, true)).toBeNull();
    expect(resolveProjectFileReference("../secret.txt", root, true)).toBeNull();
    expect(resolveProjectFileReference("%2e%2e/secret.txt", root, true)).toBeNull();
  });

  it("普通行内代码不会被误认成文件", () => {
    expect(resolveProjectFileReference("npm test", root)).toBeNull();
    expect(resolveProjectFileReference("status=ok", root)).toBeNull();
    expect(resolveProjectFileReference("src/components/", root)).toBeNull();
    expect(resolveProjectFileReference("src/components/Button", root)).toEqual({
      path: "src/components/Button",
    });
  });
});
