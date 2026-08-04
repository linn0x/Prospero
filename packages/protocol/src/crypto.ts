/**
 * E2E 加密通道(NaCl / tweetnacl)。
 *
 * 信任模型:配对 QR 携带 daemon 静态 X25519 公钥 + token。
 * 每次连接客户端生成【临时】密钥对 → 与 daemon 静态公钥做 DH 得到本连接共享密钥,
 * 因此计数器 nonce 不会跨连接复用(临时密钥保证共享密钥每连接新鲜)。
 *
 * 帧格式(WebSocket 文本帧):
 * - 首帧 C→S(握手):{"v":0,"eph":"<b64 临时公钥>","c":"<b64 密文>"}
 *   密文 = box(hello JSON, nonce(C→S, 0), daemonPub, ephSecret)
 * - 之后双向:{"c":"<b64 密文>"},nonce 为隐式计数器(方向字节 + 8 字节 BE 计数),
 *   TCP/WS 保序,无需传输 nonce;计数器错位/篡改 → open 失败即断连。
 *   顺带获得防重放:同一帧重放会因计数器前移而解密失败。
 */
import nacl from "tweetnacl";
import { fromB64, toB64 } from "./b64.js";
import { ProtocolError } from "./errors.js";
import { PROTOCOL_VERSION } from "./messages.js";
import { utf8Decode, utf8Encode } from "./utf8.js";
import { C2SHelloSchema, type C2SHello } from "./schemas.js";

export interface KeyPairB64 {
  publicKey: string;
  secretKey: string;
}

/** 生成 X25519 密钥对(daemon 静态身份 / 客户端设备身份共用) */
export function generateKeyPairB64(): KeyPairB64 {
  const kp = nacl.box.keyPair();
  return { publicKey: toB64(kp.publicKey), secretKey: toB64(kp.secretKey) };
}

const DIR_C2S = 1 as const;
const DIR_S2C = 2 as const;
type Dir = typeof DIR_C2S | typeof DIR_S2C;

function nonceFor(dir: Dir, counter: number): Uint8Array {
  const n = new Uint8Array(nacl.box.nonceLength); // 24
  n[0] = dir;
  let c = counter;
  for (let i = 8; i >= 1; i--) {
    n[i] = c % 256;
    c = Math.floor(c / 256);
  }
  return n;
}

interface HandshakeFrame {
  v: number;
  eph: string;
  c: string;
}

interface DataFrame {
  c: string;
}

export class SecureChannel {
  private sendCount: number;
  private recvCount: number;

  constructor(
    private readonly sharedKey: Uint8Array,
    private readonly sendDir: Dir,
    sendStart = 0,
    recvStart = 0,
  ) {
    this.sendCount = sendStart;
    this.recvCount = recvStart;
  }

  seal(obj: unknown): string {
    const nonce = nonceFor(this.sendDir, this.sendCount++);
    const boxed = nacl.box.after(
      utf8Encode(JSON.stringify(obj)),
      nonce,
      this.sharedKey,
    );
    const frame: DataFrame = { c: toB64(boxed) };
    return JSON.stringify(frame);
  }

  open(text: string): unknown {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      throw new ProtocolError("frame is not JSON", "format");
    }
    const c = (frame as DataFrame | null)?.c;
    if (typeof c !== "string") {
      throw new ProtocolError("frame missing ciphertext", "format");
    }
    const recvDir: Dir = this.sendDir === DIR_C2S ? DIR_S2C : DIR_C2S;
    const opened = nacl.box.open.after(
      fromB64(c),
      nonceFor(recvDir, this.recvCount),
      this.sharedKey,
    );
    if (!opened) {
      throw new ProtocolError(
        "decrypt failed (tampered, replayed, or counter out of sync)",
        "crypto",
      );
    }
    this.recvCount++;
    return JSON.parse(utf8Decode(opened));
  }
}

export interface ClientHandshakeResult {
  /** 作为 WS 首帧原样发送 */
  frame: string;
  channel: SecureChannel;
}

/** 客户端:生成临时密钥对并封装加密的 hello 首帧 */
export function clientHandshake(
  daemonPubKeyB64: string,
  hello: C2SHello,
): ClientHandshakeResult {
  const eph = nacl.box.keyPair();
  const shared = nacl.box.before(fromB64(daemonPubKeyB64), eph.secretKey);
  const boxed = nacl.box.after(
    utf8Encode(JSON.stringify(hello)),
    nonceFor(DIR_C2S, 0),
    shared,
  );
  const frame: HandshakeFrame = {
    v: PROTOCOL_VERSION,
    eph: toB64(eph.publicKey),
    c: toB64(boxed),
  };
  // hello 用掉了 C→S 计数 0,后续从 1 起
  return {
    frame: JSON.stringify(frame),
    channel: new SecureChannel(shared, DIR_C2S, 1, 0),
  };
}

export interface ServerHandshakeResult {
  hello: C2SHello;
  channel: SecureChannel;
}

/** daemon:接受首帧,校验版本与 hello 结构,建立通道 */
export function serverAcceptHandshake(
  frameText: string,
  daemonSecretKeyB64: string,
): ServerHandshakeResult {
  let frame: unknown;
  try {
    frame = JSON.parse(frameText);
  } catch {
    throw new ProtocolError("handshake frame is not JSON", "format");
  }
  const f = frame as Partial<HandshakeFrame> | null;
  if (typeof f?.eph !== "string" || typeof f?.c !== "string") {
    throw new ProtocolError("handshake frame missing fields", "format");
  }
  if (f.v !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `protocol version mismatch: peer=${String(f.v)} local=${PROTOCOL_VERSION}`,
      "version",
    );
  }
  const eph = fromB64(f.eph);
  if (eph.length !== nacl.box.publicKeyLength) {
    throw new ProtocolError("bad ephemeral key length", "format");
  }
  const shared = nacl.box.before(eph, fromB64(daemonSecretKeyB64));
  const opened = nacl.box.open.after(
    fromB64(f.c),
    nonceFor(DIR_C2S, 0),
    shared,
  );
  if (!opened) {
    throw new ProtocolError("handshake decrypt failed", "crypto");
  }
  let helloRaw: unknown;
  try {
    helloRaw = JSON.parse(utf8Decode(opened));
  } catch {
    throw new ProtocolError("hello payload is not JSON", "format");
  }
  const parsed = C2SHelloSchema.safeParse(helloRaw);
  if (!parsed.success) {
    throw new ProtocolError("hello payload failed validation", "format");
  }
  return {
    hello: parsed.data,
    channel: new SecureChannel(shared, DIR_S2C, 0, 1),
  };
}
