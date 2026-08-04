export type ProtocolErrorCode = "format" | "crypto" | "version" | "untrusted";

/**
 * 协议层错误。
 * - format:格式非法
 * - crypto:解密失败(篡改或计数器错位)
 * - version:版本不兼容
 * - untrusted:对面证明不了自己是配对时那台 daemon(密钥换了,或有中间人)
 */
export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: ProtocolErrorCode,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
