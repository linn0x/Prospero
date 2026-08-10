import AVFoundation
import CoreMedia
import ExpoModulesCore
import Foundation
import Speech

private enum MixedSpeechError: LocalizedError {
  case unavailable
  case modelsUnavailable
  case alreadyRecording
  case notRecording
  case invalidAudioFormat

  var errorDescription: String? {
    switch self {
    case .unavailable:
      return "这台设备不支持中英文混合离线识别。"
    case .modelsUnavailable:
      return "中英文离线语音模型尚未准备好。"
    case .alreadyRecording:
      return "语音识别已经在录音。"
    case .notRecording:
      return "当前没有正在进行的语音录音。"
    case .invalidAudioFormat:
      return "麦克风返回了无效的音频格式。"
    }
  }
}

private struct SpeechToken: Sendable {
  let text: String
  let start: Double
  let duration: Double
  let confidence: Double

  var dictionary: [String: Any] {
    [
      "text": text,
      "start": start,
      "duration": duration,
      "confidence": confidence,
    ]
  }
}

private struct DualTranscript: Sendable {
  let zh: [SpeechToken]
  let en: [SpeechToken]

  var dictionary: [String: Any] {
    [
      "zh": zh.map(\.dictionary),
      "en": en.map(\.dictionary),
    ]
  }
}

/**
 * AVAudioEngine 的 tap 在实时音频线程回调，不能把每个 buffer 跳进 Swift actor。
 * 这个小对象把文件写入限制在 tap 内；控制面仍由 MixedSpeechCoordinator actor 串行化。
 */
private final class SpeechAudioRecorder: @unchecked Sendable {
  private let engine = AVAudioEngine()
  private let url: URL
  private var audioFile: AVAudioFile?
  private var writeError: Error?
  private let errorLock = NSLock()
  private var active = false
  private var lastVolumeAt = 0.0

  init() {
    url = FileManager.default.temporaryDirectory
      .appendingPathComponent("prospero-mixed-\(UUID().uuidString)")
      .appendingPathExtension("caf")
  }

  func start(volume: @escaping @Sendable (Double) -> Void) throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .measurement,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
    try session.setActive(true)

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw MixedSpeechError.invalidAudioFormat
    }

    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    audioFile = file
    active = true
    lastVolumeAt = 0

    input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self, file] buffer, _ in
      guard let self else { return }
      do {
        try file.write(from: buffer)
      } catch {
        self.errorLock.lock()
        self.writeError = error
        self.errorLock.unlock()
      }

      let now = ProcessInfo.processInfo.systemUptime
      guard now - self.lastVolumeAt >= 0.1 else { return }
      self.lastVolumeAt = now
      volume(Self.scaledVolume(buffer))
    }

    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      active = false
      audioFile = nil
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      try? FileManager.default.removeItem(at: url)
      throw error
    }
  }

  func stop() throws -> URL {
    guard active else { throw MixedSpeechError.notRecording }
    active = false
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    audioFile = nil
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )

    errorLock.lock()
    let error = writeError
    errorLock.unlock()
    if let error { throw error }
    return url
  }

  func abort() {
    if active {
      active = false
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      audioFile = nil
      try? AVAudioSession.sharedInstance().setActive(
        false,
        options: .notifyOthersOnDeactivation
      )
    }
    try? FileManager.default.removeItem(at: url)
  }

  private static func scaledVolume(_ buffer: AVAudioPCMBuffer) -> Double {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return -2 }
    let samples = channels[0]
    let count = Int(buffer.frameLength)
    var peak: Float = 0
    for index in 0..<count {
      peak = max(peak, abs(samples[index]))
    }
    let decibels = 20 * log10(max(peak, 0.000_001))
    let normalized = min(max((decibels + 60) / 60, 0), 1)
    return Double(normalized * 12 - 2)
  }
}

