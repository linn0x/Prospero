/**
 * 会话文件操作:浏览 / 编辑 / 传输。
 *
 * 【根约束】所有路径都相对于会话 cwd,解析后必须仍落在该根之下。
 * 光靠字符串检查 ".." 不够 —— 符号链接可以指到根外,所以用 realpath 解析后再比对。
 * 客户端发来的路径一律视为不可信输入。
 *
 * 【为什么不给整个文件系统】那等于把 shell 权限换个界面再发一次,
 * 而 shell 会话是按设备 allowShell 单独授权的。文件面板的用途是"看 agent
 * 在这个项目里干了什么",根就该是那个项目。
 */
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { FsEntry } from "@prospero/protocol";

/** 可编辑文本的上限。超过就只读 —— 手机上编辑几 MB 的文件没有意义,还会撑爆内存 */
export const MAX_EDIT_BYTES = 1024 * 1024;
/** 单次传输块上限,与协议 schema 保持一致 */
export const MAX_CHUNK_BYTES = 1024 * 1024;
/** 目录条目上限,防止 node_modules 这种目录把消息撑爆 */
export const MAX_ENTRIES = 2000;

export class FsError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "denied" | "too_large" | "not_a_file" | "io",
  ) {
    super(message);
    this.name = "FsError";
  }
}

/**
 * 把客户端给的相对路径解析成绝对路径,并确保它在根之下。
 *
 * 对已存在的路径用 realpath(解开符号链接);不存在时(新建文件/上传)
 * 解析其父目录 —— 父目录必须存在且在根内,这样既允许创建,又不给出逃逸口。
 */
export async function resolveWithin(root: string, rel: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => {
    throw new FsError(`session root is gone: ${root}`, "not_found");
  });

  const candidate = path.resolve(realRoot, rel);
  // 盘符根(如 realpath("D:\\") → "D:\\")本身以分隔符结尾，若再拼一个 path.sep
  // 会得到双分隔符，导致其下所有子目录都判为“逃逸”。先归一化再比较。
  const contains = (base: string, target: string): boolean => {
    if (target === base) return true;
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return target.startsWith(prefix);
  };

  try {
    const real = await realpath(candidate);
    if (!contains(realRoot, real)) {
      throw new FsError("path escapes the session directory", "denied");
    }
    return real;
  } catch (e) {
    if (e instanceof FsError) throw e;
    // 不存在:允许在已存在且合法的父目录下新建
    const parent = path.dirname(candidate);
    const realParent = await realpath(parent).catch(() => {
      throw new FsError("parent directory does not exist", "not_found");
    });
    if (!contains(realRoot, realParent)) {
      throw new FsError("path escapes the session directory", "denied");
    }
    return path.join(realParent, path.basename(candidate));
  }
}

