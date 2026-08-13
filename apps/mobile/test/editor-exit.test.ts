import { describe, expect, it } from "vitest";
import {
  getEditorExitPlan,
  resolveEditorExitConfirmation,
} from "../src/lib/editor-exit";

describe("file editor back guard", () => {
  it("does not start a second navigation while a discard confirmation is open", () => {
    expect(getEditorExitPlan({ dirty: true, confirmationPending: false })).toBe("confirm");
    expect(getEditorExitPlan({ dirty: true, confirmationPending: true })).toBe("ignore");
  });

  it("keeps the editor on cancel and exits it exactly once on discard", () => {
    expect(resolveEditorExitConfirmation("cancel")).toBe("stay");
    expect(resolveEditorExitConfirmation("discard")).toBe("exit");
    expect(getEditorExitPlan({ dirty: false, confirmationPending: false })).toBe("exit");
  });
});
