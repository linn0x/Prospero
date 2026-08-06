/**
 * 语音输入的隐私边界集中在这里，方便测试防止以后误开在线识别。
 * App 当前界面与主要使用场景都是中文，因此首版固定使用普通话离线模型。
 */
export const VOICE_INPUT_LOCALE = "zh-CN";

export const ON_DEVICE_RECOGNITION_OPTIONS = {
  lang: VOICE_INPUT_LOCALE,
  interimResults: true,
  maxAlternatives: 1,
  continuous: true,
  requiresOnDeviceRecognition: true,
  addsPunctuation: true,
  iosTaskHint: "dictation",
  volumeChangeEventOptions: {
    enabled: true,
    intervalMillis: 100,
  },
} as const;

/** 把转写追加到用户此刻的草稿，绝不覆盖已经输入的内容。 */
export function appendVoiceTranscript(
  draft: string,
  transcript: string,
): string {
  const spoken = transcript.trim();
  if (spoken.length === 0) return draft;
  if (draft.length === 0) return spoken;

  const hasSeparator = /\s$/u.test(draft);
  const startsWithPunctuation = /^[,.;:!?，。！？；：、)\]}]/u.test(spoken);
  return `${draft}${hasSeparator || startsWithPunctuation ? "" : " "}${spoken}`;
}

interface LocaleParts {
  language: string;
  region?: string;
}

function localeParts(locale: string): LocaleParts | null {
  const parts = locale.trim().replaceAll("_", "-").toLowerCase().split("-");
  const language = parts[0];
  if (!language) return null;
  const region = parts.find(
    (part, index) =>
      index > 0 && (/^[a-z]{2}$/u.test(part) || /^\d{3}$/u.test(part)),
  );
  return region ? { language, region } : { language };
}

/** Android 返回的 BCP-47 标签可能省略 script/region，按语言与可用 region 匹配。 */
export function includesLocale(
  locales: readonly string[],
  target: string,
): boolean {
  const wanted = localeParts(target);
  if (!wanted) return false;

  return locales.some((locale) => {
    const candidate = localeParts(locale);
    if (!candidate || candidate.language !== wanted.language) return false;
    return (
      !candidate.region || !wanted.region || candidate.region === wanted.region
    );
  });
}

export function joinRecognitionSegments(
  segments: readonly string[],
  partial = "",
): string {
  return [...segments, partial]
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(" ")
    .trim();
}

export function voiceRecognitionErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
      return "没有麦克风权限，请在系统设置中允许后重试。";
    case "language-not-supported":
      return "设备没有可用的中文离线语音模型。";
    case "network":
      return "离线识别失败；Prospero 不会改用联网转写。";
    case "service-not-allowed":
      return "设备端语音识别服务不可用。";
    case "audio-capture":
      return "无法读取麦克风，请检查是否被其他 App 占用。";
    case "interrupted":
      return "语音输入被系统音频事件中断。";
    case "busy":
      return "语音识别器正忙，请稍后再试。";
    case "no-speech":
    case "speech-timeout":
      return "没有识别到语音。";
    default:
      return "语音转写失败，请重试。";
  }
}
