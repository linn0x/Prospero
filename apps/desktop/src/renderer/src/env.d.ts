import type { DesktopApi } from "../../shared/types";

declare global {
  interface Window {
    prospero: DesktopApi;
  }
}

export {};
