module.exports = {
  dependencies: {
    // iOS 继续使用系统 SpeechTranscriber；Whisper 只参与 Android 构建。
    "whisper.rn": {
      platforms: {
        ios: null,
      },
    },
  },
};
