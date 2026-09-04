import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitFile } from "@prospero/protocol";
import { gitFileBadge, summarizeGitChanges } from "../src/lib/session-quick-panel";

function file(
  path: string,
  index: string,
  worktree: string,
  untracked = false,
): GitFile {
  return { path, index, worktree, untracked };
}

describe("session quick panel", () => {
  it("summarizes staged, unstaged and untracked changes without flattening mixed files", () => {
    const files = [
      file("staged.ts", "M", " "),
      file("mixed.ts", "M", "M"),
      file("working.ts", " ", "M"),
      file("new.ts", "?", "?", true),
    ];

    expect(summarizeGitChanges(files)).toEqual({
      changed: 4,
      staged: 2,
      unstaged: 3,
      untracked: 1,
    });
    expect(gitFileBadge(files[0]!)).toBe("M");
    expect(gitFileBadge(files[1]!)).toBe("MM");
    expect(gitFileBadge(files[3]!)).toBe("新");
  });

  it("wires a discoverable right-edge drawer into the session screen", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "host", "[hostId]", "session", "[sid].tsx"),
      "utf8",
    );

    expect(source).toContain("<ReanimatedDrawerLayout");
    expect(source).toContain("drawerPosition={DrawerPosition.RIGHT}");
    expect(source).toContain("edgeWidth={28}");
    expect(source).toContain("<SessionQuickPanel");
    expect(source).toContain('accessibilityLabel="打开会话工具"');
  });
});
