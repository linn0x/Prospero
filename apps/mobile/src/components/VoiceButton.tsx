import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import ProsperoMixedSpeechModule from "../../modules/prospero-mixed-speech/src/ProsperoMixedSpeechModule";
import type {
  MixedSpeechEngine,
  MixedSpeechResult,
} from "../../modules/prospero-mixed-speech/src/ProsperoMixedSpeech.types";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/Toast";
import { color } from "@/lib/theme";
import {
  abortAndroidOfflineSpeech,
  prepareAndroidOfflineSpeech,
  releaseAndroidOfflineSpeech,
  scheduleAndroidOfflineSpeechRelease,
  transcribeAndroidOfflineSpeech,
} from "@/lib/android-offline-speech";
import {
  androidMixedRecognitionOptions,
  DEFAULT_VOICE_INPUT_LOCALE,
  joinRecognitionSegments,
  mergeBilingualSpeech,
  missingVoiceInputLocales,
  normalizeOfflineSpeechTranscript,
  onDeviceRecognitionOptions,
  shouldUseAndroidSystemSpeech,
  supportsAndroidMixedSpeech,
  VOICE_INPUT_LOCALES,
  voiceRecognitionErrorMessage,
  type VoiceInputLocale,
} from "@/lib/voice-input";

type Phase = "idle" | "starting" | "recording" | "transcribing" | "cancelling";
type Availability =
  | { kind: "checking" }
  | { kind: "ready" }
  | {
      kind: "missing-model";
      reason: string;
      locales?: VoiceInputLocale[];
    }
  | { kind: "unsupported"; reason: string };

const CANCEL_DISTANCE = 64;
const TECHNICAL_TERMS = [
  "Prospero",
  "Codex",
  "Claude",
  "Git",
  "GitHub",
  "TypeScript",
  "React Native",
  "Expo",
  "JavaScript",
  "Xcode",
  "iPhone",
  "daemon",
  "workspace",
  "repository",
  "pull request",
  "commit",
  "branch",
  "lint",
  "build",
  "resume",
  "Plan mode",
];

function nativeSpeechEngine(): MixedSpeechEngine {
  if (
    (Platform.OS !== "ios" && Platform.OS !== "android") ||
    !ProsperoMixedSpeechModule
  ) {
    return "unavailable";
  }
  try {
    return ProsperoMixedSpeechModule.getEngine();
  } catch {
    return "unavailable";
  }
}

function usesAppleMixedSpeech(): boolean {
  return Platform.OS === "ios" && nativeSpeechEngine() === "apple";
}

function usesSamsungMixedSpeech(): boolean {
  return (
    Platform.OS === "android" &&
    nativeSpeechEngine() === "samsung" &&
    !usesAndroidMixedSpeech()
  );
}

function usesBundledAndroidMixedSpeech(): boolean {
  return (
    Platform.OS === "android" &&
    nativeSpeechEngine() === "whisper" &&
    !usesAndroidMixedSpeech()
  );
}

function usesAndroidMixedSpeech(): boolean {
  if (
    Platform.OS !== "android" ||
    !supportsAndroidMixedSpeech(Platform.Version)
  ) {
    return false;
  }
  try {
    return shouldUseAndroidSystemSpeech(
      Platform.Version,
      ExpoSpeechRecognitionModule.isRecognitionAvailable(),
      ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
    );
  } catch {
    return false;
  }
}

function offlineLocaleNames(locales: readonly VoiceInputLocale[]): string {
  return locales
    .map((locale) => (locale === "en-US" ? "英文" : "中文"))
    .join("和");
}

