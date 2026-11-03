package com.linn0x.prospero.ghostty

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.abs

@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class ProsperoGhosttyView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val container = FrameLayout(context)
  private val nativeSurface = SurfaceView(context)
  private val inputSink = InputSink(context)
  private val unavailable = TextView(context)
  private val handler = Handler(Looper.getMainLooper())
  private var fontSize = 12f
  private var lastCols = 0
  private var lastRows = 0
  private var reported = false
  private var atlas: Bitmap? = null
  private var inputEnabled = true
  private var active = false
  private var cellWidthPx = 8
  private var cellHeightPx = 16
  private var touchStartX = 0f
  private var touchStartY = 0f
  private var touchLastY = 0f
  private var touchMoved = false
  private var selectionStartCol = 0
  private var selectionStartRow = 0
  private var selecting = false
  private var longPress: Runnable? = null

  private val onReady by EventDispatcher<Map<String, Any?>>()
  private val onUnavailable by EventDispatcher<Map<String, Any?>>()
  private val onResize by EventDispatcher<Map<String, Any?>>()
  private val onInput by EventDispatcher<Map<String, Any?>>()
  private val onClipboardCopy by EventDispatcher<Map<String, Any?>>()
  private val onClipboardPaste by EventDispatcher<Map<String, Any?>>()
  private val onFontSize by EventDispatcher<Map<String, Any?>>()
  private val onPerf by EventDispatcher<Map<String, Any?>>()

  init {
    setBackgroundColor(Color.rgb(9, 9, 11))
    container.setBackgroundColor(Color.rgb(9, 9, 11))
    nativeSurface.setBackgroundColor(Color.rgb(9, 9, 11))
    nativeSurface.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) {
        attachSurface(holder)
      }

      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        attachSurface(holder)
        reportSize()
      }

      override fun surfaceDestroyed(holder: SurfaceHolder) {
        ProsperoGhosttyNative.detachSurface()
      }
    })
    nativeSurface.setOnTouchListener { _, event ->
      handleTouch(event)
      true
    }
    unavailable.setTextColor(Color.rgb(240, 215, 152))
    unavailable.gravity = Gravity.CENTER
    unavailable.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    unavailable.text = "Native Ghostty is unavailable"
    container.addView(
      nativeSurface,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    container.addView(
      unavailable,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    inputSink.alpha = 0f
    inputSink.isFocusable = true
    inputSink.isFocusableInTouchMode = true
    container.addView(inputSink, FrameLayout.LayoutParams(1, 1))
    addView(
      container,
      ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    reportAvailability()
    reportSize()
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    reportSize()
  }

  fun setFontSize(value: Double?) {
    val next = value?.toFloat()?.coerceIn(6f, 72f) ?: 12f
    if (next == fontSize) return
    fontSize = next
    updateFontAtlas()
    reportSize()
  }

  fun setInputEnabled(enabled: Boolean) {
    inputEnabled = enabled
    if (!enabled) hideKeyboard()
  }

  fun setActive(value: Boolean) {
    active = value
    if (!value) hideKeyboard()
  }

  fun write(dataB64: String) {
    val data = decodeB64(dataB64) ?: return
    ProsperoGhosttyNative.write(data)
  }

  fun events(@Suppress("UNUSED_PARAMETER") json: String) {}

  fun snapshot(
    dataB64: String?,
    ansi: String?,
    cols: Int,
    rows: Int,
  ) {
    updateGrid(cols, rows)
    val data = ansi?.toByteArray(Charsets.UTF_8) ?: dataB64?.let { decodeB64(it) } ?: return
    ProsperoGhosttyNative.setSnapshot(data, cols, rows)
  }

  fun focusTerminal() {
    showKeyboard()
  }

  fun blurTerminal() {
    hideKeyboard()
  }

  fun scrollToBottom() {
    ProsperoGhosttyNative.scrollToBottom()
  }

  fun copyAll() {
    val selected = ProsperoGhosttyNative.readSelection(false)
    val text = selected.ifEmpty { ProsperoGhosttyNative.readSelection(true) }
    if (text.isNotEmpty()) onClipboardCopy(mapOf("text" to text))
  }

  fun search(
    @Suppress("UNUSED_PARAMETER") text: String,
    @Suppress("UNUSED_PARAMETER") previous: Boolean,
    @Suppress("UNUSED_PARAMETER") incremental: Boolean,
  ) {}

  fun paste(text: String) {
    emitPaste(text)
  }

  private fun attachSurface(holder: SurfaceHolder) {
    val reason = ProsperoGhosttyNative.attachSurface(holder.surface)
    if (reason != null) {
      onUnavailable(mapOf("available" to false, "reason" to reason))
    } else {
      updateFontAtlas()
      ProsperoGhosttyNative.resizeGrid(max(1, lastCols), max(1, lastRows))
    }
  }

  private fun reportAvailability() {
    val availability = ProsperoGhosttyNative.availability()
    if (availability["available"] == true) {
      unavailable.visibility = GONE
      if (!reported) {
        reported = true
        val size = currentGrid()
        onReady(mapOf("cols" to size.first, "rows" to size.second, "renderer" to "ghostty"))
      }
    } else {
      unavailable.visibility = VISIBLE
      onUnavailable(availability)
    }
  }

  private fun reportSize() {
    if (width <= 0 || height <= 0) return
    val size = currentGrid()
    updateGrid(size.first, size.second)
  }

  private fun updateGrid(cols: Int, rows: Int) {
    if (cols <= 0 || rows <= 0 || (cols == lastCols && rows == lastRows)) return
    lastCols = cols
    lastRows = rows
    ProsperoGhosttyNative.resizeGrid(cols, rows)
    onResize(mapOf("cols" to cols, "rows" to rows))
  }

  private fun currentGrid(): Pair<Int, Int> {
    val cols = max(1, width / max(1, cellWidthPx))
    val rows = max(1, height / max(1, cellHeightPx))
    return Pair(cols, rows)
  }

  private fun updateFontAtlas() {
    val fontPx = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, fontSize, resources.displayMetrics)
    val cellWidth = max(6, ceil(fontPx * 0.72f).toInt())
    val cellHeight = max(10, ceil(fontPx * 1.35f).toInt())
    cellWidthPx = cellWidth
    cellHeightPx = cellHeight
    val first = 32
    val count = 95
    val atlasCols = 16
    val atlasRows = ceil(count / atlasCols.toFloat()).toInt()
    val bitmap = Bitmap.createBitmap(cellWidth * atlasCols, cellHeight * atlasRows, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.color = Color.WHITE
    paint.typeface = Typeface.MONOSPACE
    paint.textSize = fontPx
    val metrics = paint.fontMetrics
    val baseline = (cellHeight - metrics.ascent - metrics.descent) / 2f
    for (index in 0 until count) {
      val ch = (first + index).toChar().toString()
      val col = index % atlasCols
      val row = index / atlasCols
      canvas.drawText(ch, col * cellWidth.toFloat(), row * cellHeight + baseline, paint)
    }
    atlas?.recycle()
    atlas = bitmap
    ProsperoGhosttyNative.setFontAtlas(bitmap, atlasCols, first, cellWidth, cellHeight)
  }

  private fun decodeB64(value: String): ByteArray? =
    runCatching { Base64.decode(value, Base64.DEFAULT) }.getOrNull()

  private fun setSelectionAt(x: Float, y: Float) {
    val col = (x / max(1, cellWidthPx)).toInt().coerceIn(0, max(0, lastCols - 1))
    val row = (y / max(1, cellHeightPx)).toInt().coerceIn(0, max(0, lastRows - 1))
    ProsperoGhosttyNative.setSelection(selectionStartCol, selectionStartRow, col, row)
  }

  private fun beginSelection(x: Float, y: Float) {
    selectionStartCol = (x / max(1, cellWidthPx)).toInt().coerceIn(0, max(0, lastCols - 1))
    selectionStartRow = (y / max(1, cellHeightPx)).toInt().coerceIn(0, max(0, lastRows - 1))
    selecting = true
    setSelectionAt(x, y)
  }

  private fun handleTouch(event: MotionEvent) {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        touchStartX = event.x
        touchStartY = event.y
        touchLastY = event.y
        touchMoved = false
        selecting = false
        longPress?.let { handler.removeCallbacks(it) }
        if (!ProsperoGhosttyNative.mouseReporting()) {
          longPress = Runnable { beginSelection(touchStartX, touchStartY) }
          handler.postDelayed(longPress!!, 360)
        }
        showKeyboard()
      }
      MotionEvent.ACTION_MOVE -> {
        if (selecting) {
          setSelectionAt(event.x, event.y)
        } else {
          val moved = abs(event.y - touchStartY) > cellHeightPx || abs(event.x - touchStartX) > cellWidthPx
          if (moved) {
            touchMoved = true
            longPress?.let { handler.removeCallbacks(it) }
          }
          val lines = ((event.y - touchLastY) / max(1, cellHeightPx)).toInt()
          if (lines != 0) {
            if (ProsperoGhosttyNative.mouseReporting()) {
              repeat(abs(lines)) { emitMouse(0, if (lines > 0) 4 else 5, event) }
            } else {
              ProsperoGhosttyNative.scrollLines(lines)
            }
            touchLastY = event.y
          }
        }
      }
      MotionEvent.ACTION_UP -> {
        longPress?.let { handler.removeCallbacks(it) }
        if (selecting) {
          setSelectionAt(event.x, event.y)
        } else if (!touchMoved && abs(event.y - touchStartY) < cellHeightPx && abs(event.x - touchStartX) < cellWidthPx) {
          if (ProsperoGhosttyNative.mouseReporting()) {
            emitMouse(0, 1, event)
            emitMouse(1, 1, event)
          }
          showKeyboard()
        }
      }
      MotionEvent.ACTION_CANCEL -> {
        longPress?.let { handler.removeCallbacks(it) }
      }
    }
  }

  private fun showKeyboard() {
    if (!inputEnabled) return
    inputSink.requestFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.showSoftInput(inputSink, InputMethodManager.SHOW_IMPLICIT)
  }

  private fun hideKeyboard() {
    inputSink.clearFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(windowToken, 0)
  }

  private fun emitInput(text: String) {
    emitBytes(text.toByteArray(Charsets.UTF_8))
  }

  private fun emitBytes(bytes: ByteArray) {
    if (!active || !inputEnabled || bytes.isEmpty()) return
    val data = Base64.encodeToString(bytes, Base64.NO_WRAP)
    onInput(mapOf("data" to data))
  }

  private fun emitText(text: String) {
    if (!active || !inputEnabled || text.isEmpty()) return
    val raw = text.toByteArray(Charsets.UTF_8)
    val encoded = ProsperoGhosttyNative.encodeText(raw)
    emitBytes(if (encoded.isNotEmpty()) encoded else raw)
  }

  private fun emitPaste(text: String) {
    if (!active || !inputEnabled || text.isEmpty()) return
    val raw = text.toByteArray(Charsets.UTF_8)
    val encoded = ProsperoGhosttyNative.encodePaste(raw)
    emitBytes(if (encoded.isNotEmpty()) encoded else raw)
  }

  private fun emitKey(event: KeyEvent): Boolean {
    if (!active || !inputEnabled) return true
    val text = keyText(event)
    val encoded = ProsperoGhosttyNative.encodeKey(
      ghosttyKey(event.keyCode),
      ghosttyMods(event.metaState),
      text.toByteArray(Charsets.UTF_8),
      false,
      ghosttyAction(event),
    )
    if (encoded.isNotEmpty()) {
      emitBytes(encoded)
      return true
    }
    when (event.keyCode) {
      KeyEvent.KEYCODE_ENTER -> if (event.action == KeyEvent.ACTION_DOWN) emitInput("\r")
      KeyEvent.KEYCODE_DEL -> if (event.action == KeyEvent.ACTION_DOWN) emitInput("\u007f")
      KeyEvent.KEYCODE_TAB -> if (event.action == KeyEvent.ACTION_DOWN) emitInput("\t")
      else -> if (event.action == KeyEvent.ACTION_DOWN && text.isNotEmpty()) emitInput(text)
    }
    return true
  }

  private fun emitMouse(action: Int, button: Int, event: MotionEvent): Boolean {
    val col = (event.x / max(1, cellWidthPx)).toInt().coerceIn(0, max(0, lastCols - 1))
    val row = (event.y / max(1, cellHeightPx)).toInt().coerceIn(0, max(0, lastRows - 1))
    val encoded = ProsperoGhosttyNative.encodeMouse(action, button, ghosttyMods(event.metaState), col, row)
    if (encoded.isEmpty()) return false
    emitBytes(encoded)
    return true
  }

  private fun keyText(event: KeyEvent): String {
    if (event.action != KeyEvent.ACTION_DOWN) return ""
    if (event.isCtrlPressed || event.isAltPressed || event.isMetaPressed) return ""
    val value = event.getUnicodeChar(event.metaState)
    if (value <= 0) return ""
    return String(Character.toChars(value))
  }

  private fun ghosttyAction(event: KeyEvent): Int =
    when (event.action) {
      KeyEvent.ACTION_UP -> 1
      KeyEvent.ACTION_DOWN -> if (event.repeatCount > 0) 2 else 0
      else -> 0
    }

  private fun ghosttyMods(meta: Int): Int {
    var value = 0
    if (meta and KeyEvent.META_SHIFT_ON != 0) value = value or 1
    if (meta and KeyEvent.META_CTRL_ON != 0) value = value or 2
    if (meta and KeyEvent.META_ALT_ON != 0) value = value or 4
    if (meta and KeyEvent.META_META_ON != 0) value = value or 8
    if (meta and KeyEvent.META_CAPS_LOCK_ON != 0) value = value or 16
    if (meta and KeyEvent.META_NUM_LOCK_ON != 0) value = value or 32
    return value
  }

  private fun ghosttyKey(keyCode: Int): Int =
    when (keyCode) {
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> 1
      KeyEvent.KEYCODE_DEL -> 2
      KeyEvent.KEYCODE_TAB -> 3
      KeyEvent.KEYCODE_ESCAPE -> 4
      KeyEvent.KEYCODE_DPAD_UP -> 5
      KeyEvent.KEYCODE_DPAD_DOWN -> 6
      KeyEvent.KEYCODE_DPAD_LEFT -> 7
      KeyEvent.KEYCODE_DPAD_RIGHT -> 8
      KeyEvent.KEYCODE_FORWARD_DEL -> 9
      KeyEvent.KEYCODE_MOVE_HOME -> 10
      KeyEvent.KEYCODE_MOVE_END -> 11
      KeyEvent.KEYCODE_PAGE_UP -> 12
      KeyEvent.KEYCODE_PAGE_DOWN -> 13
      KeyEvent.KEYCODE_INSERT -> 14
      in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> 100 + keyCode - KeyEvent.KEYCODE_A
      in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> 200 + keyCode - KeyEvent.KEYCODE_0
      else -> 0
    }

  private inner class InputSink(context: Context) : View(context) {
    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
      outAttrs.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
      outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
      return object : BaseInputConnection(this@InputSink, false) {
        override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
          emitText(text?.toString() ?: "")
          return true
        }

        override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
          ProsperoGhosttyNative.encodeKey(0, 0, (text?.toString() ?: "").toByteArray(Charsets.UTF_8), true, 0)
          return true
        }

        override fun finishComposingText(): Boolean {
          return true
        }

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
          repeat(max(1, beforeLength)) { emitKey(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL)) }
          return true
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
          return emitKey(event)
        }
      }
    }
  }
}
