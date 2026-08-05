interface FileNameValidationOptions {
  originalName?: string;
  existingNames?: readonly string[];
}

/** 文件协议使用相对 POSIX 路径，所以这里只禁止会改变路径层级的名字。 */
export function validateFileName(
  raw: string,
  options: FileNameValidationOptions = {},
): string | null {
  const name = raw.trim();
  if (name.length === 0) return "名字不能为空";
  if (name === "." || name === "..") return "不能使用 . 或 .. 作为名字";
  if (name.includes("/")) return "名字不能含 /，这里只能在当前目录操作";
  if (name.includes("\0")) return "名字不能含空字符";
  if (options.originalName !== undefined && name === options.originalName) {
    return "新名字与原名字相同";
  }
  if (options.existingNames?.some((existing) => existing === name) === true) {
    return `「${name}」已经存在`;
  }
  return null;
}
