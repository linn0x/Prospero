package com.linn0x.prospero.windowlayout

import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

private const val LAYOUT_EVENT = "onLayoutChange"

/** Exposes Jetpack WindowManager posture updates in React Native density-independent pixels. */
class ProsperoWindowLayoutModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var trackingJob: Job? = null
  private var observing = false

  override fun definition() = ModuleDefinition {
    Name("ProsperoWindowLayout")

    Events(LAYOUT_EVENT)

    Function("getCurrent") {
      currentLayout()
    }

    OnStartObserving(LAYOUT_EVENT) {
      observing = true
      startTracking()
    }

    OnStopObserving(LAYOUT_EVENT) {
      observing = false
      trackingJob?.cancel()
      trackingJob = null
    }

    OnActivityEntersForeground {
      if (observing) startTracking()
    }

    OnActivityEntersBackground {
      trackingJob?.cancel()
      trackingJob = null
    }

    OnDestroy {
      scope.cancel()
    }
  }

  private fun startTracking() {
    if (trackingJob?.isActive == true) return
    val activity = appContext.currentActivity ?: return
    val tracker = WindowInfoTracker.getOrCreate(activity)
    trackingJob = scope.launch {
      tracker.windowLayoutInfo(activity).collect { layout ->
        sendEvent(LAYOUT_EVENT, serialize(layout))
      }
    }
  }

  private fun currentLayout(): Map<String, Any?> {
    val activity = appContext.currentActivity ?: return emptyLayout()
    val layout = WindowInfoTracker
      .getOrCreate(activity)
      .getCurrentWindowLayoutInfo(activity)
    return serialize(layout)
  }

  private fun serialize(layout: WindowLayoutInfo): Map<String, Any?> {
    val feature = layout.displayFeatures
      .filterIsInstance<FoldingFeature>()
      .firstOrNull()
      ?: return emptyLayout()
    val density = appContext.reactContext?.resources?.displayMetrics?.density ?: 1f
    val bounds = feature.bounds
    return mapOf(
      "foldingFeature" to mapOf(
        "bounds" to mapOf(
          "x" to bounds.left / density,
          "y" to bounds.top / density,
          "width" to bounds.width() / density,
          "height" to bounds.height() / density,
        ),
        "orientation" to if (
          feature.orientation == FoldingFeature.Orientation.VERTICAL
        ) "vertical" else "horizontal",
        "state" to if (
          feature.state == FoldingFeature.State.HALF_OPENED
        ) "half-opened" else "flat",
        "occlusionType" to if (
          feature.occlusionType == FoldingFeature.OcclusionType.FULL
        ) "full" else "none",
        "isSeparating" to feature.isSeparating,
      ),
    )
  }

  private fun emptyLayout(): Map<String, Any?> = mapOf("foldingFeature" to null)
}
