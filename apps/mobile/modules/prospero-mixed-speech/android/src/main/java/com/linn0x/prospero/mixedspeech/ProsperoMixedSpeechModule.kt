package com.linn0x.prospero.mixedspeech

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

private const val MODEL_ASSET = "ggml-small-q5_1.bin"
private const val SAMPLE_RATE = 16_000
private const val CHANNEL_COUNT = 1
private const val BITS_PER_SAMPLE = 16
private const val VOLUME_EVENT_INTERVAL_MS = 100L
private const val RECORDING_PREFIX = "prospero-mixed-"

private data class AndroidSpeechRecording(
  val file: File,
  val durationSeconds: Double,
)

/** Records the microphone as the mono 16 kHz PCM WAV expected by whisper.cpp. */
private class AndroidPcmRecorder(
  private val context: Context,
  private val onVolume: (Double) -> Unit,
) {
  private val pcmFile = File(context.cacheDir, "$RECORDING_PREFIX${UUID.randomUUID()}.pcm")
  private val wavFile = File(context.cacheDir, "$RECORDING_PREFIX${UUID.randomUUID()}.wav")
  private val failure = AtomicReference<Throwable?>(null)

  @Volatile
  private var recording = false

  @Volatile
  private var bytesWritten = 0L

  private var audioRecord: AudioRecord? = null
  private var recordingThread: Thread? = null

  @SuppressLint("MissingPermission")
  fun start() {
    check(
      context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    ) { "Prospero 没有麦克风权限。" }

    val minimumBuffer = AudioRecord.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    check(minimumBuffer > 0) { "这台设备无法创建 16 kHz 麦克风输入。" }
    val bufferSize = max(minimumBuffer * 2, 3_200)
    val next = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      bufferSize,
    )
    check(next.state == AudioRecord.STATE_INITIALIZED) {
      next.release()
      "无法初始化麦克风。"
    }

    try {
      next.startRecording()
      check(next.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
        "麦克风没有开始录音。"
      }
    } catch (error: Throwable) {
      next.release()
      throw error
    }

    audioRecord = next
    recording = true
    recordingThread = thread(
      start = true,
      isDaemon = true,
      name = "ProsperoMixedSpeechRecorder",
    ) {
      recordLoop(next, bufferSize)
    }
  }

  fun stop(): AndroidSpeechRecording {
    stopCapture()
    failure.get()?.let { error ->
      pcmFile.delete()
      wavFile.delete()
      throw IOException("录音时读取麦克风失败。", error)
    }
    check(bytesWritten > 0) { "没有录到音频。" }
    writeWavFile()
    return AndroidSpeechRecording(
      file = wavFile,
      durationSeconds = bytesWritten.toDouble() / (SAMPLE_RATE * 2.0),
    )
  }

  fun abort() {
    stopCapture()
    pcmFile.delete()
    wavFile.delete()
  }

  private fun stopCapture() {
    recording = false
    val activeRecord = audioRecord
    if (activeRecord != null) {
      runCatching {
        if (activeRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          activeRecord.stop()
        }
      }
    }

    val worker = recordingThread
    if (worker != null && worker !== Thread.currentThread()) {
      runCatching { worker.join(2_000) }
      if (worker.isAlive) {
        worker.interrupt()
        runCatching { worker.join(500) }
      }
    }
    runCatching { activeRecord?.release() }
    audioRecord = null
    recordingThread = null
  }

  private fun recordLoop(activeRecord: AudioRecord, bufferSize: Int) {
    val buffer = ByteArray(bufferSize)
    var totalBytes = 0L
    var lastVolumeAt = 0L

    try {
      BufferedOutputStream(FileOutputStream(pcmFile)).use { output ->
        while (recording) {
          val read = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            activeRecord.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
          } else {
            @Suppress("DEPRECATION")
            activeRecord.read(buffer, 0, buffer.size)
          }

          when {
            read > 0 -> {
              output.write(buffer, 0, read)
              totalBytes += read
              bytesWritten = totalBytes
              val now = SystemClock.elapsedRealtime()
              if (now - lastVolumeAt >= VOLUME_EVENT_INTERVAL_MS) {
                lastVolumeAt = now
                onVolume(scaledVolume(buffer, read))
              }
            }

            read == 0 -> Thread.yield()
            !recording -> break
            else -> throw IOException("AudioRecord.read returned $read")
          }
        }
      }
    } catch (error: Throwable) {
      if (recording) failure.compareAndSet(null, error)
    } finally {
      bytesWritten = totalBytes
    }
  }

  private fun writeWavFile() {
    val audioLength = pcmFile.length()
    val totalDataLength = 36L + audioLength
    check(totalDataLength <= Int.MAX_VALUE) { "录音过长。" }
    val byteRate = SAMPLE_RATE * CHANNEL_COUNT * BITS_PER_SAMPLE / 8
    val blockAlign = CHANNEL_COUNT * BITS_PER_SAMPLE / 8

    try {
      DataOutputStream(BufferedOutputStream(FileOutputStream(wavFile))).use { output ->
        output.writeBytes("RIFF")
        output.writeInt(Integer.reverseBytes(totalDataLength.toInt()))
        output.writeBytes("WAVE")
        output.writeBytes("fmt ")
        output.writeInt(Integer.reverseBytes(16))
        output.writeShort(java.lang.Short.reverseBytes(1.toShort()).toInt())
        output.writeShort(java.lang.Short.reverseBytes(CHANNEL_COUNT.toShort()).toInt())
        output.writeInt(Integer.reverseBytes(SAMPLE_RATE))
        output.writeInt(Integer.reverseBytes(byteRate))
        output.writeShort(java.lang.Short.reverseBytes(blockAlign.toShort()).toInt())
        output.writeShort(java.lang.Short.reverseBytes(BITS_PER_SAMPLE.toShort()).toInt())
        output.writeBytes("data")
        output.writeInt(Integer.reverseBytes(audioLength.toInt()))
        BufferedInputStream(FileInputStream(pcmFile)).use { input ->
          input.copyTo(output)
        }
      }
    } finally {
      pcmFile.delete()
    }
  }

  private fun scaledVolume(buffer: ByteArray, size: Int): Double {
    var sumSquares = 0.0
    var sampleCount = 0
    var index = 0
    while (index + 1 < size) {
      val sample = (
        (buffer[index].toInt() and 0xff) or
          (buffer[index + 1].toInt() shl 8)
        ).toShort().toDouble()
      sumSquares += sample * sample
      sampleCount += 1
      index += 2
    }
    if (sampleCount == 0) return -2.0
    val rms = sqrt(sumSquares / sampleCount) / Short.MAX_VALUE
    val decibels = 20.0 * log10(max(rms, 0.000_001))
    val normalized = min(max((decibels + 60.0) / 60.0, 0.0), 1.0)
    return normalized * 12.0 - 2.0
  }
}

