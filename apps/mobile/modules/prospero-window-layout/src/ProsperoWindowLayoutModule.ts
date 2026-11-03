import { NativeModule, requireOptionalNativeModule } from "expo";

import type {
  ProsperoWindowLayoutModuleEvents,
  WindowLayoutInfo,
} from "./ProsperoWindowLayout.types";

declare class ProsperoWindowLayoutModule extends NativeModule<ProsperoWindowLayoutModuleEvents> {
  getCurrent(): WindowLayoutInfo;
  /** Android only: follow the sensor even when the system rotation lock is on. */
  setSensorRotation?(enabled: boolean): void;
}

export default requireOptionalNativeModule<ProsperoWindowLayoutModule>(
  "ProsperoWindowLayout",
);
