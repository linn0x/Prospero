import { NativeModule, requireOptionalNativeModule } from "expo";

declare class ProsperoProgressOverlayModule extends NativeModule {
  canDrawOverlays(): boolean;
  openOverlaySettings(): void;
  sync(
    title: string,
    detail: string,
    deepLink: string,
    runningCount: number,
    waitingCount: number,
    showOverlay: boolean,
  ): void;
  stop(): void;
}

export default requireOptionalNativeModule<ProsperoProgressOverlayModule>(
  "ProsperoProgressOverlay",
);
