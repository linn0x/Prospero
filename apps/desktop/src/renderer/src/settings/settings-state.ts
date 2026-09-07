export const settingsCategories = [
  { id: "general", zh: "通用", en: "General" },
  { id: "appearance", zh: "外观", en: "Appearance" },
  { id: "accounts", zh: "Agent 与账号", en: "Agents and accounts" },
  { id: "terminal", zh: "终端", en: "Terminal" },
  { id: "runtime", zh: "运行时与网络", en: "Runtime and network" },
  { id: "relay", zh: "Relay", en: "Relay" },
] as const;

export type SettingsCategory = typeof settingsCategories[number]["id"];
export type SettingFeedback = { state: "saving" | "saved" | "error"; message?: string };
type Operation = () => Promise<string | false>;

export function nextSettingsCategory(current: SettingsCategory, key: string): SettingsCategory | undefined {
  const index = settingsCategories.findIndex((category) => category.id === current);
  if (key === "Home") return settingsCategories[0].id;
  if (key === "End") return settingsCategories.at(-1)!.id;
  if (["ArrowDown", "ArrowRight"].includes(key)) return settingsCategories[(index + 1) % settingsCategories.length]!.id;
  if (["ArrowUp", "ArrowLeft"].includes(key)) return settingsCategories[(index + settingsCategories.length - 1) % settingsCategories.length]!.id;
  return undefined;
}

export function terminalFontSize(value: string): number | undefined {
  const parsed = Number(value);
  return value.trim() && Number.isInteger(parsed) && parsed >= 8 && parsed <= 48 ? parsed : undefined;
}

export function validRelayUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === "wss:" && Boolean(url.hostname) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export class SettingsActions {
  private pending = new Map<string, Promise<void>>();
  private groups = new Map<string, Promise<void>>();
  private retries = new Map<string, { operation: Operation; group: string }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private change: (id: string, feedback: SettingFeedback | undefined) => void, private error: (reason: unknown) => string) {}

  run(id: string, operation: Operation, group = id): Promise<void> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    clearTimeout(this.timers.get(id));
    this.retries.set(id, { operation, group });
    this.change(id, { state: "saving" });
    const task = (this.groups.get(group) ?? Promise.resolve()).then(async () => {
      try {
        const message = await operation();
        this.retries.delete(id);
        this.change(id, message === false ? undefined : { state: "saved", message });
        if (message !== false) this.timers.set(id, setTimeout(() => {
          this.change(id, undefined);
          this.timers.delete(id);
        }, 2500));
      } catch (reason) {
        this.change(id, { state: "error", message: this.error(reason) });
      } finally {
        this.pending.delete(id);
        if (this.groups.get(group) === task) this.groups.delete(group);
      }
    });
    this.pending.set(id, task);
    this.groups.set(group, task);
    return task;
  }

  retry(id: string): Promise<void> {
    const retry = this.retries.get(id);
    return retry ? this.run(id, retry.operation, retry.group) : Promise.resolve();
  }

  clear(id: string): void {
    if (this.pending.has(id)) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.retries.delete(id);
    this.change(id, undefined);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
