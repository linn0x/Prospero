import { NativeModule, requireOptionalNativeModule } from "expo";
import type { ProsperoProgressOverlayModuleEvents } from "./ProsperoProgressOverlay.types";

declare class ProsperoProgressOverlayModule extends NativeModule<ProsperoProgressOverlayModuleEvents> {
  canDrawOverlays(): boolean;
  openOverlaySettings(): void;
  sync(
    title: string,
    detail: string,
    deepLink: string,
    runningCount: number,
    waitingCount: number,
    showOverlay: boolean,
    approvalJson: string,
  ): void;
  stop(): void;
}

export default requireOptionalNativeModule<ProsperoProgressOverlayModule>(
  "ProsperoProgressOverlay",
);
