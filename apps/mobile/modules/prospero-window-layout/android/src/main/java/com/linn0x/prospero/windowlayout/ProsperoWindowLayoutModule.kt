package com.linn0x.prospero.windowlayout

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import androidx.window.layout.WindowMetricsCalculator
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

    // 合上用外屏时用户常关着系统自动旋转;终端页仍想横过来看。FULL_SENSOR 按传感器
    // 转屏且不受旋转锁定影响,关掉时交还给系统(UNSPECIFIED)。
    Function("setSensorRotation") { enabled: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      val orientation = if (enabled) ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      activity.runOnUiThread {
        if (activity.requestedOrientation != orientation) activity.requestedOrientation = orientation
      }
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
        sendEvent(LAYOUT_EVENT, serialize(activity, layout))
      }
    }
  }

  private fun currentLayout(): Map<String, Any?> {
    val activity = appContext.currentActivity ?: return emptyLayout()
    val layout = WindowInfoTracker
      .getOrCreate(activity)
      .getCurrentWindowLayoutInfo(activity)
    return serialize(activity, layout)
  }

  /**
   * 折叠机合上后应用跑在外屏上，此时没有 FoldingFeature；但内屏分屏/小窗时
   * 同样没有。所以额外带上「是否折叠机」和「当前显示屏最短边」,由 JS 侧判定。
   */
  private fun isFoldable(activity: Activity): Boolean =
    activity.packageManager.hasSystemFeature(PackageManager.FEATURE_SENSOR_HINGE_ANGLE)

  private fun serialize(activity: Activity, layout: WindowLayoutInfo): Map<String, Any?> {
    val density = activity.resources.displayMetrics.density
    // 最大窗口尺寸 = 当前所在显示屏的尺寸，不受分屏/小窗影响。
    val display = WindowMetricsCalculator.getOrCreate()
      .computeMaximumWindowMetrics(activity)
      .bounds
    val device = mapOf(
      "isFoldable" to isFoldable(activity),
      "displaySmallestWidth" to minOf(display.width(), display.height()) / density,
    )
    val feature = layout.displayFeatures
      .filterIsInstance<FoldingFeature>()
      .firstOrNull()
      ?: return mapOf("foldingFeature" to null, "device" to device)
    val bounds = feature.bounds
    return mapOf(
      "device" to device,
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
