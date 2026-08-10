/**
 * 语音输入的隐私边界集中在这里，方便测试防止以后误开在线识别。
 *
 * iOS 26+ 的主路径会并行运行中英文 SpeechTranscriber；Android 14+
 * 使用系统端侧识别器的自动语言切换。旧系统的单语言回退仍必须强制端侧处理。
 */
export const VOICE_INPUT_LOCALES = ["zh-CN", "en-US"] as const;
export type VoiceInputLocale = (typeof VOICE_INPUT_LOCALES)[number];
export const DEFAULT_VOICE_INPUT_LOCALE: VoiceInputLocale = "zh-CN";
export const ANDROID_MIXED_SPEECH_MIN_API = 34;

export function isVoiceInputLocale(value: unknown): value is VoiceInputLocale {
  return VOICE_INPUT_LOCALES.includes(value as VoiceInputLocale);
}

export function voiceInputLanguageName(locale: VoiceInputLocale): string {
  return locale === "en-US" ? "English (US)" : "中文（普通话）";
}

export function onDeviceRecognitionOptions(locale: VoiceInputLocale) {
  return {
    lang: locale,
    interimResults: true,
    maxAlternatives: 1,
    continuous: true,
    // 这是隐私硬边界；任何语言模型不可用时都必须失败，不能回退到云端。
    requiresOnDeviceRecognition: true,
    addsPunctuation: true,
    iosTaskHint: "dictation" as const,
    volumeChangeEventOptions: {
      enabled: true,
      intervalMillis: 100,
    },
  } as const;
}

export function supportsAndroidMixedSpeech(apiLevel: unknown): boolean {
  const parsed = Number(apiLevel);
  return Number.isFinite(parsed) && parsed >= ANDROID_MIXED_SPEECH_MIN_API;
}

/** Android 14+ 在同一次端侧识别中自动检测并切换中英文模型。 */
export function androidMixedRecognitionOptions() {
  return {
    ...onDeviceRecognitionOptions(DEFAULT_VOICE_INPUT_LOCALE),
    androidIntentOptions: {
      EXTRA_ENABLE_LANGUAGE_DETECTION: true,
      // 代码口述经常在一句中多次切换，优先快速响应。
      EXTRA_ENABLE_LANGUAGE_SWITCH: "quick_response" as const,
      EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES: [...VOICE_INPUT_LOCALES],
      EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES: [...VOICE_INPUT_LOCALES],
      EXTRA_ENABLE_BIASING_DEVICE_CONTEXT: true,
      EXTRA_LANGUAGE_MODEL: "free_form" as const,
    },
  };
}

/** 兼容旧调用与隐私回归测试；实际录音按用户选择动态生成。 */
export const ON_DEVICE_RECOGNITION_OPTIONS = onDeviceRecognitionOptions(
  DEFAULT_VOICE_INPUT_LOCALE,
);

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

export function missingVoiceInputLocales(
  installedLocales: readonly string[],
  requiredLocales: readonly VoiceInputLocale[] = VOICE_INPUT_LOCALES,
): VoiceInputLocale[] {
  return requiredLocales.filter(
    (locale) => !includesLocale(installedLocales, locale),
  );
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

export interface TimedSpeechToken {
  text: string;
  start: number;
  duration: number;
  confidence: number;
}

export interface BilingualSpeechCandidates {
  zh: readonly TimedSpeechToken[];
  en: readonly TimedSpeechToken[];
}

const HAN = /\p{Script=Han}/u;
const LATIN_WORD = /[A-Za-z][A-Za-z0-9+#.-]*/gu;
const SPOKEN_PUNCTUATION = /^[,.;:!?，。！？；：、)\]}]+$/u;
const COMMON_ENGLISH = new Set([
  "a", "add", "agent", "all", "and", "app", "are", "as", "at", "be",
  "branch", "build", "by", "can", "check", "code", "commit", "create",
  "daemon", "diff", "do", "error", "errors", "file", "files", "fix", "for",
  "from", "get", "git", "in", "install", "into", "is", "it", "lint", "mode",
  "need", "of", "on", "open", "plan", "please", "pull", "request", "resume",
  "run", "search", "start", "test", "tests", "that", "the", "this", "to",
  "type", "unit", "update", "use", "with", "workspace", "you",
]);

function cleanTokens(tokens: readonly TimedSpeechToken[]): TimedSpeechToken[] {
  return tokens
    .filter(
      (token) =>
        typeof token.text === "string" &&
        Number.isFinite(token.start) &&
        Number.isFinite(token.duration) &&
        Number.isFinite(token.confidence),
    )
    .map((token) => ({
      ...token,
      start: Math.max(0, token.start),
      duration: Math.max(0, token.duration),
      confidence: Math.max(0, Math.min(1, token.confidence)),
    }))
    .filter((token) => token.text.trim().length > 0)
    .sort((left, right) => left.start - right.start || left.duration - right.duration);
}

function vocabulary(terms: readonly string[]): Set<string> {
  const words = new Set(COMMON_ENGLISH);
  for (const term of terms) {
    for (const match of term.toLowerCase().matchAll(LATIN_WORD)) words.add(match[0]);
  }
  return words;
}

function tokenQuality(
  token: TimedSpeechToken,
  language: "zh" | "en",
  words: ReadonlySet<string>,
): number {
  const text = token.text.trim();
  if (SPOKEN_PUNCTUATION.test(text)) return 0.5;
  let quality = token.confidence;
  const latin = [...text.toLowerCase().matchAll(LATIN_WORD)].map((match) => match[0]);
  const knownLatin = latin.filter((word) => words.has(word)).length;

  if (language === "zh") {
    if (HAN.test(text)) quality += 0.08;
    if (latin.length > 0) {
      quality += knownLatin === latin.length ? 0.08 : -0.14;
    }
  } else {
    if (HAN.test(text)) quality -= 0.2;
    if (latin.length > 0) {
      quality += knownLatin === latin.length ? 0.12 : -0.06;
    }
  }
  return Math.max(0, Math.min(1.2, quality));
}

