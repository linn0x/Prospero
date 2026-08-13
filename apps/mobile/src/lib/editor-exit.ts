export type EditorExitPlan = "exit" | "confirm" | "ignore";

/**
 * Prevent duplicate predictive-back events from opening multiple discard
 * dialogs. The navigation event remains cancelled while the editor resolves
 * its own state transition back to the file browser.
 */
export function getEditorExitPlan({
  dirty,
  confirmationPending,
}: {
  dirty: boolean;
  confirmationPending: boolean;
}): EditorExitPlan {
  if (confirmationPending) return "ignore";
  return dirty ? "confirm" : "exit";
}

export function resolveEditorExitConfirmation(choice: "cancel" | "discard"): "stay" | "exit" {
  return choice === "discard" ? "exit" : "stay";
}
