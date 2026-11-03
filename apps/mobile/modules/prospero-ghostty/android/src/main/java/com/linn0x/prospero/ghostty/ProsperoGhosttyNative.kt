package com.linn0x.prospero.ghostty

import android.graphics.Bitmap
import android.view.Surface

internal object ProsperoGhosttyNative {
  private val loadFailure: String? = runCatching {
    System.loadLibrary("prospero_ghostty")
  }.exceptionOrNull()?.message

  val loaded: Boolean
    get() = loadFailure == null

  fun availability(): Map<String, Any?> {
    if (!loaded) {
      return mapOf(
        "available" to false,
        "reason" to (loadFailure ?: "libprospero_ghostty.so is not installed"),
      )
    }
    return runCatching {
      mapOf(
        "available" to nativeAvailable(),
        "reason" to nativeUnavailableReason(),
        "version" to nativeVersion(),
      )
    }.getOrElse { error ->
      mapOf(
        "available" to false,
        "reason" to (error.message ?: error.javaClass.name),
      )
    }
  }

  fun attachSurface(surface: Surface): String? {
    if (!loaded) return loadFailure ?: "libprospero_ghostty.so is not installed"
    return runCatching { nativeAttachSurface(surface) }.getOrElse { error ->
      error.message ?: error.javaClass.name
    }
  }

  fun detachSurface() {
    if (!loaded) return
    runCatching { nativeDetachSurface() }
  }

  fun resizeGrid(cols: Int, rows: Int) {
    if (!loaded) return
    runCatching { nativeResizeGrid(cols, rows) }
  }

  fun setSnapshot(data: ByteArray, cols: Int, rows: Int) {
    if (!loaded) return
    runCatching { nativeSetSnapshot(data, cols, rows) }
  }

  fun write(data: ByteArray) {
    if (!loaded) return
    runCatching { nativeWrite(data) }
  }

  fun encodeText(data: ByteArray): ByteArray {
    if (!loaded) return ByteArray(0)
    return runCatching { nativeEncodeText(data) }.getOrDefault(ByteArray(0))
  }

  fun encodeKey(key: Int, mods: Int, data: ByteArray, composing: Boolean, action: Int): ByteArray {
    if (!loaded) return ByteArray(0)
    return runCatching { nativeEncodeKey(key, mods, data, composing, action) }.getOrDefault(ByteArray(0))
  }

  fun encodePaste(data: ByteArray): ByteArray {
    if (!loaded) return ByteArray(0)
    return runCatching { nativeEncodePaste(data) }.getOrDefault(ByteArray(0))
  }

  fun encodeMouse(action: Int, button: Int, mods: Int, col: Int, row: Int): ByteArray {
    if (!loaded) return ByteArray(0)
    return runCatching { nativeEncodeMouse(action, button, mods, col, row) }.getOrDefault(ByteArray(0))
  }

  fun bracketedPaste(): Boolean {
    if (!loaded) return false
    return runCatching { nativeBracketedPaste() }.getOrDefault(false)
  }

  fun mouseReporting(): Boolean {
    if (!loaded) return false
    return runCatching { nativeMouseReporting() }.getOrDefault(false)
  }

  fun scrollLines(lines: Int) {
    if (!loaded) return
    runCatching { nativeScrollLines(lines) }
  }

  fun scrollToBottom() {
    if (!loaded) return
    runCatching { nativeScrollToBottom() }
  }

  fun setSelection(startCol: Int, startRow: Int, endCol: Int, endRow: Int) {
    if (!loaded) return
    runCatching { nativeSetSelection(startCol, startRow, endCol, endRow) }
  }

  fun clearSelection() {
    if (!loaded) return
    runCatching { nativeClearSelection() }
  }

  fun readSelection(all: Boolean): String {
    if (!loaded) return ""
    return runCatching { nativeReadSelection(all) }.getOrDefault("")
  }

  fun setFontAtlas(bitmap: Bitmap, atlasCols: Int, firstChar: Int, cellWidth: Int, cellHeight: Int) {
    if (!loaded) return
    runCatching { nativeSetFontAtlas(bitmap, atlasCols, firstChar, cellWidth, cellHeight) }
  }

  external fun nativeAvailable(): Boolean
  external fun nativeUnavailableReason(): String?
  external fun nativeVersion(): String
  external fun nativeAttachSurface(surface: Surface): String?
  external fun nativeDetachSurface()
  external fun nativeResizeGrid(cols: Int, rows: Int)
  external fun nativeSetSnapshot(data: ByteArray, cols: Int, rows: Int)
  external fun nativeWrite(data: ByteArray)
  external fun nativeEncodeText(data: ByteArray): ByteArray
  external fun nativeEncodeKey(key: Int, mods: Int, data: ByteArray, composing: Boolean, action: Int): ByteArray
  external fun nativeEncodePaste(data: ByteArray): ByteArray
  external fun nativeEncodeMouse(action: Int, button: Int, mods: Int, col: Int, row: Int): ByteArray
  external fun nativeBracketedPaste(): Boolean
  external fun nativeMouseReporting(): Boolean
  external fun nativeScrollLines(lines: Int)
  external fun nativeScrollToBottom()
  external fun nativeSetSelection(startCol: Int, startRow: Int, endCol: Int, endRow: Int)
  external fun nativeClearSelection()
  external fun nativeReadSelection(all: Boolean): String
  external fun nativeSetFontAtlas(bitmap: Bitmap, atlasCols: Int, firstChar: Int, cellWidth: Int, cellHeight: Int)
}
