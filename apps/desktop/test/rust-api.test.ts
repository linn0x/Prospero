import { describe, expect, it, vi } from "vitest";
import { RustClient } from "../src/main/rust-client";
import { applySessionChanges, previousCursors, visibleRows } from "../src/renderer/src/rust/session-page";
import type { ChangeEvent, SessionHead } from "@prospero/protocol/rust-daemon";

const token = "a".repeat(64);
const head: SessionHead = { id: "fixture", agent: "codex", title: "Example", workspace: "/synthetic", lifecycle: "archived", status: "completed", createdAt: 1, updatedAt: 1, revision: 1 };

describe("Rust desktop API boundary", () => {
  it.each(["https://example.invalid", "http://example.invalid", "http://127.0.0.1/path", "http://user@127.0.0.1", "http://127.0.0.1?token=fixture"])("rejects a non-local or credential-bearing daemon address", value => {
    expect(() => new RustClient(value, token)).toThrow();
  });

  it("uses bounded typed routes with owner credentials and no redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null })));
    const client = new RustClient("http://127.0.0.1:12345", token, fetcher);
    await client.sessions({ limit: 100, cursor: "cursor+value", lifecycle: "archived", workspace: null, text: null });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("cursor=cursor%2Bvalue");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
    expect(init?.redirect).toBe("error");
    expect(() => client.session("../accounts")).toThrow();
  });

  it("does not expose server error payloads or secrets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "storage", message: token }), { status: 500 }));
    const client = new RustClient("http://127.0.0.1:12345", token, fetcher);
    await expect(client.health()).rejects.toThrow("500");
    fetcher.mockResolvedValue(new Response(JSON.stringify({ code: "conflict", message: token }), { status: 409 }));
    await expect(client.rename("fixture", { revision: 1, title: "Rename" })).rejects.toThrow("记录已变更");
  });

  it("passes filters and bounded lookups without placing credentials in URLs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const client = new RustClient("http://127.0.0.1:12345", token, fetcher);
    await client.sessions({ limit: null, cursor: null, lifecycle: null, workspace: "/example?value", text: "中文 & words" });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get("workspace")).toBe("/example?value");
    expect(url.searchParams.get("text")).toBe("中文 & words");
    expect(url.searchParams.has("limit")).toBe(false);
    await client.summary("/example?value");
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("workspace")).toBe("/example?value");
    await client.workspaces({ limit: 20, cursor: "/path+space" });
    expect(new URL(String(fetcher.mock.calls[2]![0])).searchParams.get("cursor")).toBe("/path+space");
    await client.lookup(["fixture", "missing"]);
    expect(fetcher.mock.calls[3]![1]?.body).toBe(JSON.stringify({ ids: ["fixture", "missing"] }));
    expect(() => client.lookup(Array(101).fill("fixture"))).toThrow("limit");
    expect(() => client.lookup(["invalid/id"])).toThrow("Invalid record");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects oversized responses and invalid content cursors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    const client = new RustClient("http://127.0.0.1:12345", token, fetcher);
    await expect(client.health()).rejects.toThrow("page limit");
    fetcher.mockResolvedValue(new Response("hello", { headers: { "x-next-offset": "999" } }));
    await expect(client.content("fixture", "history", 0)).rejects.toThrow("Invalid content cursor");
  });
});

describe("bounded Rust session pages", () => {
  it("applies newer events only to records already in the page", () => {
    const event = (id: string, revision: number): ChangeEvent => ({ scope: "sessions", seq: revision, kind: "session.updated", entityId: id, data: { ...head, id, revision, title: "Updated" } });
    const items = applySessionChanges([head], [event("fixture", 3), event("fixture", 2), event("outside", 4), { ...event("fixture", 10), scope: "other" }]);
    expect(items).toHaveLength(1);
    expect(items[0]?.revision).toBe(3);
    expect(applySessionChanges(items, [event("fixture", 2)])[0]).toBe(items[0]);
    expect(head.title).toBe("Example");
  });

  it("bounds rendered rows and navigation history independently of archive size", () => {
    const visible = visibleRows(100000, 300000, 600);
    expect(visible.end - visible.start).toBeLessThanOrEqual(15);
    expect(visible.start).toBeGreaterThan(0);
    expect(previousCursors(Array.from({ length: 1000 }, (_, index) => String(index)), "new")).toHaveLength(64);
  });
});