class ProsperoMixedSpeechModule : Module() {
  private val stateLock = Any()
  private var activeRecorder: AndroidPcmRecorder? = null
  private var lastRecording: File? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ProsperoMixedSpeech")

    Events("onVolume")

    Function("isAvailable") {
      hasBundledModel()
    }

    AsyncFunction<Unit>("prepare") {
      check(hasBundledModel()) {
        "安卓版离线语音模型不完整，请重新构建并安装完整 APK。"
      }
    }

    AsyncFunction("start") { _: List<String> ->
      val next = AndroidPcmRecorder(context) { value ->
        if (appContext.hasActiveReactInstance) {
          sendEvent("onVolume", mapOf("value" to value))
        }
      }
      synchronized(stateLock) {
        check(activeRecorder == null) { "语音识别已经在录音。" }
        lastRecording?.delete()
        lastRecording = null
        activeRecorder = next
      }
      try {
        next.start()
      } catch (error: Throwable) {
        synchronized(stateLock) {
          if (activeRecorder === next) activeRecorder = null
        }
        next.abort()
        throw error
      }
    }

    AsyncFunction("stop") {
      val current = synchronized(stateLock) {
        activeRecorder?.also { activeRecorder = null }
      } ?: error("当前没有正在进行的语音录音。")
      val result = current.stop()
      synchronized(stateLock) {
        lastRecording?.delete()
        lastRecording = result.file
      }
      mapOf(
        "zh" to emptyList<Map<String, Any>>(),
        "en" to emptyList<Map<String, Any>>(),
        "audioFileUri" to Uri.fromFile(result.file).toString(),
        "duration" to result.durationSeconds,
      )
    }

    AsyncFunction("deleteRecording") { uri: String ->
      val requestedPath = Uri.parse(uri).path
      synchronized(stateLock) {
        val recording = lastRecording
        if (recording != null && recording.absolutePath == requestedPath) {
          recording.delete()
          lastRecording = null
        }
      }
    }

    AsyncFunction<Unit>("abort") {
      abortAndDelete()
    }

    OnDestroy {
      abortAndDelete()
    }
  }

  private fun hasBundledModel(): Boolean = runCatching {
    context.assets.open(MODEL_ASSET).use { input ->
      val header = ByteArray(4)
      input.read(header) == header.size
    }
  }.getOrDefault(false)

  private fun abortAndDelete() {
    val (recorder, recording) = synchronized(stateLock) {
      val values = activeRecorder to lastRecording
      activeRecorder = null
      lastRecording = null
      values
    }
    recorder?.abort()
    recording?.delete()
  }
}
