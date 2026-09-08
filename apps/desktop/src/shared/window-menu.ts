export type WindowMenuName = "file" | "edit" | "view" | "help";
export type WindowMenuAction = "new-session" | "settings" | "toggle-sidebar" | "command";
export interface WindowMenuRequest { menu: WindowMenuName; x: number; y: number; language: "zh" | "en" }
export function windowMenuRequest(value: unknown): WindowMenuRequest {
  if (!value || typeof value !== "object") throw new Error("无效的窗口菜单");
  const request = value as WindowMenuRequest;
  if (!["file", "edit", "view", "help"].includes(request.menu) || ![request.x, request.y].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 16_384) || !["zh", "en"].includes(request.language)) throw new Error("无效的窗口菜单");
  return { menu: request.menu, x: Math.round(request.x), y: Math.round(request.y), language: request.language };
}
