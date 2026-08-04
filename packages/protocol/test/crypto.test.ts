import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  clientHandshake,
  generateKeyPairB64,
  serverAcceptHandshake,
  type C2SHello,
} from "../src/index.js";

function makeHello(): C2SHello {
  return {
    type: "hello",
    token: "0123456789abcdef",
    clientPubKey: generateKeyPairB64().publicKey,
    clientInfo: { platform: "ios", appVersion: "0.0.1" },
  };
}

describe("handshake + SecureChannel", () => {
  it("完成握手并双向收发", () => {
    const daemon = generateKeyPairB64();
    const hello = makeHello();
    const { frame, channel: client } = clientHandshake(daemon.publicKey, hello);
    const { hello: got, channel: server } = serverAcceptHandshake(
      frame,
      daemon.secretKey,
    );
    expect(got).toEqual(hello);

    // S→C 与 C→S 各连发多条,顺序解密
    for (let i = 0; i < 5; i++) {
      const s2c = { type: "session.state", i };
      expect(client.open(server.seal(s2c))).toEqual(s2c);
      const c2s = { type: "term.input", sid: "s1", dataB64: "aGk=", i };
      expect(server.open(client.seal(c2s))).toEqual(c2s);
    }
  });

  it("拒绝重放(计数器前移后同帧解密失败)", () => {
    const daemon = generateKeyPairB64();
    const { frame, channel: client } = clientHandshake(daemon.publicKey, makeHello());
    const { channel: server } = serverAcceptHandshake(frame, daemon.secretKey);
    const f = client.seal({ a: 1 });
    expect(server.open(f)).toEqual({ a: 1 });
    expect(() => server.open(f)).toThrowError(ProtocolError);
  });

  it("拒绝篡改的密文", () => {
    const daemon = generateKeyPairB64();
    const { frame, channel: client } = clientHandshake(daemon.publicKey, makeHello());
    const { channel: server } = serverAcceptHandshake(frame, daemon.secretKey);
    const parsed = JSON.parse(client.seal({ secret: true })) as { c: string };
    const i = 3;
    const flipped =
      parsed.c.slice(0, i) + (parsed.c[i] === "A" ? "B" : "A") + parsed.c.slice(i + 1);
    expect(() => server.open(JSON.stringify({ c: flipped }))).toThrowError(
      /decrypt failed/,
    );
  });

  it("拒绝版本不匹配的握手", () => {
    const daemon = generateKeyPairB64();
    const { frame } = clientHandshake(daemon.publicKey, makeHello());
    const f = JSON.parse(frame) as { v: number };
    f.v = 99;
    try {
      serverAcceptHandshake(JSON.stringify(f), daemon.secretKey);
      expect.unreachable();
    } catch (e) {
      expect((e as ProtocolError).code).toBe("version");
    }
  });

  it("拒绝错误的 daemon 私钥(密钥不匹配)", () => {
    const daemon = generateKeyPairB64();
    const other = generateKeyPairB64();
    const { frame } = clientHandshake(daemon.publicKey, makeHello());
    try {
      serverAcceptHandshake(frame, other.secretKey);
      expect.unreachable();
    } catch (e) {
      expect((e as ProtocolError).code).toBe("crypto");
    }
  });

  it("拒绝垃圾输入", () => {
    const daemon = generateKeyPairB64();
    expect(() => serverAcceptHandshake("not json", daemon.secretKey)).toThrowError(
      ProtocolError,
    );
    expect(() => serverAcceptHandshake('{"x":1}', daemon.secretKey)).toThrowError(
      ProtocolError,
    );
  });
});
