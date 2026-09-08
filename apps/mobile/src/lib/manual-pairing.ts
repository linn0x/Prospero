import { decodePairingQR, type PairingPayload } from "@prospero/protocol";

export class PairingAddressError extends Error {
  constructor() {
    super("请输入有效的 IP 地址；可附加 1–65535 的端口，例如 192.168.1.20:7423 或 [2001:db8::1]:7423。");
    this.name = "PairingAddressError";
  }
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIPv6(value: string): boolean {
  let address = value;
  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    if (separator < 0 || !isIPv4(address.slice(separator + 1))) return false;
    address = `${address.slice(0, separator + 1)}0:0`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => half ? half.split(":") : []);
  if (!groups.every((part) => /^[a-f\d]{1,4}$/i.test(part))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

/** Bracket IPv6 for the connection layer's ws://<addr>:<port>/ws URL. */
export function parsePairingAddress(input: string): { addr: string; port?: number } | null {
  const value = input.trim();
  if (!value) return null;
  let addr: string;
  let portText: string | undefined;
  if (value.startsWith("[")) {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (!bracketed || !isIPv6(bracketed[1]!)) throw new PairingAddressError();
    addr = `[${bracketed[1]!.toLowerCase()}]`;
    portText = bracketed[2];
  } else if ((value.match(/:/g)?.length ?? 0) > 1) {
    if (!isIPv6(value)) throw new PairingAddressError();
    addr = `[${value.toLowerCase()}]`;
  } else {
    const parts = value.split(":");
    if (!isIPv4(parts[0]!)) throw new PairingAddressError();
    addr = parts[0]!;
    portText = parts[1];
  }
  const port = portText === undefined ? undefined : Number(portText);
  if (portText !== undefined && (!/^\d+$/.test(portText) || !Number.isInteger(port) || port! < 1 || port! > 65535)) {
    throw new PairingAddressError();
  }
  return { addr, ...(port === undefined ? {} : { port }) };
}

/** An address override never replaces the QR-provided daemon identity or credentials. */
export function decodeManualPairing(
  code: string,
  address: string,
  allowInsecureLoopback = false,
): PairingPayload {
  const payload = decodePairingQR(code.trim(), { allowInsecureLoopback });
  const endpoint = parsePairingAddress(address);
  if (!endpoint) return payload;
  return { ...payload, addrs: [endpoint.addr], port: endpoint.port ?? payload.port };
}
