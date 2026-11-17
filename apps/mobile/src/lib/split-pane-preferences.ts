import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

export const SPLIT_PANE_RATIO_STORAGE_KEY = "prospero.splitPaneRatio.v1";

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.78;

function clampRatio(ratio: number): number {
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
}

interface SplitPanePreferencesState {
  customRatio: number | null;
  hydrated: boolean;
  hydrate(): Promise<void>;
  setCustomRatio(ratio: number): void;
  commitCustomRatio(ratio: number): void;
  resetCustomRatio(): void;
}

let hydratePromise: Promise<void> | null = null;
let pendingFrame: number | null = null;
let pendingRatio: number | null = null;

export const useSplitPanePreferences = create<SplitPanePreferencesState>()((set, get) => ({
  customRatio: null,
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    if (hydratePromise) return hydratePromise;
    hydratePromise = AsyncStorage.getItem(SPLIT_PANE_RATIO_STORAGE_KEY)
      .then((raw) => {
        if (get().customRatio !== null) {
          set({ hydrated: true });
          return;
        }
        const parsed = raw !== null ? Number.parseFloat(raw) : Number.NaN;
        set({
          customRatio: Number.isFinite(parsed) ? clampRatio(parsed) : null,
          hydrated: true,
        });
      })
      .catch(() => {
        set({ hydrated: true });
      })
      .finally(() => {
        hydratePromise = null;
      });
    return hydratePromise;
  },
  setCustomRatio: (ratio) => {
    if (!Number.isFinite(ratio)) return;
    const clamped = clampRatio(ratio);
    pendingRatio = clamped;
    if (typeof requestAnimationFrame !== "function") {
      pendingRatio = null;
      set({ customRatio: clamped });
      return;
    }
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      if (pendingRatio !== null) {
        const next = pendingRatio;
        pendingRatio = null;
        set({ customRatio: next });
      }
    });
  },
  commitCustomRatio: (ratio) => {
    if (!Number.isFinite(ratio)) return;
    if (pendingFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    pendingRatio = null;
    const clamped = clampRatio(ratio);
    set({ customRatio: clamped, hydrated: true });
    void AsyncStorage.setItem(SPLIT_PANE_RATIO_STORAGE_KEY, clamped.toFixed(4)).catch(() => undefined);
  },
  resetCustomRatio: () => {
    if (pendingFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    pendingRatio = null;
    set({ customRatio: null, hydrated: true });
    void AsyncStorage.removeItem(SPLIT_PANE_RATIO_STORAGE_KEY).catch(() => undefined);
  },
}));
