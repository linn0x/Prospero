import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FsError,
  makeDir,
  removeEntry,
  renameEntry,
  MAX_EDIT_BYTES,
  listDir,
  readChunk,
  readForEdit,
  resolveWithin,
  writeChunk,
  writeFileAt,
} from "../src/fs-ops.js";

const temps: string[] = [];

/** 造一个项目根,外面放一个"机密"文件用来验证越界 */
function fixture(): { root: string; outside: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "prospero-fs-"));
  temps.push(base);
  const root = path.join(base, "project");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# hello\n");
  writeFileSync(path.join(root, "src", "main.ts"), "export const x = 1;\n");
  const outside = path.join(base, "secret.txt");
  writeFileSync(outside, "TOP SECRET\n");
  return { root, outside };
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("路径根约束", () => {
  it("正常相对路径解析到根内", async () => {
    const { root } = fixture();
    const p = await resolveWithin(root, "src/main.ts");
    expect(p.endsWith(path.join("project", "src", "main.ts"))).toBe(true);
  });

  it("../ 逃逸被拒", async () => {
    const { root } = fixture();
    await expect(resolveWithin(root, "../secret.txt")).rejects.toThrow(/escapes/);
  });

  it("多级 ../ 逃逸被拒", async () => {
    const { root } = fixture();
    await expect(resolveWithin(root, "src/../../../etc/passwd")).rejects.toThrow(
      /escapes|does not exist/,
    );
  });

  it("符号链接指向根外时被拒 —— 这是纯字符串检查漏掉的那种", async () => {
    const { root, outside } = fixture();
    symlinkSync(outside, path.join(root, "leak.txt"));
    await expect(resolveWithin(root, "leak.txt")).rejects.toThrow(/escapes/);
    await expect(readForEdit(root, "leak.txt")).rejects.toThrow(/escapes/);
  });

  it("指向根外目录的符号链接也不能用来列目录", async () => {
    const { root } = fixture();
    const base = path.dirname(root);
    symlinkSync(base, path.join(root, "up"));
    await expect(listDir(root, "up")).rejects.toThrow(/escapes/);
  });

  it("允许在已存在的目录里新建文件", async () => {
    const { root } = fixture();
    const p = await resolveWithin(root, "src/new-file.ts");
    expect(p.endsWith(path.join("src", "new-file.ts"))).toBe(true);
  });

  it("父目录不存在时拒绝(不隐式建目录)", async () => {
    const { root } = fixture();
    await expect(resolveWithin(root, "nope/deep/file.ts")).rejects.toThrow(/does not exist/);
  });
});

describe("浏览", () => {
  it("目录在前,再按名字排", async () => {
    const { root } = fixture();
    const entries = await listDir(root, "");
    expect(entries.map((e) => e.name)).toEqual(["src", "README.md"]);
    expect(entries[0]?.kind).toBe("dir");
    expect(entries[1]?.size).toBeGreaterThan(0);
  });

  it("对文件调用列目录会报错", async () => {
    const { root } = fixture();
    await expect(listDir(root, "README.md")).rejects.toThrow(FsError);
  });
});

