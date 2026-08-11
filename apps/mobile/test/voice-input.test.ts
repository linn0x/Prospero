import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  androidMixedRecognitionOptions,
  ANDROID_MIXED_SPEECH_MIN_API,
  appendVoiceTranscript,
  includesLocale,
  joinRecognitionSegments,
  mergeBilingualSpeech,
  missingVoiceInputLocales,
  normalizeOfflineSpeechTranscript,
  ON_DEVICE_RECOGNITION_OPTIONS,
  shouldUseAndroidSystemSpeech,
  supportsAndroidMixedSpeech,
  voiceRecognitionErrorMessage,
} from "../src/lib/voice-input";

describe("语音输入隐私与草稿处理", () => {
  it("识别选项永久强制端侧处理", () => {
    expect(ON_DEVICE_RECOGNITION_OPTIONS.requiresOnDeviceRecognition).toBe(
      true,
    );
    expect(ON_DEVICE_RECOGNITION_OPTIONS.lang).toBe("zh-CN");
  });

  it("iOS 原生层在 locale 不支持端侧识别时失败关闭", () => {
    const requireFromTest = createRequire(import.meta.url);
    const packageRoot = dirname(
      requireFromTest.resolve("expo-speech-recognition/package.json"),
    );
    const swift = readFileSync(
      join(packageRoot, "ios", "ExpoSpeechRecognizer.swift"),
      "utf8",
    );
    expect(swift).toContain(
      "options.requiresOnDeviceRecognition && !recognizer.supportsOnDeviceRecognition",
    );
    expect(swift).toContain(
      "request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition",
    );
  });

  it("iOS 26 主路径对同一录音并行运行中英文端侧模型", () => {
    const swift = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "modules",
        "prospero-mixed-speech",
        "ios",
        "ProsperoMixedSpeechModule.swift",
      ),
      "utf8",
    );
    expect(swift).toContain("SpeechTranscriber");
    expect(swift).toContain('Locale(identifier: "zh-CN")');
    expect(swift).toContain('Locale(identifier: "en-US")');
    expect(swift).toContain("AssetInventory.assetInstallationRequest");
  });

  it("转写追加而不是覆盖已有草稿", () => {
    expect(appendVoiceTranscript("先修这个测试", "然后跑全量测试")).toBe(
      "先修这个测试 然后跑全量测试",
    );
    expect(appendVoiceTranscript("已有内容\n", "继续")).toBe("已有内容\n继续");
    expect(appendVoiceTranscript("", "  从语音开始  ")).toBe("从语音开始");
    expect(appendVoiceTranscript("不要覆盖", "   ")).toBe("不要覆盖");
  });

  it("标点开头的转写不会被插入多余空格", () => {
    expect(appendVoiceTranscript("第一步", "，再跑测试")).toBe(
      "第一步，再跑测试",
    );
  });

  it("识别 Android 返回的常见 BCP-47 离线语言标签", () => {
    expect(includesLocale(["en-US", "zh-CN"], "zh-CN")).toBe(true);
    expect(includesLocale(["zh_Hans_CN"], "zh-CN")).toBe(true);
    expect(includesLocale(["zh"], "zh-CN")).toBe(true);
    expect(includesLocale(["zh-TW"], "zh-CN")).toBe(false);
    expect(includesLocale([], "zh-CN")).toBe(false);
  });

  it("Android continuous 模式的分段与最后一个 partial 一起保留", () => {
    expect(
      joinRecognitionSegments(["把这个测试修一下", "然后"], "跑一遍 lint"),
    ).toBe("把这个测试修一下 然后 跑一遍 lint");
  });

  it("Android 14+ 强制端侧中英文自动检测与快速切换", () => {
    expect(supportsAndroidMixedSpeech(ANDROID_MIXED_SPEECH_MIN_API - 1)).toBe(
      false,
    );
    expect(supportsAndroidMixedSpeech(ANDROID_MIXED_SPEECH_MIN_API)).toBe(true);
    expect(
      shouldUseAndroidSystemSpeech(
        ANDROID_MIXED_SPEECH_MIN_API,
        true,
        true,
      ),
    ).toBe(true);
    expect(
      shouldUseAndroidSystemSpeech(
        ANDROID_MIXED_SPEECH_MIN_API - 1,
        true,
        true,
      ),
    ).toBe(false);
    expect(
      shouldUseAndroidSystemSpeech(
        ANDROID_MIXED_SPEECH_MIN_API,
        true,
        false,
      ),
    ).toBe(false);
    const options = androidMixedRecognitionOptions();
    expect(options.requiresOnDeviceRecognition).toBe(true);
    expect(options.lang).toBe("zh-CN");
    expect(options.androidIntentOptions).toMatchObject({
      EXTRA_ENABLE_LANGUAGE_DETECTION: true,
      EXTRA_ENABLE_LANGUAGE_SWITCH: "quick_response",
      EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES: ["zh-CN", "en-US"],
      EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES: ["zh-CN", "en-US"],
      EXTRA_ENABLE_BIASING_DEVICE_CONTEXT: true,
    });
  });

  it("Whisper 回退使用 small 高准确率模型并在录音前预热", () => {
    const offlineSpeech = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "src",
        "lib",
        "android-offline-speech.ts",
      ),
      "utf8",
    );
    const voiceButton = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "src",
        "components",
        "VoiceButton.tsx",
      ),
      "utf8",
    );
    expect(offlineSpeech).toContain('MODEL_ASSET = "ggml-small-q5_1.bin"');
    expect(offlineSpeech).toContain("useFlashAttn: false");
    expect(offlineSpeech).toContain("beamSize: 5");
    expect(offlineSpeech).toContain("bestOf: 5");
    expect(offlineSpeech).toContain("temperatureInc: 0.2");
    expect(voiceButton).toContain("prepareAndroidOfflineSpeech()");
    expect(voiceButton).toContain("!usesAndroidMixedSpeech()");
    expect(voiceButton).toContain(
      'availabilityRef.current.kind === "ready"',
    );
  });

  it("三星优先走明确锁定为本地的中英双语服务并保留 Whisper 回退", () => {
    const samsung = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "modules",
        "prospero-mixed-speech",
        "android",
        "src",
        "main",
        "java",
        "com",
        "linn0x",
        "prospero",
        "mixedspeech",
        "SamsungIntelliVoiceSession.kt",
      ),
      "utf8",
    );
    const nativeModule = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "modules",
        "prospero-mixed-speech",
        "android",
        "src",
        "main",
        "java",
        "com",
        "linn0x",
        "prospero",
        "mixedspeech",
        "ProsperoMixedSpeechModule.kt",
      ),
      "utf8",
    );

    expect(samsung).toContain("CONNECTION_LOCAL = 1");
    expect(samsung).toContain(
      "putInt(KEY_CONNECTION_TYPE, CONNECTION_LOCAL)",
    );
    expect(samsung).toContain('Locale.forLanguageTag("zh-CN")');
    expect(samsung).toContain('Locale.forLanguageTag("en-US")');
    expect(samsung).toContain("putBoolean(KEY_ENABLED_MULTILINGUAL, true)");
    expect(nativeModule).toContain("SamsungIntelliVoiceSession.probe(context)");
    expect(nativeModule).toContain("samsungAccessAllowed = false");
    expect(nativeModule).toContain('"engine" to "whisper"');
    expect(nativeModule).toContain('"engine" to "samsung"');
  });

  it("Android 会分别找出未安装的中英文离线模型", () => {
    expect(missingVoiceInputLocales(["zh_Hans_CN"])).toEqual(["en-US"]);
    expect(missingVoiceInputLocales(["zh-CN", "en_US"])).toEqual([]);
  });

  it("按时间码和置信度合并中英文混说，而不是整句固定一种语言", () => {
    const transcript = mergeBilingualSpeech(
      {
        zh: [
          { text: "请", start: 0, duration: 0.2, confidence: 0.99 },
          { text: "帮", start: 0.2, duration: 0.2, confidence: 0.99 },
          { text: "我", start: 0.4, duration: 0.2, confidence: 0.99 },
          { text: " uneed", start: 0.6, duration: 0.6, confidence: 0.58 },
          { text: " trests，", start: 1.2, duration: 0.5, confidence: 0.51 },
          { text: "然", start: 1.7, duration: 0.2, confidence: 0.99 },
          { text: "后", start: 1.9, duration: 0.2, confidence: 0.99 },
          { text: " fixtypescript", start: 2.1, duration: 0.7, confidence: 0.64 },
          { text: " ereres", start: 2.8, duration: 0.5, confidence: 0.42 },
          { text: "再", start: 3.3, duration: 0.2, confidence: 0.96 },
          { text: "检", start: 3.5, duration: 0.2, confidence: 0.99 },
          { text: "查", start: 3.7, duration: 0.2, confidence: 0.99 },
          { text: " Gtive", start: 3.9, duration: 0.6, confidence: 0.55 },
        ],
        en: [
          { text: "Ching", start: 0, duration: 0.3, confidence: 0.3 },
          { text: " bong", start: 0.3, duration: 0.3, confidence: 0.2 },
          { text: " run", start: 0.6, duration: 0.3, confidence: 0.94 },
          { text: " the", start: 0.9, duration: 0.25, confidence: 0.92 },
          { text: " unit", start: 1.15, duration: 0.3, confidence: 0.95 },
          { text: " tests,", start: 1.45, duration: 0.25, confidence: 0.94 },
          { text: "Young", start: 1.7, duration: 0.4, confidence: 0.32 },
          { text: " fix", start: 2.1, duration: 0.3, confidence: 0.95 },
          { text: " type", start: 2.4, duration: 0.3, confidence: 0.94 },
          { text: " script", start: 2.7, duration: 0.3, confidence: 0.94 },
          { text: " errors", start: 3, duration: 0.3, confidence: 0.93 },
          { text: "Zai", start: 3.3, duration: 0.3, confidence: 0.25 },
          { text: " git", start: 3.9, duration: 0.3, confidence: 0.96 },
          { text: " diff", start: 4.2, duration: 0.3, confidence: 0.96 },
        ],
      },
      ["TypeScript", "Git diff", "unit tests"],
    );

    expect(transcript).toBe(
      "请帮我 run the unit tests，然后 fix TypeScript errors 再检查 Git diff",
    );
  });

  it("纯中文和纯英文也会选择各自置信度更高的轨道", () => {
    expect(
      mergeBilingualSpeech({
        zh: [{ text: "继续修复", start: 0, duration: 1, confidence: 0.97 }],
        en: [{ text: "Gee show", start: 0, duration: 1, confidence: 0.2 }],
      }),
    ).toBe("继续修复");
    expect(
      mergeBilingualSpeech({
        zh: [{ text: " 软得测试", start: 0, duration: 1, confidence: 0.25 }],
        en: [{ text: " run the tests", start: 0, duration: 1, confidence: 0.96 }],
      }),
    ).toBe("run the tests");
  });

  it("清理 Whisper 控制标记并保留技术词拼写", () => {
    expect(
      normalizeOfflineSpeechTranscript(
        "<|zh|> 请 run type script tests [BLANK_AUDIO]，然后 git hub commit",
      ),
    ).toBe("请 run TypeScript tests，然后 GitHub commit");
  });

  it("清理模型标记时不破坏普通方括号代码", () => {
    expect(normalizeOfflineSpeechTranscript("检查 array[index] 和 foo(bar)"))
      .toBe("检查 array[index] 和 foo(bar)");
  });

  it("网络错误明确说明不会在线回退", () => {
    expect(voiceRecognitionErrorMessage("network")).toContain(
      "不会改用联网转写",
    );
  });
});
