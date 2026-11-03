package com.linn0x.prospero.ghostty

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ProsperoGhosttyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ProsperoGhostty")

    Function("availability") {
      ProsperoGhosttyNative.availability()
    }

    Function("write") { viewTag: Int, dataB64: String ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.write(dataB64)
    }

    Function("events") { viewTag: Int, json: String ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.events(json)
    }

    Function("snapshot") { viewTag: Int, dataB64: String?, ansi: String?, cols: Int, rows: Int ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.snapshot(dataB64, ansi, cols, rows)
    }

    Function("focus") { viewTag: Int ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.focusTerminal()
    }

    Function("blur") { viewTag: Int ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.blurTerminal()
    }

    Function("scrollToBottom") { viewTag: Int ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.scrollToBottom()
    }

    Function("copyAll") { viewTag: Int ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.copyAll()
    }

    Function("search") { viewTag: Int, text: String, previous: Boolean, incremental: Boolean ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.search(text, previous, incremental)
    }

    Function("paste") { viewTag: Int, text: String ->
      appContext.findView<ProsperoGhosttyView>(viewTag)?.paste(text)
    }

    View(ProsperoGhosttyView::class) {
      Events(
        "onReady",
        "onUnavailable",
        "onResize",
        "onInput",
        "onClipboardCopy",
        "onClipboardPaste",
        "onFontSize",
        "onPerf",
      )

      Prop("fontSize") { view: ProsperoGhosttyView, value: Double? ->
        view.setFontSize(value)
      }

      Prop("inputEnabled") { view: ProsperoGhosttyView, value: Boolean? ->
        view.setInputEnabled(value != false)
      }

      Prop("active") { view: ProsperoGhosttyView, value: Boolean? ->
        view.setActive(value == true)
      }

      OnViewDestroys { view: ProsperoGhosttyView ->
        view.blurTerminal()
      }
    }
  }
}
