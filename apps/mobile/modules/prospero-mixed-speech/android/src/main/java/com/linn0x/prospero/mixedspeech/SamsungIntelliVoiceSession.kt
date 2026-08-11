package com.linn0x.prospero.mixedspeech

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.util.Log
import com.samsung.android.sivs.ai.sdkcommon.asr.IRecognitionListener
import com.samsung.android.sivs.ai.sdkcommon.asr.ISpeechRecognizer
import com.samsung.android.sivs.ai.sdkcommon.asr.ISpeechRecognizerService
import java.io.OutputStream
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal data class SamsungSpeechResult(
  val transcript: String?,
  val errorMessage: String?,
)

/**
 * Streams the same 16 kHz PCM that we retain for Whisper to Samsung's exported
 * IntelliVoice recognizer. The configuration pins connection_type to LOCAL;
 * a rejected/failed session simply leaves the WAV available for Whisper.
 */
internal class SamsungIntelliVoiceSession private constructor(
  context: Context,
  private val onPartial: (String) -> Unit,
) {
  private val appContext = context.applicationContext
  private val serviceExecutor: ExecutorService =
    Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "ProsperoSamsungSpeechService").apply { isDaemon = true }
    }
  private val bindLatch = CountDownLatch(1)
  private val finalLatch = CountDownLatch(1)
  private val service = AtomicReference<ISpeechRecognizerService?>(null)
  private val recognizer = AtomicReference<ISpeechRecognizer?>(null)
  private val transcript = AtomicReference<String?>(null)
  private val failure = AtomicReference<String?>(null)
  private val closed = AtomicBoolean(false)
  private val outputLock = Any()

  @Volatile
  private var bound = false

  private var audioOutput: OutputStream? = null

  private val listener = object : IRecognitionListener.Stub() {
    override fun onError(error: Bundle?) {
      val code = error?.getInt(KEY_ERROR_CODE, -1) ?: -1
      val message = error?.getString(KEY_ERROR_MESSAGE)?.trim().orEmpty()
      failure.compareAndSet(
        null,
        if (message.isNotEmpty()) "三星端侧识别失败（$code）：$message" else "三星端侧识别失败（$code）。",
      )
      finalLatch.countDown()
    }

    override fun onResults(results: Bundle?) {
      extractTranscript(results)?.let(transcript::set)
      finalLatch.countDown()
    }

    override fun onPartialResults(results: Bundle?) {
      extractTranscript(results)?.let { partial ->
        if (!closed.get()) onPartial(partial)
      }
    }
  }

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      service.set(ISpeechRecognizerService.Stub.asInterface(binder))
      bindLatch.countDown()
    }

    override fun onServiceDisconnected(name: ComponentName?) {
      service.set(null)
      if (!closed.get()) {
        failure.compareAndSet(null, "三星端侧识别服务已断开。")
        finalLatch.countDown()
      }
    }

    override fun onBindingDied(name: ComponentName?) {
      onServiceDisconnected(name)
      bindLatch.countDown()
    }

    override fun onNullBinding(name: ComponentName?) {
      failure.compareAndSet(null, "三星端侧识别服务拒绝连接。")
      bindLatch.countDown()
      finalLatch.countDown()
    }
  }

  companion object {
    private const val TAG = "ProsperoSamsungSpeech"
    private const val SERVICE_PACKAGE = "com.samsung.android.intellivoiceservice"
    private const val SERVICE_ACTION = "android.intellivoiceservice.speech.RecognitionService"
    private const val BIND_TIMEOUT_SECONDS = 3L
    private const val RESULT_TIMEOUT_SECONDS = 12L
    private const val SOURCE_SAMPLE_RATE = 16_000

    private const val KEY_CALLER_PACKAGE = "caller_package"
    private const val KEY_CONNECTION_TYPE = "connection_type"
    private const val KEY_LOCALE = "locale"
    private const val KEY_ENABLED_PARTIAL = "enabled_partial"
    private const val KEY_ENABLED_MULTILINGUAL = "enabled_multilingual"
    private const val KEY_PREFERRED_LOCALES = "preferred_locales"
    private const val KEY_SOURCE_SAMPLE_RATE = "source_sample_rate"
    private const val KEY_DELIVER_METADATA = "deliver_metadata_on_arrival"
    private const val KEY_METADATA_TYPE = "result_metadata_type"
    private const val KEY_RESULT = "result"
    private const val KEY_IMMUTABLE = "result_immutable_sentence"
    private const val KEY_MUTABLE = "result_mutable_sentence"
    private const val KEY_ERROR_CODE = "error_code"
    private const val KEY_ERROR_MESSAGE = "error_message"
    private const val METADATA_LID = "lid"
    private const val CONNECTION_LOCAL = 1

    fun isAvailable(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
      if (!Build.MANUFACTURER.equals("samsung", ignoreCase = true)) return false
      val intent = serviceIntent()
      return runCatching {
        context.packageManager.resolveService(intent, PackageManager.MATCH_ALL) != null
      }.getOrDefault(false)
    }

    fun open(context: Context, onPartial: (String) -> Unit): SamsungIntelliVoiceSession {
      check(isAvailable(context)) { "这台设备没有三星 IntelliVoice 端侧识别服务。" }
      return SamsungIntelliVoiceSession(context, onPartial).also { it.connectAndStart() }
    }

    /** Verifies Samsung's firmware-level access policy before showing this engine as usable. */
    fun probe(context: Context): Boolean {
      var session: SamsungIntelliVoiceSession? = null
      return try {
        session = open(context) {}
        true
      } catch (error: Throwable) {
        Log.i(TAG, "Samsung IntelliVoice access probe rejected; using bundled Whisper")
        false
      } finally {
        session?.abort()
      }
    }

    private fun serviceIntent(): Intent = Intent(SERVICE_ACTION).setPackage(SERVICE_PACKAGE)

    private fun extractTranscript(bundle: Bundle?): String? {
      if (bundle == null || bundle.getString(KEY_METADATA_TYPE) == METADATA_LID) return null
      bundle.getString(KEY_RESULT)?.trim()?.takeIf(String::isNotEmpty)?.let { return it }
      val segments = buildList {
        bundle.getStringArrayList(KEY_IMMUTABLE)?.let(::addAll)
        bundle.getStringArrayList(KEY_MUTABLE)?.let(::addAll)
      }
      return segments
        .asSequence()
        .map(String::trim)
        .filter(String::isNotEmpty)
        .joinToString(" ")
        .trim()
        .takeIf(String::isNotEmpty)
    }
  }

  @SuppressLint("NewApi")
  private fun connectAndStart() {
    try {
      bound = appContext.bindService(
        serviceIntent(),
        Context.BIND_AUTO_CREATE,
        serviceExecutor,
        connection,
      )
      check(bound) { "无法连接三星端侧识别服务。" }
      check(bindLatch.await(BIND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
        "连接三星端侧识别服务超时。"
      }
      failure.get()?.let { error(it) }
      val remoteService = checkNotNull(service.get()) { "三星端侧识别服务没有返回接口。" }

      val createOptions = Bundle().apply {
        putString(KEY_CALLER_PACKAGE, appContext.packageName)
      }
      val remoteRecognizer = checkNotNull(remoteService.create(createOptions)) {
        "三星端侧识别服务拒绝创建识别器。"
      }
      recognizer.set(remoteRecognizer)

      val preferredLocales = arrayListOf(
        Locale.forLanguageTag("zh-CN"),
        Locale.forLanguageTag("en-US"),
      )
      val configuration = Bundle().apply {
        putSerializable(KEY_LOCALE, preferredLocales.first())
        putInt(KEY_CONNECTION_TYPE, CONNECTION_LOCAL)
        putBoolean(KEY_ENABLED_PARTIAL, true)
        putBoolean(KEY_ENABLED_MULTILINGUAL, true)
        putSerializable(KEY_PREFERRED_LOCALES, preferredLocales)
        putInt(KEY_SOURCE_SAMPLE_RATE, SOURCE_SAMPLE_RATE)
        putBoolean(KEY_DELIVER_METADATA, false)
      }
      check(remoteRecognizer.prepare(configuration)) {
        "三星端侧中英文模型未准备好。"
      }

      val pipe = ParcelFileDescriptor.createReliablePipe()
      val input = pipe[0]
      val output = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
      try {
        check(remoteRecognizer.write(input, listener)) {
          "三星端侧识别器拒绝音频输入。"
        }
      } catch (error: Throwable) {
        runCatching { output.close() }
        throw error
      } finally {
        input.close()
      }
      synchronized(outputLock) {
        audioOutput = output
      }
      Log.i(TAG, "Samsung IntelliVoice local zh-CN/en-US session started")
    } catch (error: Throwable) {
      failure.compareAndSet(null, error.message ?: "三星端侧识别启动失败。")
      close(cancel = true)
      throw error
    }
  }

  /** Called only by the microphone worker; pipe failures must not stop WAV capture. */
  fun write(buffer: ByteArray, size: Int) {
    if (closed.get() || failure.get() != null) return
    try {
      synchronized(outputLock) {
        audioOutput?.write(buffer, 0, size)
      }
    } catch (error: Throwable) {
      failure.compareAndSet(null, error.message ?: "三星端侧识别音频通道已关闭。")
      synchronized(outputLock) {
        runCatching { audioOutput?.close() }
        audioOutput = null
      }
      finalLatch.countDown()
    }
  }

  fun finish(): SamsungSpeechResult {
    synchronized(outputLock) {
      runCatching { audioOutput?.close() }
        .onFailure { failure.compareAndSet(null, it.message) }
      audioOutput = null
    }

    if (failure.get() == null && !finalLatch.await(RESULT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      failure.compareAndSet(null, "三星端侧识别等待结果超时。")
    }
    val result = SamsungSpeechResult(transcript.get(), failure.get())
    close(cancel = result.transcript.isNullOrBlank())
    Log.i(
      TAG,
      if (result.transcript.isNullOrBlank()) {
        "Samsung IntelliVoice unavailable for utterance; using Whisper fallback: ${result.errorMessage}"
      } else {
        "Samsung IntelliVoice local result received"
      },
    )
    return result
  }

  fun abort() {
    close(cancel = true)
  }

  private fun close(cancel: Boolean) {
    if (!closed.compareAndSet(false, true)) return
    synchronized(outputLock) {
      runCatching { audioOutput?.close() }
      audioOutput = null
    }
    val activeRecognizer = recognizer.getAndSet(null)
    if (cancel) runCatching { activeRecognizer?.cancel() }
    runCatching { activeRecognizer?.release() }
    if (bound) {
      runCatching { appContext.unbindService(connection) }
      bound = false
    }
    service.set(null)
    serviceExecutor.shutdownNow()
    finalLatch.countDown()
    bindLatch.countDown()
  }
}
