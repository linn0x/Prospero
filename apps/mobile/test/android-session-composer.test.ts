import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(import.meta.dirname, "..");
const sessionSource = readFileSync(
  join(mobileRoot, "src", "app", "host", "[hostId]", "session", "[sid].tsx"),
  "utf8",
);
const dismissKeySource = readFileSync(
  join(mobileRoot, "src", "components", "DismissKey.tsx"),
  "utf8",
);

describe("Android session composer interactions", () => {
  it("does not wrap the session screen in a swipeable right drawer that blocks buttons or split-pane drags", () => {
    expect(sessionSource).not.toContain("ReanimatedDrawerLayout");
    expect(sessionSource).not.toContain("SessionQuickPanel");
    expect(sessionSource).toContain("onPress={() => send(draftRef.current)}");
  });

  it("relies on Android's system IME dismiss control", () => {
    expect(dismissKeySource).toContain('Platform.OS === "android"');
    expect(sessionSource).toContain(
      'onDismissKeyboard={Platform.OS === "android" ? undefined',
    );
  });
});
