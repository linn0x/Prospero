/**
 * E2E 加密通道(NaCl / tweetnacl),带前向保密。
 *
 * 信任模型:配对 QR 携带 daemon 静态 X25519 公钥 + token。
 *
 * 【为什么是三帧】v0 用「客户端临时密钥 × daemon 静态密钥」直接当会话密钥。
 * 那样只要 identity.json 泄漏,任何被录下的历史流量都能解密 —— 连 hello 里的
 * token 也一起暴露。静态密钥是长期存在磁盘上的,这个假设不该被依赖。
 *
 * 现在会话密钥由【双方临时密钥】的 DH 得出,静态密钥只用来【证明身份】:
 *
 *   1. C→S  {v, eph}                    客户端临时公钥(明文 —— 公钥本就是公开的)
 *   2. S→C  {seph, p}                   daemon 临时公钥 + 身份证明
 *                                       p = box(seph‖eph, 静态密钥 × eph)
 *                                       只有持有 daemon 静态私钥的才造得出;
 *                                       证明里绑了 eph,旧响应无法重放。
 *   3. C→S  {c}                         此后全部走会话密钥,首帧是 hello(含 token)
 *
 *   会话密钥 = DH(客户端临时私钥, daemon 临时公钥)
 *
 * 于是静态私钥泄漏后,攻击者能伪造【将来】的身份证明(所以仍要保管好),
 * 但推不出【过去】任一会话的密钥 —— 那需要某一侧的临时私钥,而它们用完即弃。
 * token 也因此不再暴露于历史流量。
 *
 * 数据帧:{"c":"<b64 密文>"},nonce 为隐式计数器(方向字节 + 8 字节 BE 计数),
 * TCP/WS 保序,无需传输 nonce;计数器错位/篡改 → open 失败即断连。
 * 顺带获得防重放:同一帧重放会因计数器前移而解密失败。
 */
