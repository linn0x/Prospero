import { afterEach, expect, it, vi } from "vitest";
import { rememberedLaunchAgent, rememberedLaunchKind, rememberLaunch } from "../src/renderer/src/workspace/session-launch-preferences";

afterEach(() => vi.unstubAllGlobals());

it("remembers each agent's interface when switching between agents", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  rememberLaunch("codex", "pty");
  rememberLaunch("claude", "structured");
  expect(rememberedLaunchAgent()).toBe("claude");
  expect(rememberedLaunchKind("codex")).toBe("pty");
  expect(rememberedLaunchKind("claude")).toBe("structured");
  expect(rememberedLaunchKind("opencode")).toBe("pty");
});

it("does not restore unsupported modes or malformed settings", () => {
  vi.stubGlobal("localStorage", { getItem: () => '{"agent":"missing","kinds":{"deepseek":"pty","shell":"structured"}}' });
  expect(rememberedLaunchAgent()).toBe("codex");
  expect(rememberedLaunchKind("deepseek")).toBe("structured");
  expect(rememberedLaunchKind("shell")).toBe("pty");
  vi.stubGlobal("localStorage", { getItem: () => "{invalid" });
  expect(rememberedLaunchKind("codex")).toBe("structured");
});
