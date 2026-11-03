import { NativeModule, requireOptionalNativeModule } from "expo";

import type { ProsperoGhosttyAvailability } from "./ProsperoGhostty.types";

declare class ProsperoGhosttyModule extends NativeModule {
  availability(): ProsperoGhosttyAvailability;
  write(viewTag: number, dataB64: string): void;
  events(viewTag: number, json: string): void;
  snapshot(viewTag: number, dataB64: string | null, ansi: string | null, cols: number, rows: number): void;
  focus(viewTag: number): void;
  blur(viewTag: number): void;
  scrollToBottom(viewTag: number): void;
  copyAll(viewTag: number): void;
  search(viewTag: number, text: string, previous: boolean, incremental: boolean): void;
  paste(viewTag: number, text: string): void;
}

export default requireOptionalNativeModule<ProsperoGhosttyModule>("ProsperoGhostty");
