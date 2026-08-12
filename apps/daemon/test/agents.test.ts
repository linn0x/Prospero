import { describe, expect, it } from "vitest";
import { commandFor } from "../src/agents.js";

describe("PTY agent startup commands", () => {
  it("starts Codex with approvals and sandboxing bypassed", () => {
    expect(commandFor("codex")).toEqual({
      file: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
    });
  });

  it("starts Claude with permission checks skipped", () => {
    expect(commandFor("claude")).toEqual({
      file: "claude",
      args: ["--dangerously-skip-permissions"],
    });
  });

  it("does not add agent bypass flags to Shell or custom commands", () => {
    expect(commandFor("shell").args).toEqual(["-il"]);
    expect(commandFor("custom", "printf hello")).toEqual({
      file: process.env["SHELL"] ?? "/bin/zsh",
      args: ["-c", "printf hello"],
    });
  });
});