async function inspectAvailability(): Promise<Availability> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { kind: "unsupported", reason: "当前平台不支持设备端语音输入。" };
  }

  const appleMixedAvailable = usesAppleMixedSpeech();
  const androidSystemMixedAvailable = usesAndroidMixedSpeech();
  const samsungMixedAvailable = usesSamsungMixedSpeech();
  const bundledAndroidMixedAvailable = usesBundledAndroidMixedSpeech();
  try {
    if (appleMixedAvailable) {
      await ProsperoMixedSpeechModule!.prepare();
      return { kind: "ready" };
    }

    if (samsungMixedAvailable || bundledAndroidMixedAvailable) {
      // Loading the model after the user releases push-to-talk accounts for a
      // large part of perceived latency. Keep it warm as Samsung's guaranteed
      // local fallback too, because vendor access can vary by firmware policy.
      await Promise.all([
        ProsperoMixedSpeechModule!.prepare(),
        prepareAndroidOfflineSpeech(),
      ]);
      return { kind: "ready" };
    }

    if (
      !ExpoSpeechRecognitionModule.isRecognitionAvailable() ||
      !ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()
    ) {
      return {
        kind: "unsupported",
        reason:
          "这台设备没有可用的端侧语音识别服务，Prospero 不会退回在线识别。",
      };
    }

    // Android 12 及以下无法可靠强制端侧识别，宁可禁用也不冒险联网。
    if (Platform.OS === "android") {
      const apiLevel = Number(Platform.Version);
      if (!Number.isFinite(apiLevel) || apiLevel < 33) {
        return {
          kind: "unsupported",
          reason: "设备端语音输入需要 Android 13 或更高版本。",
        };
      }

      const supported = await ExpoSpeechRecognitionModule.getSupportedLocales(
        {},
      );
      const requiredLocales = androidSystemMixedAvailable
        ? VOICE_INPUT_LOCALES
        : ([DEFAULT_VOICE_INPUT_LOCALE] as const);
      const unsupportedLocales = missingVoiceInputLocales(
        supported.locales,
        requiredLocales,
      );
      if (unsupportedLocales.length > 0) {
        return {
          kind: "unsupported",
          reason: `这台设备的端侧语音识别不支持${offlineLocaleNames(unsupportedLocales)}。`,
        };
      }
      const missingLocales = missingVoiceInputLocales(
        supported.installedLocales,
        requiredLocales,
      );
      if (missingLocales.length > 0) {
        return {
          kind: "missing-model",
          reason: `需要先安装系统的${offlineLocaleNames(missingLocales)}离线语音包。`,
          locales: missingLocales,
        };
      }
    }

    return { kind: "ready" };
  } catch (error) {
    if (appleMixedAvailable) {
      return {
        kind: "missing-model",
        reason:
          error instanceof Error
            ? error.message
            : "中英文离线语音模型准备失败，请联网后重试。",
      };
    }
    if (samsungMixedAvailable || bundledAndroidMixedAvailable) {
      return {
        kind: "unsupported",
        reason:
          error instanceof Error
            ? `应用内离线语音模型加载失败：${error.message}`
            : "应用内离线语音模型加载失败，请重新安装完整 APK。",
      };
    }
    return {
      kind: "unsupported",
      reason: "无法确认离线语音模型状态；为保护隐私，语音输入已禁用。",
    };
  }
}

interface Props {
  onTranscript: (text: string) => void;
}

