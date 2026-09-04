import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const screen = readFileSync(
  join(import.meta.dirname, "..", "src", "app", "host", "[hostId]", "accounts.tsx"),
  "utf8",
);

describe("account management UI", () => {
  it("gates protocol selection on the daemon capability", () => {
    expect(screen).toContain("conn?.supportsAgentApiProtocols");
    expect(screen).toContain('Alert.alert("选择 API 协议"');
    expect(screen).toContain("editor.draft.protocol");
  });

  it("allows a new daemon to preserve an API key during profile edits", () => {
    expect(screen).toContain("optionalApiKey");
    expect(screen).toContain("留空会保留现有 Key");
    expect(screen).toContain("trimmedValue || undefined");
  });

  it("keeps rename available for every managed account", () => {
    expect(screen).toContain('{account.managed && <Action label="重命名"');
  });
});
