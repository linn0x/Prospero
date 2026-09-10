import { describe, expect, it } from "vitest";
import { resultFiles } from "../src/lib/result-files";
import { resolveProjectFileReference } from "../src/lib/file-references";

describe("result file references", () => {
  it("collects links, inline file paths, images and table references only once", () => {
    const source = '[报告](</work/out/report.pdf>)\n\n`out/report.pdf`\n\n![图表](/work/out/chart.png)\n\n| 文件 |\n| --- |\n| [数据](out/data.csv) |';
    expect(resultFiles(source, "/work").map((file) => file.path)).toEqual(["out/report.pdf", "out/chart.png", "out/data.csv"]);
  });
  it("resolves Windows file links case-insensitively inside their project root", () => {
    expect(resolveProjectFileReference("d:\\Work\\Result.txt:12", "D:\\work", true)).toEqual({ path: "Result.txt", line: 12 });
    expect(resolveProjectFileReference("D:/work-other/secret.txt", "D:/work", true)).toBeNull();
    expect(resolveProjectFileReference("D:/work/../secret.txt", "D:/work", true)).toBeNull();
    expect(resolveProjectFileReference("C:secret.txt", "D:/work", true)).toBeNull();
    expect(resolveProjectFileReference("/tmp/a.txt", "/", true)).toEqual({ path: "tmp/a.txt" });
  });
  it("excludes external URLs, unrelated paths, commands and fenced code", () => {
    expect(resultFiles('[web](https://example.com/file.pdf) [private](/secret/a.txt) `npm test`\n\n```\n/work/fake.txt\n```', "/work")).toEqual([]);
  });
});