/** 结构化聊天专用的 push-to-talk 按钮。 */
export function VoiceButton({ onTranscript }: Props) {
  const appleMixedMode = usesAppleMixedSpeech();
  const samsungMixedMode = usesSamsungMixedSpeech();
  const bundledAndroidMixedMode = usesBundledAndroidMixedSpeech();
  const androidNativeMixedMode =
    samsungMixedMode || bundledAndroidMixedMode;
  const nativeMixedMode = appleMixedMode || androidNativeMixedMode;
  const mixedMode = nativeMixedMode || usesAndroidMixedSpeech();
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [availability, setAvailabilityState] = useState<Availability>({
    kind: "checking",
  });
  const [cancelArmed, setCancelArmedState] = useState(false);
  const [volume, setVolume] = useState(-2);
  const [preview, setPreview] = useState("");
  const [transcriptionProgress, setTranscriptionProgress] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState<"zh" | "en" | null>(
    null,
  );

  const mountedRef = useRef(true);
  const phaseRef = useRef<Phase>("idle");
  const availabilityRef = useRef<Availability>({ kind: "checking" });
  const onTranscriptRef = useRef(onTranscript);
  const holdingRef = useRef(false);
  const longPressTriggeredRef = useRef(false);
  const startYRef = useRef(0);
  const cancelArmedRef = useRef(false);
  const activeRef = useRef(false);
  const cancelledRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const finalSegmentsRef = useRef<string[]>([]);
  const partialRef = useRef("");
  const errorRef = useRef<string | null>(null);
  const operationRef = useRef(0);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhaseState(next);
  }, []);

  const setAvailability = useCallback((next: Availability) => {
    availabilityRef.current = next;
    if (mountedRef.current) setAvailabilityState(next);
  }, []);

  const setCancelArmed = useCallback((next: boolean) => {
    cancelArmedRef.current = next;
    if (mountedRef.current) setCancelArmedState(next);
  }, []);

  const clearRecognitionText = useCallback(() => {
    finalSegmentsRef.current = [];
    partialRef.current = "";
    errorRef.current = null;
    if (mountedRef.current) {
      setPreview("");
      setTranscriptionProgress(0);
      setVolume(-2);
      setDetectedLanguage(null);
    }
  }, []);

  const refreshAvailability = useCallback(async (): Promise<Availability> => {
    setAvailability({ kind: "checking" });
    const next = await inspectAvailability();
    if (mountedRef.current) setAvailability(next);
    return next;
  }, [setAvailability]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshAvailability();
    return () => {
      mountedRef.current = false;
      if (nativeMixedMode) {
        void ProsperoMixedSpeechModule?.abort();
        if (androidNativeMixedMode) {
          scheduleAndroidOfflineSpeechRelease();
        }
      } else if (activeRef.current) {
        cancelledRef.current = true;
        ExpoSpeechRecognitionModule.abort();
      }
    };
  }, [androidNativeMixedMode, nativeMixedMode, refreshAvailability]);

  useEffect(() => {
    if (!nativeMixedMode || !ProsperoMixedSpeechModule) return;
    const volumeSubscription = ProsperoMixedSpeechModule.addListener(
      "onVolume",
      ({ value }) => {
        if (activeRef.current && !cancelledRef.current && mountedRef.current) {
          setVolume(value);
        }
      },
    );
    const transcriptSubscription = ProsperoMixedSpeechModule.addListener(
      "onTranscript",
      ({ transcript }) => {
        if (activeRef.current && !cancelledRef.current && mountedRef.current) {
          setPreview(normalizeOfflineSpeechTranscript(transcript));
        }
      },
    );
    return () => {
      volumeSubscription.remove();
      transcriptSubscription.remove();
    };
  }, [nativeMixedMode]);

  // Android 模型下载和 iOS 系统设置都可能切走 App；回来时重新检测能力。
  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (
        state !== "active" &&
        androidNativeMixedMode &&
        phaseRef.current === "idle"
      ) {
        void releaseAndroidOfflineSpeech();
      }
      if (
        state === "active" &&
        (availabilityRef.current.kind !== "ready" || androidNativeMixedMode)
      ) {
        void refreshAvailability();
      }
    });
    return () => subscription.remove();
  }, [androidNativeMixedMode, refreshAvailability]);

  useSpeechRecognitionEvent("start", () => {
    if (!activeRef.current || cancelledRef.current || stopRequestedRef.current)
      return;
    setPhase("recording");
  });

  useSpeechRecognitionEvent("volumechange", (event) => {
    if (!activeRef.current || cancelledRef.current || !mountedRef.current)
      return;
    setVolume(event.value);
  });

  useSpeechRecognitionEvent("languagedetection", (event) => {
    if (
      Platform.OS !== "android" ||
      !activeRef.current ||
      cancelledRef.current ||
      !mountedRef.current
    ) {
      return;
    }
    const language = event.detectedLanguage.toLowerCase();
    if (language.startsWith("zh")) setDetectedLanguage("zh");
    else if (language.startsWith("en")) setDetectedLanguage("en");
  });

  useSpeechRecognitionEvent("result", (event) => {
    if (!activeRef.current || cancelledRef.current) return;
    const transcript = event.results[0]?.transcript.trim() ?? "";
    if (transcript.length === 0) return;

    if (event.isFinal) {
      if (Platform.OS === "android") {
        // Android continuous 模式的 final 是逐段返回；iOS 的 final 则是整段替换。
        if (finalSegmentsRef.current.at(-1) !== transcript) {
          finalSegmentsRef.current.push(transcript);
        }
      } else {
        finalSegmentsRef.current = [transcript];
      }
      partialRef.current = "";
    } else {
      partialRef.current = transcript;
    }

    if (mountedRef.current) {
      setPreview(
        joinRecognitionSegments(finalSegmentsRef.current, partialRef.current),
      );
    }
  });

  useSpeechRecognitionEvent("nomatch", () => {
    if (activeRef.current && !cancelledRef.current)
      errorRef.current = "no-speech";
  });

  useSpeechRecognitionEvent("error", (event) => {
    if (!activeRef.current || cancelledRef.current) return;
    errorRef.current = event.error;
    if (
      Platform.OS === "ios" &&
      (event.error === "language-not-supported" ||
        event.error === "service-not-allowed")
    ) {
      setAvailability({
        kind: "unsupported",
        reason: "中文端侧语音模型不可用；Prospero 不会改用在线识别。",
      });
    }
    setPhase("transcribing");
  });

  useSpeechRecognitionEvent("end", () => {
    if (!activeRef.current) return;

    const wasCancelled = cancelledRef.current;
    const error = errorRef.current;
    const transcript = joinRecognitionSegments(
      finalSegmentsRef.current,
      partialRef.current,
    );

    activeRef.current = false;
    cancelledRef.current = false;
    stopRequestedRef.current = false;
    setCancelArmed(false);
    clearRecognitionText();
    setPhase("idle");

    if (!mountedRef.current || wasCancelled) return;

    if (transcript.length > 0) onTranscriptRef.current(transcript);
    if (error) {
      toast(
        transcript.length > 0
          ? "转写中断，已把识别到的内容保留在草稿中。"
          : voiceRecognitionErrorMessage(error),
      );
    } else if (transcript.length === 0) {
      toast("没有识别到语音。");
    }
  });

  const finishMixedRecognition = useCallback(
    (
      operation: number,
      transcript: string,
      error?: unknown,
      wasCancelled = false,
    ) => {
      if (operationRef.current !== operation || !activeRef.current) return;
      activeRef.current = false;
      cancelledRef.current = false;
      stopRequestedRef.current = false;
      setCancelArmed(false);
      clearRecognitionText();
      setPhase("idle");

      if (!mountedRef.current || wasCancelled) return;
      if (transcript.length > 0) onTranscriptRef.current(transcript);
      if (error) {
        toast(
          transcript.length > 0
            ? "转写中断，已把识别到的内容保留在草稿中。"
            : error instanceof Error
              ? error.message
              : "中英文离线转写失败，请重试。",
        );
      } else if (transcript.length === 0) {
        toast("没有识别到语音。");
      }
    },
    [clearRecognitionText, setCancelArmed, setPhase],
  );

  const cancelRecognition = useCallback(() => {
    if (!activeRef.current || cancelledRef.current) return;
    const operation = operationRef.current;
    cancelledRef.current = true;
    setPhase("cancelling");
    clearRecognitionText();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if (nativeMixedMode && ProsperoMixedSpeechModule) {
      const tasks: Promise<unknown>[] = [ProsperoMixedSpeechModule.abort()];
      if (androidNativeMixedMode) {
        tasks.push(abortAndroidOfflineSpeech());
      }
      void Promise.allSettled(tasks).finally(() => {
        finishMixedRecognition(operation, "", undefined, true);
      });
    } else {
      ExpoSpeechRecognitionModule.abort();
    }
  }, [
    androidNativeMixedMode,
    clearRecognitionText,
    finishMixedRecognition,
    nativeMixedMode,
    setPhase,
  ]);

  const stopRecognition = useCallback(() => {
    if (!activeRef.current || cancelledRef.current) return;
    const operation = operationRef.current;
    stopRequestedRef.current = true;
    setPhase("transcribing");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (nativeMixedMode && ProsperoMixedSpeechModule) {
      void ProsperoMixedSpeechModule.stop()
        .then(async (result: MixedSpeechResult) => {
          let transcript: string;
          if (Platform.OS === "android") {
            const nativeTranscript = normalizeOfflineSpeechTranscript(
              result.transcript ?? "",
            );
            if (nativeTranscript.length > 0) {
              transcript = nativeTranscript;
              finishMixedRecognition(operation, transcript);
              return;
            }
            const audioFileUri = result.audioFileUri;
            if (!audioFileUri) {
              throw new Error("安卓版录音没有生成本地音频文件。");
            }
            try {
              transcript = await transcribeAndroidOfflineSpeech(
                audioFileUri,
                TECHNICAL_TERMS,
                (progress) => {
                  if (
                    mountedRef.current &&
                    operationRef.current === operation &&
                    !cancelledRef.current
                  ) {
                    setTranscriptionProgress(Math.round(progress));
                  }
                },
                (partial) => {
                  if (
                    mountedRef.current &&
                    operationRef.current === operation &&
                    !cancelledRef.current
                  ) {
                    setPreview(partial);
                  }
                },
              );
            } finally {
              await ProsperoMixedSpeechModule!.deleteRecording(audioFileUri);
            }
          } else {
            transcript = mergeBilingualSpeech(result, TECHNICAL_TERMS);
          }
          finishMixedRecognition(operation, transcript);
        })
        .catch((error: unknown) => {
          finishMixedRecognition(operation, "", error);
        });
    } else {
      ExpoSpeechRecognitionModule.stop();
    }
  }, [
    finishMixedRecognition,
    nativeMixedMode,
    setPhase,
  ]);

  const showPermissionHelp = useCallback(() => {
    Alert.alert(
      "需要麦克风权限",
      "Prospero 只在按住按钮时录音，并强制在设备上转写。请在系统设置中允许麦克风访问。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "打开设置",
          onPress: () => {
            void Linking.openSettings();
          },
        },
      ],
    );
  }, []);

  const downloadOfflineModel = useCallback(async () => {
    if (Platform.OS !== "android" || downloading) return;
    setDownloading(true);
    try {
      const availability = availabilityRef.current;
      const locales =
        availability.kind === "missing-model" &&
        availability.locales !== undefined &&
        availability.locales.length > 0
          ? availability.locales
          : [DEFAULT_VOICE_INPUT_LOCALE];
      const installed: VoiceInputLocale[] = [];
      for (const locale of locales) {
        const result =
          await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload(
            { locale },
          );
        if (!mountedRef.current) return;
        if (result.status === "download_scheduled") {
          toast(
            `系统已安排${offlineLocaleNames([locale])}模型下载；完成后会自动重新检查。`,
          );
          return;
        }
        if (result.status === "opened_dialog") {
          toast(`请在系统窗口中下载${offlineLocaleNames([locale])}离线语音包。`);
          return;
        }
        installed.push(locale);
      }
      toast(`${offlineLocaleNames(installed)}离线语音包已安装。`);
      await refreshAvailability();
    } catch {
      if (mountedRef.current)
        toast("无法下载离线语音包，请到系统语音设置中安装中文和英文。");
    } finally {
      if (mountedRef.current) setDownloading(false);
    }
  }, [downloading, refreshAvailability]);

  const explainAvailability = useCallback(
    (value = availabilityRef.current) => {
      if (value.kind === "checking") {
        toast("正在检查设备端语音识别…");
        return;
      }
      if (value.kind === "ready") {
        toast(
          samsungMixedMode
            ? "这台三星会优先使用系统中英端侧模型，失败时自动用应用内高精度模型。"
            : mixedMode
              ? "中英文可以直接混说；松开后会在设备端合并转写。"
              : "请按住麦克风说话，松开后转写到草稿。",
        );
        return;
      }
      if (value.kind === "missing-model") {
        if (appleMixedMode) {
          Alert.alert(
            "需要中英文离线语音模型",
            `${value.reason}\n\n模型由 iOS 下载，录音不会上传。`,
            [
              { text: "暂不", style: "cancel" },
              {
                text: "重试",
                onPress: () => {
                  void refreshAvailability();
                },
              },
            ],
          );
          return;
        }
        Alert.alert(
          mixedMode ? "需要中英文离线语音包" : "需要中文离线语音包",
          `${value.reason}\n\n音频不会上传，系统只会下载识别模型。`,
          [
            { text: "暂不", style: "cancel" },
            {
              text: "去下载",
              onPress: () => {
                void downloadOfflineModel();
              },
            },
          ],
        );
        return;
      }
      Alert.alert("无法使用离线语音输入", value.reason, [{ text: "知道了" }]);
    },
    [
      appleMixedMode,
      downloadOfflineModel,
      mixedMode,
      refreshAvailability,
      samsungMixedMode,
    ],
  );

  const beginRecognition = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    const operation = ++operationRef.current;
    longPressTriggeredRef.current = true;
    setPhase("starting");

    // The idle effect already performs the expensive model preparation. Do
    // not repeat that work on the push-to-talk hot path once it is ready.
    const current =
      availabilityRef.current.kind === "ready"
        ? availabilityRef.current
        : await inspectAvailability();
    if (!mountedRef.current) return;
    setAvailability(current);
    if (current.kind !== "ready") {
      setPhase("idle");
      if (holdingRef.current) explainAvailability(current);
      return;
    }

    if (!holdingRef.current) {
      setPhase("idle");
      return;
    }

    let permission =
      await ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync();
    let askedForPermission = false;
    if (!mountedRef.current) return;
    if (!holdingRef.current) {
      setPhase("idle");
      return;
    }
    if (!permission.granted) {
      askedForPermission = true;
      permission =
        await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync();
    }
    if (!mountedRef.current) return;
    if (!permission.granted) {
      setPhase("idle");
      showPermissionHelp();
      return;
    }

    // 权限弹窗会终止原来的触摸；必须要求用户重新按住，防止弹窗关闭后突然录音。
    if (!holdingRef.current) {
      setPhase("idle");
      if (askedForPermission) toast("麦克风已授权，请再次按住说话。");
      return;
    }

    cancelledRef.current = false;
    stopRequestedRef.current = false;
    clearRecognitionText();
    setCancelArmed(false);
    try {
      if (nativeMixedMode && ProsperoMixedSpeechModule) {
        await ProsperoMixedSpeechModule.start(TECHNICAL_TERMS);
        if (
          !mountedRef.current ||
          operationRef.current !== operation ||
          !holdingRef.current
        ) {
          await ProsperoMixedSpeechModule.abort();
          if (mountedRef.current) setPhase("idle");
          return;
        }
        activeRef.current = true;
        setPhase("recording");
      } else {
        activeRef.current = true;
        ExpoSpeechRecognitionModule.start({
          ...(usesAndroidMixedSpeech()
            ? androidMixedRecognitionOptions()
            : onDeviceRecognitionOptions(DEFAULT_VOICE_INPUT_LOCALE)),
          contextualStrings: TECHNICAL_TERMS,
        });
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      activeRef.current = false;
      setPhase("idle");
      toast(
        error instanceof Error
          ? error.message
          : "无法启动设备端语音识别。",
      );
    }
  }, [
    clearRecognitionText,
    explainAvailability,
    nativeMixedMode,
    setAvailability,
    setCancelArmed,
    setPhase,
    showPermissionHelp,
  ]);

  const onPressIn = useCallback(
    (event: { nativeEvent: { pageY: number } }) => {
      holdingRef.current = true;
      longPressTriggeredRef.current = false;
      startYRef.current = event.nativeEvent.pageY;
      setCancelArmed(false);
    },
    [setCancelArmed],
  );

  const onTouchMove = useCallback(
    (event: { nativeEvent: { pageY: number } }) => {
      if (!longPressTriggeredRef.current) return;
      const next =
        startYRef.current - event.nativeEvent.pageY >= CANCEL_DISTANCE;
      if (next !== cancelArmedRef.current) {
        setCancelArmed(next);
        if (next) void Haptics.selectionAsync();
      }
    },
    [setCancelArmed],
  );

  const onPressOut = useCallback(() => {
    holdingRef.current = false;
    if (!longPressTriggeredRef.current) return;

    if (activeRef.current) {
      if (cancelArmedRef.current) cancelRecognition();
      else stopRecognition();
    } else if (phaseRef.current === "starting") {
      setPhase("idle");
    }
  }, [cancelRecognition, setPhase, stopRecognition]);

  const onPress = useCallback(() => {
    if (longPressTriggeredRef.current) return;
    explainAvailability();
  }, [explainAvailability]);

  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;

  const unavailable = availability.kind !== "ready";
  const processing = phase === "transcribing" || phase === "cancelling";
  const active = phase === "starting" || phase === "recording";
  const languageName = mixedMode ? "中英混合" : "中文（普通话）";
  const languageBadge = mixedMode ? "中EN" : "中";
  const detectedLanguageName =
    detectedLanguage === "en"
      ? "English"
      : detectedLanguage === "zh"
        ? "中文"
        : null;
  const buttonColor =
    phase === "recording"
      ? color.danger
      : processing
        ? color.accent
        : unavailable
          ? color.warnBg
          : color.surfaceRaised;
  const iconColor = unavailable
    ? color.warn
    : phase === "recording"
      ? color.onAccent
      : processing
        ? color.onAccent
        : color.textDim;

  return (
    <View style={styles.wrapper}>
      {(active || processing) && (
        <View
          style={[styles.status, cancelArmed && styles.statusCancel]}
          pointerEvents="none"
        >
          {phase === "recording" ? (
            <VolumeBars volume={volume} cancel={cancelArmed} />
          ) : (
            <ActivityIndicator
              size="small"
              color={phase === "cancelling" ? color.warn : color.accent}
            />
          )}
          <View style={styles.statusCopy}>
            <Text
              style={[
                styles.statusTitle,
                cancelArmed && styles.statusTitleCancel,
              ]}
            >
              {phase === "starting"
                ? `正在启动${languageName}离线识别…`
                : phase === "recording"
                  ? cancelArmed
                    ? "松开取消"
                    : `正在聆听 · ${languageName}`
                  : phase === "cancelling"
                    ? "正在取消…"
                    : `转写中${transcriptionProgress > 0 ? ` ${String(transcriptionProgress)}%` : ""} · 点按取消`}
            </Text>
            {(phase === "recording" ||
              (phase === "transcribing" && preview.length > 0)) && (
              <Text style={styles.statusHint} numberOfLines={preview ? 1 : 2}>
                {phase === "transcribing"
                  ? preview
                  : preview ||
                    `${detectedLanguageName ? `已识别 ${detectedLanguageName} · ` : ""}松开转写 · 上滑取消`}
              </Text>
            )}
          </View>
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          processing
            ? "取消语音转写"
            : `${languageName}语音输入${unavailable ? "暂不可用" : ""}`
        }
        accessibilityHint={
          unavailable
            ? "点按查看当前语音识别不可用的原因"
            : "中英文可以混合说，按住录音，松开后把文字加入草稿"
        }
        accessibilityState={{
          disabled: availability.kind === "checking" || phase === "cancelling",
        }}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: buttonColor },
          pressed && phase === "idle" && styles.buttonPressed,
        ]}
        hitSlop={6}
        pressRetentionOffset={{ top: 140, bottom: 36, left: 56, right: 56 }}
        delayLongPress={180}
        disabled={availability.kind === "checking" || phase === "cancelling"}
        onPress={processing ? cancelRecognition : onPress}
        onPressIn={phase === "idle" ? onPressIn : undefined}
        onPressOut={phase === "idle" || active ? onPressOut : undefined}
        onLongPress={
          phase === "idle" ? () => void beginRecognition() : undefined
        }
        onTouchMove={phase === "idle" || active ? onTouchMove : undefined}
      >
        {downloading || phase === "starting" ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : (
          <Icon
            name={processing ? "xmark" : "mic.fill"}
            size={17}
            color={iconColor}
            weight="semibold"
          />
        )}
      </Pressable>
      <View
        style={[
          styles.languageBadge,
          unavailable && styles.languageBadgeUnavailable,
        ]}
        pointerEvents="none"
      >
        <Text style={styles.languageBadgeText}>{languageBadge}</Text>
      </View>
    </View>
  );
}