private actor MixedSpeechCoordinator {
  private var modelsPrepared = false
  private var recorder: SpeechAudioRecorder?
  private var transcriptionTask: Task<DualTranscript, Error>?
  private var activeContextualStrings: [String] = []

  func prepare() async throws {
    guard #available(iOS 26.0, *), SpeechTranscriber.isAvailable else {
      throw MixedSpeechError.unavailable
    }
    if modelsPrepared { return }
    try await prepareModernModels()
    modelsPrepared = true
  }

  func start(
    contextualStrings: [String],
    volume: @escaping @Sendable (Double) -> Void
  ) async throws {
    guard recorder == nil, transcriptionTask == nil else {
      throw MixedSpeechError.alreadyRecording
    }
    try await prepare()
    let next = SpeechAudioRecorder()
    try next.start(volume: volume)
    activeContextualStrings = contextualStrings
    recorder = next
  }

  func stop() async throws -> [String: Any] {
    guard let recorder else { throw MixedSpeechError.notRecording }
    self.recorder = nil
    let contextualStrings = activeContextualStrings
    activeContextualStrings = []
    let url = try recorder.stop()

    guard #available(iOS 26.0, *) else {
      try? FileManager.default.removeItem(at: url)
      throw MixedSpeechError.unavailable
    }

    let task = Task.detached(priority: .userInitiated) {
      try await Self.transcribeModern(url: url, contextualStrings: contextualStrings)
    }
    transcriptionTask = task
    defer { transcriptionTask = nil }
    return try await task.value.dictionary
  }

  func abort() async {
    recorder?.abort()
    recorder = nil
    activeContextualStrings = []
    transcriptionTask?.cancel()
    transcriptionTask = nil
  }

  @available(iOS 26.0, *)
  private func prepareModernModels() async throws {
    let (zh, en, zhLocale, enLocale) = try await Self.makeTranscribers()
    let modules: [any SpeechModule] = [zh, en]

    if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
      try await request.downloadAndInstall()
    }
    guard await AssetInventory.status(forModules: modules) == .installed else {
      throw MixedSpeechError.modelsUnavailable
    }

    // 两个 locale 只占系统允许的五个保留位，避免系统在两次按住之间回收模型。
    _ = try? await AssetInventory.reserve(locale: zhLocale)
    _ = try? await AssetInventory.reserve(locale: enLocale)
  }

  @available(iOS 26.0, *)
  private nonisolated static func makeTranscribers() async throws -> (
    SpeechTranscriber,
    SpeechTranscriber,
    Locale,
    Locale
  ) {
    guard
      let zhLocale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: "zh-CN")
      ),
      let enLocale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: "en-US")
      )
    else {
      throw MixedSpeechError.modelsUnavailable
    }

    let attributes: Set<SpeechTranscriber.ResultAttributeOption> = [
      .audioTimeRange,
      .transcriptionConfidence,
    ]
    let zh = SpeechTranscriber(
      locale: zhLocale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: attributes
    )
    let en = SpeechTranscriber(
      locale: enLocale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: attributes
    )
    return (zh, en, zhLocale, enLocale)
  }

  @available(iOS 26.0, *)
  private nonisolated static func transcribeModern(
    url: URL,
    contextualStrings: [String]
  ) async throws -> DualTranscript {
    defer { try? FileManager.default.removeItem(at: url) }
    try Task.checkCancellation()

    let (zh, en, _, _) = try await makeTranscribers()
    let modules: [any SpeechModule] = [zh, en]
    let context = AnalysisContext()
    context.contextualStrings[.general] = Array(contextualStrings.prefix(100))
    let analyzer = SpeechAnalyzer(modules: modules)
    try await analyzer.setContext(context)
    let file = try AVAudioFile(forReading: url)

    return try await withTaskCancellationHandler {
      async let zhTokens = collectTokens(from: zh)
      async let enTokens = collectTokens(from: en)

      if let lastSampleTime = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: lastSampleTime)
      } else {
        await analyzer.cancelAndFinishNow()
      }
      try Task.checkCancellation()
      let (resolvedZh, resolvedEn) = try await (zhTokens, enTokens)
      return DualTranscript(zh: resolvedZh, en: resolvedEn)
    } onCancel: {
      Task { await analyzer.cancelAndFinishNow() }
    }
  }

  @available(iOS 26.0, *)
  private nonisolated static func collectTokens(
    from transcriber: SpeechTranscriber
  ) async throws -> [SpeechToken] {
    var tokens: [SpeechToken] = []
    for try await result in transcriber.results {
      try Task.checkCancellation()
      guard result.isFinal else { continue }
      for run in result.text.runs {
        let text = String(result.text[run.range].characters)
        let timeRange = run.audioTimeRange ?? result.range
        let start = CMTimeGetSeconds(timeRange.start)
        let duration = CMTimeGetSeconds(timeRange.duration)
        guard start.isFinite, duration.isFinite else { continue }
        tokens.append(
          SpeechToken(
            text: text,
            start: max(0, start),
            duration: max(0, duration),
            confidence: min(max(run.transcriptionConfidence ?? 0.5, 0), 1)
          )
        )
      }
    }
    return tokens
  }
}

public final class ProsperoMixedSpeechModule: Module {
  private let coordinator = MixedSpeechCoordinator()

  public func definition() -> ModuleDefinition {
    Name("ProsperoMixedSpeech")

    Events("onVolume")

    Function("isAvailable") {
      if #available(iOS 26.0, *) {
        return SpeechTranscriber.isAvailable
      }
      return false
    }

    AsyncFunction("prepare") { (promise: Promise) in
      Task {
        do {
          try await self.coordinator.prepare()
          promise.resolve(nil)
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("start") { (contextualStrings: [String], promise: Promise) in
      Task {
        do {
          try await self.coordinator.start(contextualStrings: contextualStrings) { [weak self] value in
            self?.sendEvent("onVolume", ["value": value])
          }
          promise.resolve(nil)
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      Task {
        do {
          let result = try await self.coordinator.stop()
          promise.resolve(result)
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("abort") { (promise: Promise) in
      Task {
        await self.coordinator.abort()
        promise.resolve(nil)
      }
    }

    OnDestroy {
      Task { await self.coordinator.abort() }
    }
  }
}
