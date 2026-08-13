import { describe, expect, it } from "vitest";
import { getGitCommitBarPadding } from "../src/lib/git-layout";

describe("Git commit bar insets", () => {
  it("uses only the system-bar inset after the keyboard has closed", () => {
    expect(getGitCommitBarPadding({ bottom: 0, left: 0, right: 0 })).toEqual({
      paddingTop: 10,
      paddingBottom: 10,
      paddingLeft: 10,
      paddingRight: 10,
    });
  });

  it("keeps commit controls clear of bottom and side system bars", () => {
    expect(getGitCommitBarPadding({ bottom: 24, left: 0, right: 32 })).toEqual({
      paddingTop: 10,
      paddingBottom: 34,
      paddingLeft: 10,
      paddingRight: 42,
    });
  });
});