export async function listDir(root: string, rel: string): Promise<FsEntry[]> {
  const dir = await resolveWithin(root, rel);
  const st = await stat(dir).catch(() => {
    throw new FsError("directory not found", "not_found");
  });
  if (!st.isDirectory()) throw new FsError("not a directory", "not_a_file");

  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => {
    throw new FsError("cannot read directory", "denied");
  });

  const entries: FsEntry[] = [];
  for (const d of dirents.slice(0, MAX_ENTRIES)) {
    // 不跟随符号链接取 size/mtime —— 跟随会打到根外,且可能是死链
    const full = path.join(dir, d.name);
    const info = await stat(full).catch(() => null);
    entries.push({
      name: d.name,
      kind: d.isDirectory()
        ? "dir"
        : d.isSymbolicLink()
          ? "symlink"
          : d.isFile()
            ? "file"
            : "other",
      size: info?.isFile() === true ? info.size : 0,
      mtime: info ? Math.floor(info.mtimeMs) : 0,
    });
  }
  // 目录在前,再按名字排 —— 和 Finder / ls 的直觉一致
  entries.sort((a, b) => {
    if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export interface ReadResult {
  content: Buffer;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export async function readForEdit(root: string, rel: string): Promise<ReadResult> {
  const file = await resolveWithin(root, rel);
  const st = await stat(file).catch(() => {
    throw new FsError("file not found", "not_found");
  });
  if (!st.isFile()) throw new FsError("not a file", "not_a_file");

  const truncated = st.size > MAX_EDIT_BYTES;
  const handle = await open(file, "r");
  try {
    const length = Math.min(st.size, MAX_EDIT_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    // NUL 字节是判定二进制最省事也最可靠的启发式(和 git 的判断一致)
    const binary = buf.includes(0);
    return { content: buf, size: st.size, truncated, binary };
  } finally {
    await handle.close();
  }
}

export async function writeFileAt(root: string, rel: string, content: Buffer): Promise<number> {
  if (content.byteLength > MAX_EDIT_BYTES) {
    throw new FsError("content too large", "too_large");
  }
  const file = await resolveWithin(root, rel);
  const st = await stat(file).catch(() => null);
  if (st && !st.isFile()) throw new FsError("not a file", "not_a_file");
  await writeFile(file, content).catch(() => {
    throw new FsError("cannot write file", "denied");
  });
  return content.byteLength;
}

export interface ChunkResult {
  data: Buffer;
  total: number;
  eof: boolean;
}

/** 下载用的分块读。offset 超过文件末尾时返回空块并置 eof。 */
export async function readChunk(
  root: string,
  rel: string,
  offset: number,
  length: number,
): Promise<ChunkResult> {
  const file = await resolveWithin(root, rel);
  const st = await stat(file).catch(() => {
    throw new FsError("file not found", "not_found");
  });
  if (!st.isFile()) throw new FsError("not a file", "not_a_file");

  if (offset >= st.size) {
    return { data: Buffer.alloc(0), total: st.size, eof: true };
  }
  const want = Math.min(length, MAX_CHUNK_BYTES, st.size - offset);
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, offset);
    const data = buf.subarray(0, bytesRead);
    return { data, total: st.size, eof: offset + bytesRead >= st.size };
  } finally {
    await handle.close();
  }
}

/**
 * 上传用的分块写。offset 为 0 时截断重建,之后按位置续写。
 * 不做断点续传的状态跟踪 —— 客户端顺序发,乱序会写出错误内容,
 * 这是刻意的简化(手机上传的都是小文件)。
 */
export async function writeChunk(
  root: string,
  rel: string,
  offset: number,
  data: Buffer,
): Promise<number> {
  const file = await resolveWithin(root, rel);
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {
    throw new FsError("cannot create parent directory", "denied");
  });
  const handle = await open(file, offset === 0 ? "w" : "r+").catch(() => {
    throw new FsError("cannot open file for writing", "denied");
  });
  try {
    await handle.write(data, 0, data.byteLength, offset);
    const st = await handle.stat();
    return st.size;
  } finally {
    await handle.close();
  }
}

/** 根是否可读 —— 会话 cwd 可能已被删除 */
export async function rootUsable(root: string): Promise<boolean> {
  return access(root, constants.R_OK)
    .then(() => true)
    .catch(() => false);
}

export async function makeDir(root: string, rel: string): Promise<void> {
  const dir = await resolveWithin(root, rel);
  if (await stat(dir).then(() => true).catch(() => false)) {
    throw new FsError("already exists", "denied");
  }
  await mkdir(dir).catch(() => {
    throw new FsError("cannot create directory", "denied");
  });
}

/**
 * 删除文件或【空】目录。
 * 不做递归删除:手机上一次误触就能抹掉整棵目录树,而这个面板既没有回收站
 * 也没有 undo。要删整个目录,让用户回 Mac 上做。
 */
export async function removeEntry(root: string, rel: string): Promise<void> {
  if (rel === "") throw new FsError("refusing to remove the session root", "denied");
  const target = await resolveWithin(root, rel);
  const st = await stat(target).catch(() => {
    throw new FsError("not found", "not_found");
  });
  if (st.isDirectory()) {
    const left = await readdir(target).catch(() => {
      throw new FsError("cannot read directory", "denied");
    });
    if (left.length > 0) {
      throw new FsError("目录非空 —— 请先清空,或在电脑上删除", "denied");
    }
    await rmdir(target).catch(() => {
      throw new FsError("cannot remove directory", "denied");
    });
    return;
  }
  await unlink(target).catch(() => {
    throw new FsError("cannot remove file", "denied");
  });
}

/** 重命名 / 移动。两端都过根约束,否则可以借重命名把文件挪到根外。 */
export async function renameEntry(root: string, rel: string, to: string): Promise<void> {
  if (rel === "" || to === "") throw new FsError("path required", "denied");
  const from = await resolveWithin(root, rel);
  const dest = await resolveWithin(root, to);
  await stat(from).catch(() => {
    throw new FsError("not found", "not_found");
  });
  if (await stat(dest).then(() => true).catch(() => false)) {
    throw new FsError("destination already exists", "denied");
  }
  await rename(from, dest).catch(() => {
    throw new FsError("cannot rename", "denied");
  });
}