function VolumeBars({ volume, cancel }: { volume: number; cancel: boolean }) {
  const strength = Math.max(0, Math.min(1, (volume + 2) / 12));
  return (
    <View style={styles.bars}>
      {[0.35, 0.65, 1, 0.65, 0.35].map((weight, index) => (
        <View
          key={String(index)}
          style={[
            styles.bar,
            {
              height: 5 + strength * weight * 17,
              backgroundColor: cancel ? color.danger : color.accent,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { width: 36, height: 36, position: "relative" },
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: { opacity: 0.75 },
  languageBadge: {
    position: "absolute",
    right: -7,
    top: -5,
    minWidth: 24,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  languageBadgeUnavailable: {
    borderColor: color.warn,
    backgroundColor: color.warnBg,
  },
  languageBadgeText: {
    color: color.text,
    fontSize: 8,
    lineHeight: 10,
    fontWeight: "700",
  },
  status: {
    position: "absolute",
    right: 0,
    bottom: 45,
    width: 238,
    minHeight: 56,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    paddingVertical: 10,
    gap: 11,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
    zIndex: 20,
  },
  statusCancel: { borderColor: color.danger, backgroundColor: color.dangerBg },
  statusCopy: { flex: 1, minWidth: 0 },
  statusTitle: { color: color.text, fontSize: 13, fontWeight: "600" },
  statusTitleCancel: { color: color.danger },
  statusHint: { color: color.textDim, fontSize: 11, marginTop: 3 },
  bars: {
    width: 38,
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  bar: { width: 3, minHeight: 4, borderRadius: 2 },
});