import nacl from "tweetnacl";
import { fromB64, toB64 } from "./b64.js";
import { ProtocolError } from "./errors.js";
import {
  CRYPTO_VERSION,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./messages.js";
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

/**
 * 身份证明用的 nonce。它用的是「静态密钥 × 客户端临时密钥」派生的密钥,
 * 而客户端临时密钥每次连接都是新的,所以这把密钥只加密这一条消息,
 * 固定 nonce 不构成复用。
 */
const PROOF_NONCE = new Uint8Array(nacl.box.nonceLength).fill(0);

function proofPayload(serverEph: Uint8Array, clientEph: Uint8Array): Uint8Array {
  const out = new Uint8Array(serverEph.length + clientEph.length);
  out.set(serverEph, 0);
  out.set(clientEph, serverEph.length);
  return out;
}

/**
 * v8 起把协商出的应用版本和加密格式一并放进 daemon 身份证明。
 * 否则中间人可把首帧里的 v 改小，而客户端仍会接受一个只绑定临时公钥的证明。
 */
function negotiatedProofPayload(
  serverEph: Uint8Array,
  clientEph: Uint8Array,
  protocolVersion: number,
): Uint8Array {
  const prefix = new Uint8Array([
    0x50, 0x52, 0x53, 0x50, // "PRSP"
    CRYPTO_VERSION,
    protocolVersion,
  ]);
  const out = new Uint8Array(prefix.length + serverEph.length + clientEph.length);
  out.set(prefix, 0);
  out.set(serverEph, prefix.length);
  out.set(clientEph, prefix.length + serverEph.length);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

interface ClientHelloFrame {
  v: number;
  eph: string;
  /** v8+ 才发送；旧 daemon 会忽略未知字段。 */
  cv?: number;
  minV?: number;
  maxV?: number;
}

interface ServerProofFrame {
  seph: string;
  p: string;
  /** v8+ 的认证协商结果。 */
  v?: number;
  cv?: number;
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
    const boxed = nacl.box.after(utf8Encode(JSON.stringify(obj)), nonce, this.sharedKey);
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

// ---------------------------------------------------------------- 客户端

export interface ClientHandshakeState {
  ephPublic: Uint8Array;
  ephSecret: Uint8Array;
  protocolVersion: number;
}

export interface ClientHandshakeStart {
  /** 作为 WS 首帧原样发送 */
  frame: string;
  state: ClientHandshakeState;
}

/** 第 1 步:发出客户端临时公钥。传入旧版本用于连接兼容窗口内的旧 daemon。 */
export function clientHandshakeStart(protocolVersion = PROTOCOL_VERSION): ClientHandshakeStart {
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(protocolVersion)) {
    throw new ProtocolError(
      `unsupported client protocol version ${String(protocolVersion)}`,
      "version",
    );
  }
  const eph = nacl.box.keyPair();
  const frame: ClientHelloFrame = {
    v: protocolVersion,
    eph: toB64(eph.publicKey),
    ...(protocolVersion >= 8
      ? { cv: CRYPTO_VERSION, minV: MIN_PROTOCOL_VERSION, maxV: PROTOCOL_VERSION }
      : {}),
  };
  return {
    frame: JSON.stringify(frame),
    state: { ephPublic: eph.publicKey, ephSecret: eph.secretKey, protocolVersion },
  };
}

export interface ClientHandshakeFinish {
  /** 加密后的 hello,作为第 3 帧发送 */
  frame: string;
  channel: SecureChannel;
}

/**
 * 第 3 步:校验 daemon 身份证明,派生会话密钥,封装 hello。
 * 证明验不过就必须断连 —— 那意味着对面不持有配对时记下的静态私钥(中间人)。
 */
export function clientHandshakeFinish(
  state: ClientHandshakeState,
  serverFrameText: string,
  daemonPubKeyB64: string,
  hello: C2SHello,
): ClientHandshakeFinish {
  let frame: unknown;
  try {
    frame = JSON.parse(serverFrameText);
  } catch {
    throw new ProtocolError("server handshake frame is not JSON", "format");
  }
  const f = frame as Partial<ServerProofFrame> | null;
  if (typeof f?.seph !== "string" || typeof f?.p !== "string") {
    throw new ProtocolError("server handshake frame missing fields", "format");
  }
  const serverEph = fromB64(f.seph);
  if (serverEph.length !== nacl.box.publicKeyLength) {
    throw new ProtocolError("bad server ephemeral key length", "format");
  }

  if (
    state.protocolVersion >= 8 &&
    (f.v !== state.protocolVersion || f.cv !== CRYPTO_VERSION)
  ) {
    throw new ProtocolError("server did not authenticate negotiated version", "version");
  }

  // 用「daemon 静态公钥 × 自己的临时私钥」验证证明
  const proofKey = nacl.box.before(fromB64(daemonPubKeyB64), state.ephSecret);
  const opened = nacl.box.open.after(fromB64(f.p), PROOF_NONCE, proofKey);
  const expectedProof = state.protocolVersion >= 8
    ? negotiatedProofPayload(serverEph, state.ephPublic, state.protocolVersion)
    : proofPayload(serverEph, state.ephPublic);
  if (!opened || !equalBytes(opened, expectedProof)) {
    throw new ProtocolError(
      "daemon identity proof failed — wrong host, or man in the middle",
      "untrusted",
    );
  }

  const sessionKey = nacl.box.before(serverEph, state.ephSecret);
  const channel = new SecureChannel(sessionKey, DIR_C2S, 0, 0);
  return { frame: channel.seal(hello), channel };
}

// ---------------------------------------------------------------- 服务端

export interface ServerHandshakeState {
  sessionKey: Uint8Array;
  protocolVersion: number;
}

export interface ServerHandshakeRespond {
  /** 回给客户端的第 2 帧 */
  frame: string;
  state: ServerHandshakeState;
}

/** 第 2 步:校验版本,生成自己的临时密钥,回临时公钥 + 身份证明。 */
export function serverHandshakeRespond(
  clientFrameText: string,
  daemonSecretKeyB64: string,
): ServerHandshakeRespond {
  let frame: unknown;
  try {
    frame = JSON.parse(clientFrameText);
  } catch {
    throw new ProtocolError("handshake frame is not JSON", "format");
  }
  const f = frame as Partial<ClientHelloFrame> | null;
  if (typeof f?.eph !== "string" || typeof f?.v !== "number") {
    throw new ProtocolError("handshake frame missing fields", "format");
  }
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(f.v)) {
    throw new ProtocolError(
      `protocol version mismatch: peer=${String(f.v)} supported=${SUPPORTED_PROTOCOL_VERSIONS.join(",")}`,
      "version",
    );
  }
  if (
    f.v >= 8 &&
    (f.cv !== CRYPTO_VERSION ||
      typeof f.minV !== "number" ||
      typeof f.maxV !== "number" ||
      f.minV > f.v ||
      f.maxV < f.v)
  ) {
    throw new ProtocolError("invalid authenticated version negotiation", "version");
  }
  const clientEph = fromB64(f.eph);
  if (clientEph.length !== nacl.box.publicKeyLength) {
    throw new ProtocolError("bad ephemeral key length", "format");
  }

  const serverEph = nacl.box.keyPair();
  // 证明绑定了客户端临时公钥,旧连接的响应因此无法被重放到新连接上
  const proofKey = nacl.box.before(clientEph, fromB64(daemonSecretKeyB64));
  const proof = nacl.box.after(
    f.v >= 8
      ? negotiatedProofPayload(serverEph.publicKey, clientEph, f.v)
      : proofPayload(serverEph.publicKey, clientEph),
    PROOF_NONCE,
    proofKey,
  );

  const sessionKey = nacl.box.before(clientEph, serverEph.secretKey);
  const out: ServerProofFrame = {
    seph: toB64(serverEph.publicKey),
    p: toB64(proof),
    ...(f.v >= 8 ? { v: f.v, cv: CRYPTO_VERSION } : {}),
  };
  return {
    frame: JSON.stringify(out),
    state: { sessionKey, protocolVersion: f.v },
  };
}

export interface ServerHandshakeResult {
  hello: C2SHello;
  channel: SecureChannel;
  protocolVersion: number;
}

/** 第 4 步:用会话密钥解开 hello 并校验结构。token 的比对在 pairing 层。 */
export function serverHandshakeAccept(
  state: ServerHandshakeState,
  helloFrameText: string,
): ServerHandshakeResult {
  const channel = new SecureChannel(state.sessionKey, DIR_S2C, 0, 0);
  let helloRaw: unknown;
  try {
    helloRaw = channel.open(helloFrameText);
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw new ProtocolError("hello frame could not be opened", "crypto");
  }
  const parsed = C2SHelloSchema.safeParse(helloRaw);
  if (!parsed.success) {
    throw new ProtocolError("hello payload failed validation", "format");
  }
  return { hello: parsed.data, channel, protocolVersion: state.protocolVersion };
}
