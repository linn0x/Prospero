import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { AccountBinding } from "./agent-accounts.js";

export function externalResponses(binding: AccountBinding): boolean {
  return binding.apiProfile?.protocol === "openai_responses" && new URL(binding.apiProfile.baseUrl).hostname !== "api.openai.com";
}

export async function forwardModelApi(req: IncomingMessage, res: ServerResponse, resolve: (id: string) => AccountBinding, fetcher: typeof fetch = fetch): Promise<void> {
  const abort = new AbortController();
  const timeout = setTimeout(() => { abort.abort(); req.destroy(); res.destroy(); }, 600_000);
  const cancel = () => { if (!res.writableEnded) abort.abort(); };
  res.on("close", cancel);
  try {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) { res.writeHead(403).end(); return; }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/_prospero\/model-api\/([A-Za-z0-9-]{1,100})\/(responses(?:\/compact)?|models)$/);
    if (!match || (match[2] === "models" ? req.method !== "GET" : req.method !== "POST")) { res.writeHead(404).end(); return; }
    let binding: AccountBinding;
    try { binding = resolve(match[1]!); } catch { res.writeHead(401).end(); return; }
    const key = binding.environment.OPENAI_API_KEY;
    const expected = Buffer.from(`Bearer ${key ?? ""}`);
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (!key || !externalResponses(binding) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
    if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") { res.writeHead(415).end(); return; }
    let body: string | undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400).end(); return; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { res.writeHead(400).end(); return; }
      delete (parsed as Record<string, unknown>).client_metadata;
      body = JSON.stringify(parsed);
    }
    const upstream = new URL(`${binding.apiProfile!.baseUrl.replace(/\/+$/, "")}/${match[2]}`);
    upstream.search = url.search;
    const response = await fetcher(upstream, {
      method: req.method!, ...(body !== undefined ? { body } : {}), redirect: "error", signal: abort.signal,
      headers: { ...binding.apiProfile!.headers, authorization: `Bearer ${key}`, "content-type": "application/json", accept: req.headers.accept ?? "text/event-stream" },
    });
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...(response.headers.get("retry-after") ? { "retry-after": response.headers.get("retry-after")! } : {}) });
    if (response.body) await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), res);
    else res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502).end("Model provider request failed");
    else res.destroy();
  } finally {
    clearTimeout(timeout);
    res.off("close", cancel);
  }
}
