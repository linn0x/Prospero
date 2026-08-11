export interface MixedSpeechToken {
  text: string;
  start: number;
  duration: number;
  confidence: number;
}

export type MixedSpeechEngine =
  | "apple"
  | "samsung"
  | "whisper"
  | "unavailable";

export interface MixedSpeechResult {
  zh: MixedSpeechToken[];
  en: MixedSpeechToken[];
  /** Samsung can return a complete local transcript without a second pass. */
  transcript?: string;
  engine?: MixedSpeechEngine;
  /** Android retains a local WAV whenever Whisper fallback is required. */
  audioFileUri?: string;
  fallbackReason?: string;
  duration?: number;
}

export type ProsperoMixedSpeechModuleEvents = {
  onVolume: (params: { value: number }) => void;
  onTranscript: (params: { transcript: string }) => void;
};
