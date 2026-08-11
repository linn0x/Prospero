import { NativeModule, requireOptionalNativeModule } from "expo";

import type {
  ProsperoWindowLayoutModuleEvents,
  WindowLayoutInfo,
} from "./ProsperoWindowLayout.types";

declare class ProsperoWindowLayoutModule extends NativeModule<ProsperoWindowLayoutModuleEvents> {
  getCurrent(): WindowLayoutInfo;
}

export default requireOptionalNativeModule<ProsperoWindowLayoutModule>(
  "ProsperoWindowLayout",
);
