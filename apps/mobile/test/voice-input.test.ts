import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendVoiceTranscript,
  includesLocale,
  joinRecognitionSegments,
  ON_DEVICE_RECOGNITION_OPTIONS,
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

  it("网络错误明确说明不会在线回退", () => {
    expect(voiceRecognitionErrorMessage("network")).toContain(
      "不会改用联网转写",
    );
  });
});
