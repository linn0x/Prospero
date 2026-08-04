import { describe, expect, it } from "vitest";
import {
  PairingPayloadSchema,
  ProtocolError,
  generateKeyPairB64,
  parseC2S,
  parseS2C,
} from "../src/index.js";

describe("message schemas", () => {
  it("接受合法 C2S", () => {
    expect(
      parseC2S({ type: "session.create", agent: "shell", cols: 80, rows: 24 }),
    ).toMatchObject({ agent: "shell" });
    expect(
      parseC2S({ type: "session.attach", sid: "abc", lastSeq: 42 }),
    ).toMatchObject({ lastSeq: 42 });
  });

  it("拒绝未知类型与缺字段", () => {
    expect(() => parseC2S({ type: "hack.the.planet" })).toThrowError(ProtocolError);
    expect(() => parseC2S({ type: "term.input", sid: "s" })).toThrowError(
      ProtocolError,
    ); // 缺 dataB64
    expect(() => parseC2S({ type: "term.input", sid: "s", dataB64: "" })).toThrowError(
      ProtocolError,
    );
  });

  it("接受合法 S2C 并拒绝坏值", () => {
    expect(
      parseS2C({
        type: "hello.ok",
        host: { name: "mac", daemonVersion: "0.0.1", protocolVersion: 0 },
        sessions: [],
      }),
    ).toMatchObject({ type: "hello.ok" });
    expect(() =>
      parseS2C({ type: "term.output", sid: "s", dataB64: "aGk=", seq: -1 }),
    ).toThrowError(ProtocolError);
  });

  it("PairingPayload 校验端口与公钥长度", () => {
    const good = {
      v: 0,
      name: "mac",
      addrs: ["1.2.3.4"],
      port: 7423,
      token: "0123456789abcdef",
      pubKey: generateKeyPairB64().publicKey,
    };
    expect(PairingPayloadSchema.safeParse(good).success).toBe(true);
    expect(PairingPayloadSchema.safeParse({ ...good, port: 70000 }).success).toBe(
      false,
    );
    expect(PairingPayloadSchema.safeParse({ ...good, pubKey: "aGk=" }).success).toBe(
      false,
    );
    expect(PairingPayloadSchema.safeParse({ ...good, addrs: [] }).success).toBe(
      false,
    );
  });
});
