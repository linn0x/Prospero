export type ProtocolErrorCode = "format" | "crypto" | "version";

/** 协议层错误:格式非法 / 解密失败(篡改或计数器错位)/ 版本不兼容 */
export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: ProtocolErrorCode,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