function segmentQuality(
  tokens: readonly TimedSpeechToken[],
  language: "zh" | "en",
  words: ReadonlySet<string>,
): number {
  const spoken = tokens.filter((token) => !SPOKEN_PUNCTUATION.test(token.text.trim()));
  if (spoken.length === 0) return -1;
  let weighted = 0;
  let totalWeight = 0;
  for (const token of spoken) {
    // 一个异常拉长到数秒的错误 token 不能吞掉后面的另一种语言。
    const weight = Math.max(0.08, Math.min(0.65, token.duration || 0.08));
    weighted += tokenQuality(token, language, words) * weight;
    totalWeight += weight;
  }
  return weighted / totalWeight;
}

function smartJoin(parts: readonly string[]): string {
  let output = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (!output) {
      output = part;
      continue;
    }
    if (SPOKEN_PUNCTUATION.test(part)) {
      output += part;
      continue;
    }
    const previous = output.at(-1) ?? "";
    const next = part[0] ?? "";
    if (HAN.test(next) && previous === ",") output = `${output.slice(0, -1)}，`;
    if (HAN.test(next) && previous === ".") output = `${output.slice(0, -1)}。`;
    const joinedPrevious = output.at(-1) ?? "";
    const noSpace =
      (HAN.test(joinedPrevious) && HAN.test(next)) ||
      (HAN.test(next) && /^[，。！？；：、]$/u.test(joinedPrevious)) ||
      /^[([{“‘]$/u.test(joinedPrevious) ||
      /^[,.;:!?，。！？；：、)\]}]/u.test(next);
    output += `${noSpace ? "" : " "}${part}`;
  }
  return output
    .replace(/\s+([,.;:!?，。！？；：、)\]}])/gu, "$1")
    .replace(/([([{“‘])\s+/gu, "$1")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function normalizeTechnicalTerms(text: string): string {
  return text
    .replace(/\btype\s*script\b/giu, "TypeScript")
    .replace(/\bjava\s*script\b/giu, "JavaScript")
    .replace(/\breact\s+native\b/giu, "React Native")
    .replace(/\bgit\s*hub\b/giu, "GitHub")
    .replace(/\bx\s*code\b/giu, "Xcode")
    .replace(/\bi\s*phone\b/giu, "iPhone")
    .replace(/\bcode\s*x\b/giu, "Codex")
    .replace(/\bgit\s+diff\b/giu, "Git diff")
    .replace(/\bget\s+diff\b/giu, "Git diff");
}

/** Cleans model-only control/noise markers without touching normal bracketed code. */
export function normalizeOfflineSpeechTranscript(text: string): string {
  return normalizeTechnicalTerms(
    text
      .replace(/<\|[^>]+\|>/gu, " ")
      .replace(
        /[[(（](?:blank[ _-]?audio|music|applause|laughter|silence|音乐|掌声|笑声|静音)[\])）]/giu,
        " ",
      )
      .replace(/\s+([,.;:!?，。！？；：、])/gu, "$1")
      .replace(/\s{2,}/gu, " ")
      .trim(),
  );
}

/**
 * 以高置信中文 token 为锚点，把锚点之间的音频交给整体质量更高的语言轨。
 * 两条轨使用同一录音的时间码，所以无需猜用户何时切换语言。
 */
export function mergeBilingualSpeech(
  candidates: BilingualSpeechCandidates,
  contextualTerms: readonly string[] = [],
): string {
  const zh = cleanTokens(candidates.zh);
  const en = cleanTokens(candidates.en);
  if (zh.length === 0 && en.length === 0) return "";
  const words = vocabulary(contextualTerms);

  const anchors = zh.filter(
    (token) => HAN.test(token.text) && token.confidence >= 0.88 && token.duration > 0,
  );
  const end = Math.max(
    0,
    ...zh.map((token) => token.start + token.duration),
    ...en.map((token) => token.start + token.duration),
  );
  const parts: string[] = [];
  let cursor = 0;

  const addGap = (start: number, finish: number): void => {
    if (finish <= start + 0.001) return;
    const inGap = (token: TimedSpeechToken): boolean =>
      token.start >= start - 0.015 && token.start < finish - 0.015;
    const zhGap = zh.filter(inGap);
    const enGap = en.filter(inGap);
    const zhScore = segmentQuality(zhGap, "zh", words);
    const enScore = segmentQuality(enGap, "en", words);
    const selected = enScore > zhScore + 0.025 ? enGap : zhGap.length > 0 ? zhGap : enGap;
    parts.push(...selected.map((token) => token.text));
  };

  for (const anchor of anchors) {
    if (anchor.start < cursor - 0.015) continue;
    addGap(cursor, anchor.start);
    parts.push(anchor.text);
    cursor = Math.max(cursor, anchor.start + anchor.duration);
  }
  addGap(cursor, end + 0.02);

  // 没有中文锚点时整段直接比较；上面的单一 gap 已经覆盖这一情况。
  return normalizeTechnicalTerms(smartJoin(parts));
}

export function voiceRecognitionErrorMessage(
  code: string,
  locale: VoiceInputLocale = DEFAULT_VOICE_INPUT_LOCALE,
): string {
  const language = locale === "en-US" ? "英文" : "中文";
  switch (code) {
    case "not-allowed":
      return "没有麦克风权限，请在系统设置中允许后重试。";
    case "language-not-supported":
      return `设备没有可用的${language}离线语音模型。`;
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
