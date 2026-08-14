import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  SecureChannel,
  clientHandshakeFinish,
  clientHandshakeStart,
  fromB64,
  generateKeyPairB64,
  serverHandshakeAccept,
  serverHandshakeRespond,
  SUPPORTED_PROTOCOL_VERSIONS,
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

/** 跑完三帧握手,返回两端通道与沿途的帧(测试要检查线上内容)。 */
function handshake(daemon = generateKeyPairB64(), hello = makeHello()) {
  const start = clientHandshakeStart();
  const responded = serverHandshakeRespond(start.frame, daemon.secretKey);
  const finished = clientHandshakeFinish(start.state, responded.frame, daemon.publicKey, hello);
  const accepted = serverHandshakeAccept(responded.state, finished.frame);
  return {
    daemon,
    hello,
    client: finished.channel,
    server: accepted.channel,
    accepted,
    start,
    responded,
  };
}

describe("handshake + SecureChannel", () => {
  it("完成握手并双向收发", () => {
    const { hello, accepted, client, server } = handshake();
    expect(accepted.hello).toEqual(hello);

    // S→C 与 C→S 各连发多条,顺序解密
    for (let i = 0; i < 5; i++) {
      const s2c = { type: "session.state", i };
      expect(client.open(server.seal(s2c))).toEqual(s2c);
      const c2s = { type: "term.input", sid: "s1", dataB64: "aGk=", i };
      expect(server.open(client.seal(c2s))).toEqual(c2s);
    }
  });

  it("v13 connection.ping/pong 作为 SecureChannel 加密应用帧往返", () => {
    const { client, server } = handshake();
    const ping = { type: "connection.ping", id: "ping-123" };
    expect(server.open(client.seal(ping))).toEqual(ping);
    const pong = { type: "connection.pong", id: ping.id };
    expect(client.open(server.seal(pong))).toEqual(pong);
  });

  it("拒绝重放(计数器前移后同帧解密失败)", () => {
    const { client, server } = handshake();
    const f = client.seal({ a: 1 });
    expect(server.open(f)).toEqual({ a: 1 });
    expect(() => server.open(f)).toThrowError(ProtocolError);
  });

  it("拒绝篡改的密文", () => {
    const { client, server } = handshake();
    const parsed = JSON.parse(client.seal({ secret: true })) as { c: string };
    const i = 3;
    const flipped =
      parsed.c.slice(0, i) + (parsed.c[i] === "A" ? "B" : "A") + parsed.c.slice(i + 1);
    expect(() => server.open(JSON.stringify({ c: flipped }))).toThrowError(/decrypt failed/);
  });

  it("冒充 daemon 的中间人过不了身份证明", () => {
    const real = generateKeyPairB64();
    const impostor = generateKeyPairB64();
    const start = clientHandshakeStart();
    // 攻击者用自己的密钥回应,客户端却是拿 real 的公钥去验
    const responded = serverHandshakeRespond(start.frame, impostor.secretKey);
    expect(() =>
      clientHandshakeFinish(start.state, responded.frame, real.publicKey, makeHello()),
    ).toThrowError(/identity proof failed/);
  });

  it("身份证明绑定本次客户端临时公钥,旧响应无法重放到新连接", () => {
    const daemon = generateKeyPairB64();
    const first = clientHandshakeStart();
    const respondedToFirst = serverHandshakeRespond(first.frame, daemon.secretKey);

    const second = clientHandshakeStart();
    expect(() =>
      clientHandshakeFinish(second.state, respondedToFirst.frame, daemon.publicKey, makeHello()),
    ).toThrowError(/identity proof failed/);
  });

  it("hello 不再出现在静态密钥保护的帧里 —— token 不随静态密钥泄漏而暴露", () => {
    const { start, responded } = handshake();
    // 前两帧线上只有临时公钥和证明,没有任何密文承载 hello
    const f1 = JSON.parse(start.frame) as Record<string, unknown>;
    expect(Object.keys(f1).sort()).toEqual(["cv", "eph", "maxV", "minV", "v"]);
    const f2 = JSON.parse(responded.frame) as Record<string, unknown>;
    expect(Object.keys(f2).sort()).toEqual(["cv", "p", "seph", "v"]);
  });

  it("前向保密:静态私钥泄漏也解不开已录下的历史会话", () => {
    const daemon = generateKeyPairB64();
    const { client, start, responded } = handshake(daemon);
    const recorded = client.seal({ 机密: "历史流量" });

    // 攻击者事后拿到 identity.json,且录下了全部握手帧
    const clientEph = fromB64((JSON.parse(start.frame) as { eph: string }).eph);
    const serverEph = fromB64((JSON.parse(responded.frame) as { seph: string }).seph);

    // 静态密钥能重算出「证明密钥」—— 在 v0 里这就是会话密钥,历史流量当场沦陷
    const proofKey = nacl.box.before(clientEph, fromB64(daemon.secretKey));
    expect(() => new SecureChannel(proofKey, 2, 0, 0).open(recorded)).toThrowError(
      /decrypt failed/,
    );

    // 静态密钥与服务端临时公钥的组合同样无用:会话密钥要某一侧的临时【私钥】,
    // 而两侧用完即弃,磁盘上没有留下
    const staticToServerEph = nacl.box.before(serverEph, fromB64(daemon.secretKey));
    expect(() => new SecureChannel(staticToServerEph, 2, 0, 0).open(recorded)).toThrowError(
      /decrypt failed/,
    );
  });

  it("拒绝版本不匹配的握手,不降级", () => {
    const daemon = generateKeyPairB64();
    const { frame } = clientHandshakeStart();
    const f = JSON.parse(frame) as { v: number };
    f.v = 0; // v0 旧客户端
    try {
      serverHandshakeRespond(JSON.stringify(f), daemon.secretKey);
      expect.unreachable();
    } catch (e) {
      expect((e as ProtocolError).code).toBe("version");
    }
  });

  it("daemon 与 v12/v11/.../v5 回退版本协商，并为 v8+ 认证协商结果", () => {
    const daemon = generateKeyPairB64();
    for (const version of [12, 11, 10, 9, 8, 7, 5]) {
      const start = clientHandshakeStart(version);
      const responded = serverHandshakeRespond(start.frame, daemon.secretKey);
      expect(responded.state.protocolVersion).toBe(version);
      const finished = clientHandshakeFinish(
        start.state,
        responded.frame,
        daemon.publicKey,
        makeHello(),
      );
      expect(serverHandshakeAccept(responded.state, finished.frame).hello.type).toBe("hello");
    }
  });

  it("v8+ 身份证明认证协商版本，篡改响应版本会被拒绝", () => {
    const daemon = generateKeyPairB64();
    const start = clientHandshakeStart();
    const responded = serverHandshakeRespond(start.frame, daemon.secretKey);
    const frame = JSON.parse(responded.frame) as { v: number };
    frame.v = 7;
    expect(() =>
      clientHandshakeFinish(start.state, JSON.stringify(frame), daemon.publicKey, makeHello()),
    ).toThrowError(/negotiated version/);
  });

  it("客户端只允许显式维护的回退版本", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([13, 12, 11, 10, 9, 8, 7, 5]);
    expect(() => clientHandshakeStart(6)).toThrowError(/unsupported client protocol/);
  });

  it("用错 daemon 私钥时客户端验不过证明", () => {
    const daemon = generateKeyPairB64();
    const other = generateKeyPairB64();
    const start = clientHandshakeStart();
    const responded = serverHandshakeRespond(start.frame, other.secretKey);
    try {
      clientHandshakeFinish(start.state, responded.frame, daemon.publicKey, makeHello());
      expect.unreachable();
    } catch (e) {
      expect((e as ProtocolError).code).toBe("untrusted");
    }
  });

  it("拒绝垃圾输入", () => {
    const daemon = generateKeyPairB64();
    expect(() => serverHandshakeRespond("not json", daemon.secretKey)).toThrowError(
      ProtocolError,
    );
    expect(() => serverHandshakeRespond('{"x":1}', daemon.secretKey)).toThrowError(
      ProtocolError,
    );
  });
});
