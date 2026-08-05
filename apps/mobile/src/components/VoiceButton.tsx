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
import { Icon } from "@/components/Icon";
import { toast } from "@/components/Toast";
import {
  includesLocale,
  joinRecognitionSegments,
  ON_DEVICE_RECOGNITION_OPTIONS,
  VOICE_INPUT_LOCALE,
  voiceRecognitionErrorMessage,
} from "@/lib/voice-input";

type Phase = "idle" | "starting" | "recording" | "transcribing" | "cancelling";
type Availability =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "missing-model"; reason: string }
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
];

async function inspectAvailability(): Promise<Availability> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { kind: "unsupported", reason: "当前平台不支持设备端语音输入。" };
  }

  try {
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
      if (!includesLocale(supported.locales, VOICE_INPUT_LOCALE)) {
        return {
          kind: "unsupported",
          reason: "这台设备的端侧语音识别不支持简体中文。",
        };
      }
      if (!includesLocale(supported.installedLocales, VOICE_INPUT_LOCALE)) {
        return {
          kind: "missing-model",
          reason: "需要先安装系统的简体中文离线语音包。",
        };
      }
    }

    return { kind: "ready" };
  } catch {
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
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [availability, setAvailabilityState] = useState<Availability>({
    kind: "checking",
  });
  const [cancelArmed, setCancelArmedState] = useState(false);
  const [volume, setVolume] = useState(-2);
  const [preview, setPreview] = useState("");
  const [downloading, setDownloading] = useState(false);

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
      setVolume(-2);
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
      if (activeRef.current) {
        cancelledRef.current = true;
        ExpoSpeechRecognitionModule.abort();
      }
    };
  }, [refreshAvailability]);

  // Android 模型下载和 iOS 系统设置都可能切走 App；回来时重新检测能力。
  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && availabilityRef.current.kind !== "ready") {
        void refreshAvailability();
      }
    });
    return () => subscription.remove();
  }, [refreshAvailability]);

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
        reason: "简体中文端侧语音模型不可用；Prospero 不会改用在线识别。",
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

  const cancelRecognition = useCallback(() => {
    if (!activeRef.current || cancelledRef.current) return;
    cancelledRef.current = true;
    setPhase("cancelling");
    clearRecognitionText();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    ExpoSpeechRecognitionModule.abort();
  }, [clearRecognitionText, setPhase]);

  const stopRecognition = useCallback(() => {
    if (!activeRef.current || cancelledRef.current) return;
    stopRequestedRef.current = true;
    setPhase("transcribing");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    ExpoSpeechRecognitionModule.stop();
  }, [setPhase]);

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
      const result =
        await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({
          locale: VOICE_INPUT_LOCALE,
        });
      if (!mountedRef.current) return;
      if (result.status === "download_success") {
        toast("中文离线语音包已安装。");
        await refreshAvailability();
      } else if (result.status === "download_scheduled") {
        toast("系统已安排下载；完成后语音按钮会自动启用。");
      } else {
        toast("请在系统窗口中下载中文离线语音包。");
      }
    } catch {
      if (mountedRef.current)
        toast("无法打开离线语音包下载，请到系统语音设置中安装。");
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
        toast("请按住麦克风说话，松开后转写到草稿。");
        return;
      }
      if (value.kind === "missing-model") {
        Alert.alert(
          "需要中文离线语音包",
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
    [downloadOfflineModel],
  );

  const beginRecognition = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    longPressTriggeredRef.current = true;
    setPhase("starting");

    const current = await inspectAvailability();
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
    activeRef.current = true;
    clearRecognitionText();
    setCancelArmed(false);
    try {
      ExpoSpeechRecognitionModule.start({
        ...ON_DEVICE_RECOGNITION_OPTIONS,
        contextualStrings: TECHNICAL_TERMS,
      });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      activeRef.current = false;
      setPhase("idle");
      toast("无法启动设备端语音识别。");
    }
  }, [
    clearRecognitionText,
    explainAvailability,
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
  const buttonColor =
    phase === "recording"
      ? "#a9363e"
      : processing
        ? "#3557b7"
        : unavailable
          ? "#2d2920"
          : "#24242c";
  const iconColor = unavailable
    ? "#9b8754"
    : phase === "recording"
      ? "#fff"
      : "#c8c8d2";

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
              color={phase === "cancelling" ? "#d9a441" : "#7aa2f7"}
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
                ? "正在启动离线识别…"
                : phase === "recording"
                  ? cancelArmed
                    ? "松开取消"
                    : "正在聆听…"
                  : phase === "cancelling"
                    ? "正在取消…"
                    : "转写中… 点按取消"}
            </Text>
            {phase === "recording" && (
              <Text style={styles.statusHint} numberOfLines={preview ? 1 : 2}>
                {preview || "松开转写 · 上滑取消"}
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
            : unavailable
              ? "语音输入不可用"
              : "按住进行语音输入"
        }
        accessibilityHint={
          unavailable ? "点按查看原因" : "按住说话，松开后把文字加入草稿"
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
        delayLongPress={260}
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
              backgroundColor: cancel ? "#e5534b" : "#7aa2f7",
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
  status: {
    position: "absolute",
    right: 0,
    bottom: 45,
    width: 238,
    minHeight: 56,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#343441",
    backgroundColor: "#1c1c24",
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
  statusCancel: { borderColor: "#7d3338", backgroundColor: "#2b191c" },
  statusCopy: { flex: 1, minWidth: 0 },
  statusTitle: { color: "#e8e8ee", fontSize: 13, fontWeight: "600" },
  statusTitleCancel: { color: "#ff9a9f" },
  statusHint: { color: "#8a8a96", fontSize: 11, marginTop: 3 },
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
