import { Platform } from "react-native";
import { initWhisper, type WhisperContext } from "whisper.rn/index";

import { normalizeOfflineSpeechTranscript } from "@/lib/voice-input";

const MODEL_ASSET = "ggml-small-q5_1.bin";

let contextPromise: Promise<WhisperContext> | null = null;
let activeStop: (() => Promise<void>) | null = null;

function requireAndroid(): void {
  if (Platform.OS !== "android") {
    throw new Error("应用内 Whisper 转写只用于 Android。");
  }
}

/** Loads the bundled multilingual model once and keeps it warm for push-to-talk. */
export async function prepareAndroidOfflineSpeech(): Promise<void> {
  requireAndroid();
  let pendingContext = contextPromise;
  if (!pendingContext) {
    pendingContext = initWhisper({
      filePath: MODEL_ASSET,
      isBundleAsset: true,
      useGpu: false,
      useFlashAttn: false,
    });
    contextPromise = pendingContext;
  }
  try {
    await pendingContext;
  } catch (error) {
    if (contextPromise === pendingContext) contextPromise = null;
    throw error;
  }
}

export async function transcribeAndroidOfflineSpeech(
  audioFileUri: string,
  contextualTerms: readonly string[],
  onProgress?: (progress: number) => void,
): Promise<string> {
  requireAndroid();
  await prepareAndroidOfflineSpeech();
  const context = await contextPromise!;
  const prompt = [
    "以下内容是中文和 English 混合的技术口述。",
    "技术词保留英文拼写：",
    contextualTerms.slice(0, 80).join(", "),
  ].join(" ");
  const task = context.transcribe(audioFileUri, {
    language: "auto",
    translate: false,
    maxThreads: 4,
    nProcessors: 1,
    beamSize: 5,
    bestOf: 5,
    temperature: 0,
    temperatureInc: 0.2,
    prompt,
    onProgress,
  });
  activeStop = task.stop;

  try {
    const result = await task.promise;
    if (result.isAborted) return "";
    return normalizeOfflineSpeechTranscript(result.result);
  } finally {
    if (activeStop === task.stop) activeStop = null;
  }
}

export async function abortAndroidOfflineSpeech(): Promise<void> {
  const stop = activeStop;
  activeStop = null;
  if (stop) await stop();
}

/** Releases the large multilingual model when voice input is no longer visible. */
export async function releaseAndroidOfflineSpeech(): Promise<void> {
  await abortAndroidOfflineSpeech();
  const pendingContext = contextPromise;
  contextPromise = null;
  if (!pendingContext) return;

  try {
    const context = await pendingContext;
    await context.release();
  } catch {
    // Cleanup is best-effort; a failed initialization has no live context to free.
  }
}
