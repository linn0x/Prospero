import { expect, it } from "vitest";
import { chatBranchDisabledReason } from "../src/renderer/src/workspace/chat-branch";
import type { SessionInfo } from "../src/shared/types";

const terminal: SessionInfo = { id: "source", title: "Source", cwd: "/workspace", agent: "codex", kind: "pty", status: "running" };

it.each(["codex", "claude"])("allows a live %s terminal to open an independent history picker", agent => {
  expect(chatBranchDisabledReason({ ...terminal, agent })).toBeUndefined();
});
it("keeps active structured turns disabled with an explicit reason", () => {
  expect(chatBranchDisabledReason({ ...terminal, kind: "structured" })).toBe("turn");
  expect(chatBranchDisabledReason({ ...terminal, kind: "structured", status: "idle" })).toBeUndefined();
});
it("explains unsupported agents, kinds and missing directories", () => {
  expect(chatBranchDisabledReason({ ...terminal, agent: "shell" })).toBe("agent");
  expect(chatBranchDisabledReason({ ...terminal, kind: "other" })).toBe("kind");
  expect(chatBranchDisabledReason({ ...terminal, cwd: "" })).toBe("workspace");
});
