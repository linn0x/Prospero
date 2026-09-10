import { describe, expect, it } from "vitest";
import { resolveMarkdownFileReference } from "../src/lib/file-references";

describe("Markdown document links", () => {
  it("resolves paths relative to the document and retains line references", () => {
    expect(resolveMarkdownFileReference("images/diagram.png", "docs/README.md", "/work", true)).toEqual({ path: "docs/images/diagram.png" });
    expect(resolveMarkdownFileReference("../src/main.ts:12", "docs/README.md", "/work", true)).toEqual({ path: "src/main.ts", line: 12 });
    expect(resolveMarkdownFileReference("<../My Report.md>", "docs/README.md", "/work", true)).toEqual({ path: "My Report.md" });
    expect(resolveMarkdownFileReference("/work/src/main.ts", "docs/README.md", "/work", true)).toEqual({ path: "src/main.ts" });
  });
  it("supports Windows projects and a document in the root directory", () => {
    expect(resolveMarkdownFileReference("../src/main.ts", "docs/README.md", "D:\\work", true)).toEqual({ path: "src/main.ts" });
    expect(resolveMarkdownFileReference("d:/work/src/main.ts", "docs/README.md", "D:\\work", true)).toEqual({ path: "src/main.ts" });
    expect(resolveMarkdownFileReference("images/a.png", "README.md", "/work", true)).toEqual({ path: "images/a.png" });
  });
  it("does not turn remote URLs, anchors, code commands or escaped project paths into local files", () => {
    for (const target of ["../../private.txt", "%2e%2e/%2e%2e/private.txt", "https://example.com/a.png", "#section", "/private.txt"]) {
      expect(resolveMarkdownFileReference(target, "docs/README.md", "/work", true)).toBeNull();
    }
    expect(resolveMarkdownFileReference("npm install", "docs/README.md", "/work", false)).toBeNull();
  });
});
