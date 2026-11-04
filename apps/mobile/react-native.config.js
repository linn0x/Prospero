module.exports = {
  dependencies: {
    // iOS 使用系统 SpeechTranscriber；Android 使用系统/厂商端侧语音识别，不打包内置 Whisper 模型。
    "whisper.rn": {
      platforms: {
        ios: null,
        android: null,
      },
    },
  },
};
