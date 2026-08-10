import { NativeModule, requireOptionalNativeModule } from "expo";

import type {
  MixedSpeechResult,
  ProsperoMixedSpeechModuleEvents,
} from "./ProsperoMixedSpeech.types";

declare class ProsperoMixedSpeechModule extends NativeModule<ProsperoMixedSpeechModuleEvents> {
  isAvailable(): boolean;
  prepare(): Promise<void>;
  start(contextualStrings: string[]): Promise<void>;
  stop(): Promise<MixedSpeechResult>;
  deleteRecording(uri: string): Promise<void>;
  abort(): Promise<void>;
}

export default requireOptionalNativeModule<ProsperoMixedSpeechModule>(
  "ProsperoMixedSpeech",
);
