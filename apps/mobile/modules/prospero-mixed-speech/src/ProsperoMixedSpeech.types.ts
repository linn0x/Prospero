export interface MixedSpeechToken {
  text: string;
  start: number;
  duration: number;
  confidence: number;
}

export interface MixedSpeechResult {
  zh: MixedSpeechToken[];
  en: MixedSpeechToken[];
  /** Android records a local WAV first, then whisper.cpp transcribes it in JS. */
  audioFileUri?: string;
  duration?: number;
}

export type ProsperoMixedSpeechModuleEvents = {
  onVolume: (params: { value: number }) => void;
};
