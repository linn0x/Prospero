import { describe, expect, it } from "vitest";
import { remoteChildLocation, remoteParentLocation } from "../src/renderer/src/remote-workspaces/workspace-location";

describe("remote workspace locations", () => {
  it("keeps folders relative to the selected remote root", () => {
    expect(remoteChildLocation({ root: "home", path: "projects" }, "api service")).toEqual({ root: "home", path: "projects/api service" });
    expect(remoteParentLocation({ root: "home", path: "projects/api" })).toEqual({ root: "home", path: "projects" });
    expect(remoteParentLocation({ root: "home", path: "" })).toBeUndefined();
  });
  it("navigates remote Windows drives independently of the local platform", () => {
    expect(remoteChildLocation({ root: "computer", path: "" }, "D:")).toEqual({ root: "D:", path: "" });
    expect(remoteParentLocation({ root: "D:", path: "" })).toEqual({ root: "computer", path: "" });
    expect(remoteChildLocation({ root: "computer", path: "" }, "/local/path")).toBeUndefined();
  });
  it("rejects unsafe remote entries without resolving them locally", () => {
    for (const name of [".", "..", "../escape", "/tmp", "a\\b", "bad\0name", ""]) expect(remoteChildLocation({ root: "home", path: "" }, name)).toBeUndefined();
  });
});