describe("编辑", () => {
  it("读回内容并标明非二进制", async () => {
    const { root } = fixture();
    const r = await readForEdit(root, "README.md");
    expect(r.content.toString("utf8")).toBe("# hello\n");
    expect(r.binary).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("含 NUL 的文件判定为二进制,前端据此禁用编辑", async () => {
    const { root } = fixture();
    writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
    expect((await readForEdit(root, "blob.bin")).binary).toBe(true);
  });

  it("超过上限的文件被截断且标记 truncated", async () => {
    const { root } = fixture();
    writeFileSync(path.join(root, "big.txt"), Buffer.alloc(MAX_EDIT_BYTES + 1024, 0x61));
    const r = await readForEdit(root, "big.txt");
    expect(r.truncated).toBe(true);
    expect(r.content.byteLength).toBe(MAX_EDIT_BYTES);
    expect(r.size).toBe(MAX_EDIT_BYTES + 1024);
  });

  it("写回后能读到新内容", async () => {
    const { root } = fixture();
    await writeFileAt(root, "src/main.ts", Buffer.from("export const x = 2;\n"));
    expect((await readForEdit(root, "src/main.ts")).content.toString()).toBe(
      "export const x = 2;\n",
    );
  });

  it("写入不能越界", async () => {
    const { root, outside } = fixture();
    await expect(writeFileAt(root, "../secret.txt", Buffer.from("pwned"))).rejects.toThrow(
      /escapes/,
    );
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(outside, "utf8")).toBe("TOP SECRET\n");
  });

  it("超大内容拒绝写入", async () => {
    const { root } = fixture();
    await expect(
      writeFileAt(root, "huge.txt", Buffer.alloc(MAX_EDIT_BYTES + 1)),
    ).rejects.toThrow(/too large/);
  });
});

describe("传输", () => {
  it("分块读能拼回原文件,并在末尾置 eof", async () => {
    const { root } = fixture();
    const payload = Buffer.alloc(5000, 0x7a);
    writeFileSync(path.join(root, "blob.bin"), payload);

    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const c = await readChunk(root, "blob.bin", offset, 1024);
      chunks.push(c.data);
      expect(c.total).toBe(payload.byteLength);
      offset += c.data.byteLength;
      if (c.eof) break;
    }
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it("offset 超出文件末尾返回空块并 eof,不报错", async () => {
    const { root } = fixture();
    const c = await readChunk(root, "README.md", 9999, 1024);
    expect(c.data.byteLength).toBe(0);
    expect(c.eof).toBe(true);
  });

  it("分块写能拼出完整文件,offset 0 会截断旧内容", async () => {
    const { root } = fixture();
    const a = Buffer.from("AAAA");
    const b = Buffer.from("BBBB");
    await writeChunk(root, "up.bin", 0, a);
    await writeChunk(root, "up.bin", a.byteLength, b);
    expect((await readForEdit(root, "up.bin")).content.toString()).toBe("AAAABBBB");

    // 再传一次(offset 0)应覆盖而不是追加
    await writeChunk(root, "up.bin", 0, Buffer.from("CC"));
    expect((await readForEdit(root, "up.bin")).content.toString()).toBe("CC");
  });

  it("上传不能越界", async () => {
    const { root } = fixture();
    await expect(writeChunk(root, "../evil.bin", 0, Buffer.from("x"))).rejects.toThrow(
      /escapes/,
    );
  });
});

describe("新建 / 删除 / 重命名", () => {
  it("新建目录后能列出来", async () => {
    const { root } = fixture();
    await makeDir(root, "src/newdir");
    const entries = await listDir(root, "src");
    expect(entries.some((e) => e.name === "newdir" && e.kind === "dir")).toBe(true);
  });

  it("目录已存在时拒绝,不静默覆盖", async () => {
    const { root } = fixture();
    await expect(makeDir(root, "src")).rejects.toThrow(/already exists/);
  });

  it("删除文件", async () => {
    const { root } = fixture();
    await removeEntry(root, "README.md");
    expect((await listDir(root, "")).some((e) => e.name === "README.md")).toBe(false);
  });

  it("非空目录不删 —— 手机上没有回收站也没有 undo", async () => {
    const { root } = fixture();
    await expect(removeEntry(root, "src")).rejects.toThrow(/非空/);
    // 里面的文件必须还在
    expect((await listDir(root, "src")).length).toBe(1);
  });

  it("拒绝删除会话根本身", async () => {
    const { root } = fixture();
    await expect(removeEntry(root, "")).rejects.toThrow(/refusing/);
  });

  it("删除不能越界", async () => {
    const { root, outside } = fixture();
    await expect(removeEntry(root, "../secret.txt")).rejects.toThrow(/escapes/);
    const { existsSync } = await import("node:fs");
    expect(existsSync(outside)).toBe(true);
  });

  it("重命名并移动到子目录", async () => {
    const { root } = fixture();
    await renameEntry(root, "README.md", "src/README.md");
    expect((await listDir(root, "src")).some((e) => e.name === "README.md")).toBe(true);
    expect((await listDir(root, "")).some((e) => e.name === "README.md")).toBe(false);
  });

  it("目标已存在时拒绝,不覆盖", async () => {
    const { root } = fixture();
    await expect(renameEntry(root, "README.md", "src/main.ts")).rejects.toThrow(/already exists/);
  });

  it("重命名的【目标】也要过根约束,否则能借它把文件挪出去", async () => {
    const { root } = fixture();
    await expect(renameEntry(root, "README.md", "../stolen.md")).rejects.toThrow(/escapes/);
  });
});
