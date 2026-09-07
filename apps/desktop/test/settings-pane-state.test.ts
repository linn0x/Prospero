import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsActions, nextSettingsCategory, settingsCategories, terminalFontSize, validRelayUrl, type SettingFeedback } from "../src/renderer/src/settings/settings-state";

afterEach(() => vi.useRealTimers());

describe("settings categories", () => {
  it("keeps every existing setting family reachable", () => {
    expect(settingsCategories.map((category) => category.id)).toEqual(["general", "appearance", "accounts", "terminal", "runtime", "relay"]);
    expect(settingsCategories.every((category) => category.zh && category.en)).toBe(true);
  });

  it("supports horizontal and vertical navigation with wrapping and boundaries", () => {
    expect(nextSettingsCategory("general", "ArrowLeft")).toBe("relay");
    expect(nextSettingsCategory("relay", "ArrowDown")).toBe("general");
    expect(nextSettingsCategory("accounts", "ArrowRight")).toBe("terminal");
    expect(nextSettingsCategory("accounts", "ArrowUp")).toBe("appearance");
    expect(nextSettingsCategory("runtime", "Home")).toBe("general");
    expect(nextSettingsCategory("general", "End")).toBe("relay");
    expect(nextSettingsCategory("general", "Tab")).toBeUndefined();
  });
});

describe("settings validation", () => {
  it("limits terminal font size to supported integer values", () => {
    expect(terminalFontSize("8")).toBe(8);
    expect(terminalFontSize("48")).toBe(48);
    for (const input of ["", " ", "7", "49", "12.5", "NaN", "Infinity"]) expect(terminalFontSize(input)).toBeUndefined();
  });

  it("accepts default and secure relay URLs without embedded credentials", () => {
    expect(validRelayUrl("")).toBe(true);
    expect(validRelayUrl(" wss://relay.example.com/path ")).toBe(true);
    for (const url of ["https://relay.example.com", "ws://relay.example.com", "wss://user:secret@relay.example.com", "wss://relay.example.com#fragment", "not a URL"]) expect(validRelayUrl(url)).toBe(false);
  });
});

describe("settings row mutations", () => {
  it("deduplicates the same row and serializes related operations", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const controller = new SettingsActions(() => {}, String);
    const first = vi.fn(async () => { events.push("start"); await new Promise<void>((resolve) => { release = resolve; }); events.push("complete"); return "Saved"; });
    const second = vi.fn(async () => { events.push("next"); return "Saved"; });
    const pending = controller.run("theme", first, "settings");
    expect(controller.run("theme", first, "settings")).toBe(pending);
    const queued = controller.run("font", second, "settings");
    await Promise.resolve();
    expect(events).toEqual(["start"]);
    release!();
    await Promise.all([pending, queued]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["start", "complete", "next"]);
    controller.dispose();
  });

  it("keeps errors on their row and retries a failed save", async () => {
    const feedback: Record<string, SettingFeedback | undefined> = {};
    const controller = new SettingsActions((id, next) => { feedback[id] = next; }, String);
    const operation = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("Denied")).mockResolvedValue("Saved");
    await controller.run("font", operation);
    expect(feedback["font"]).toEqual({ state: "error", message: "Error: Denied" });
    expect(feedback["theme"]).toBeUndefined();
    await controller.retry("font");
    expect(feedback["font"]).toEqual({ state: "saved", message: "Saved" });
    expect(operation).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("clears successful feedback and does not display success after cancellation", async () => {
    vi.useFakeTimers();
    const change = vi.fn();
    const controller = new SettingsActions(change, String);
    await controller.run("theme", async () => "Saved");
    expect(change).toHaveBeenLastCalledWith("theme", { state: "saved", message: "Saved" });
    vi.advanceTimersByTime(2500);
    expect(change).toHaveBeenLastCalledWith("theme", undefined);
    await controller.run("relay-key", async () => false);
    expect(change).toHaveBeenLastCalledWith("relay-key", undefined);
    controller.dispose();
  });

  it("continues queued operations after failure and clears stale retry on editing", async () => {
    const controller = new SettingsActions(() => {}, String);
    const rejected = vi.fn(async () => { throw new Error("Failed"); });
    const next = vi.fn(async () => "Saved");
    await Promise.all([controller.run("first", rejected, "settings"), controller.run("next", next, "settings")]);
    expect(next).toHaveBeenCalledOnce();
    controller.clear("first");
    await controller.retry("first");
    expect(rejected).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("can report a refresh failure without replaying a confirmed destructive action", async () => {
    const feedback: Record<string, SettingFeedback | undefined> = {};
    const controller = new SettingsActions((id, next) => { feedback[id] = next; }, String);
    const rotate = vi.fn(async () => {
      await controller.run("relay-status", async () => { throw new Error("Offline"); });
      return "Key rotated";
    });
    await controller.run("relay-key", rotate, "relay");
    expect(feedback["relay-key"]?.state).toBe("saved");
    expect(feedback["relay-status"]?.state).toBe("error");
    await controller.retry("relay-status");
    expect(rotate).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
