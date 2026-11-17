package com.linn0x.prospero.windowlayout

import android.app.Activity
import android.app.Application
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.View
import android.view.ViewTreeObserver
import android.view.Window
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import androidx.window.layout.WindowMetricsCalculator
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.WeakHashMap
import kotlin.math.abs
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
  private val mainHandler = Handler(Looper.getMainLooper())
  private val observedDecorViews = WeakHashMap<View, ViewTreeObserver.OnWindowFocusChangeListener>()
  private var trackingJob: Job? = null
  private var observing = false
  private var lifecycleRegistered = false
  private var displayListenerRegistered = false

  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) = scheduleHighRefreshSync()
    override fun onDisplayRemoved(displayId: Int) = Unit
    override fun onDisplayChanged(displayId: Int) = scheduleHighRefreshSync()
  }

  private val lifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = attachAndApplyHighRefresh(activity)
    override fun onActivityStarted(activity: Activity) = attachAndApplyHighRefresh(activity)
    override fun onActivityResumed(activity: Activity) = attachAndApplyHighRefresh(activity)
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
  }

  override fun definition() = ModuleDefinition {
    Name("ProsperoWindowLayout")

    Events(LAYOUT_EVENT)

    OnCreate {
      registerHighRefreshHooks()
      scheduleHighRefreshSync()
    }

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
      scheduleHighRefreshSync()
      startTracking()
    }

    OnStopObserving(LAYOUT_EVENT) {
      observing = false
      trackingJob?.cancel()
      trackingJob = null
    }

    OnActivityEntersForeground {
      scheduleHighRefreshSync()
      if (observing) startTracking()
    }

    OnActivityEntersBackground {
      trackingJob?.cancel()
      trackingJob = null
    }

    OnDestroy {
      unregisterHighRefreshHooks()
      scope.cancel()
    }
  }

  private fun registerHighRefreshHooks() {
    val reactCtx = appContext.reactContext ?: return
    val app = reactCtx.applicationContext as? Application
    if (app != null && !lifecycleRegistered) {
      app.registerActivityLifecycleCallbacks(lifecycleCallbacks)
      lifecycleRegistered = true
    }
    val dm = reactCtx.getSystemService(DisplayManager::class.java)
    if (dm != null && !displayListenerRegistered) {
      dm.registerDisplayListener(displayListener, mainHandler)
      displayListenerRegistered = true
    }
  }

  private fun unregisterHighRefreshHooks() {
    val reactCtx = appContext.reactContext
    val app = reactCtx?.applicationContext as? Application
    if (app != null && lifecycleRegistered) {
      runCatching { app.unregisterActivityLifecycleCallbacks(lifecycleCallbacks) }
      lifecycleRegistered = false
    }
    val dm = reactCtx?.getSystemService(DisplayManager::class.java)
    if (dm != null && displayListenerRegistered) {
      runCatching { dm.unregisterDisplayListener(displayListener) }
      displayListenerRegistered = false
    }
    mainHandler.removeCallbacksAndMessages(null)
  }

  private fun scheduleHighRefreshSync() {
    mainHandler.post {
      val activity = appContext.currentActivity ?: return@post
      attachAndApplyHighRefresh(activity)
    }
  }

  /**
   * Android 15/16 (targetSdk >= 35) enables Window.isFrameRatePowerSavingsBalanced by default,
   * which caps standard View / React Native animations to FrameRateCategoryRate.normal (60Hz on
   * Galaxy Z Fold). Disable the power-saving cap, enable touch boost, and select the peak
   * refresh-rate Display.Mode matching the active physical resolution (both cover & inner screens).
   */
  private fun attachAndApplyHighRefresh(activity: Activity) {
    if (activity.isFinishing || activity.isDestroyed) return
    val decor = activity.window?.decorView
    if (decor != null && !observedDecorViews.containsKey(decor)) {
      val listener = ViewTreeObserver.OnWindowFocusChangeListener {
        // Re-sync whenever a React Native <Modal> Dialog takes or releases window focus.
        mainHandler.post { applyHighRefreshRate(activity) }
      }
      observedDecorViews[decor] = listener
      runCatching { decor.viewTreeObserver.addOnWindowFocusChangeListener(listener) }
    }
    applyHighRefreshRate(activity)
  }

  private fun applyHighRefreshRate(activity: Activity) {
    if (activity.isFinishing || activity.isDestroyed) return
    val window: Window = activity.window ?: return
    val display: Display? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      runCatching { activity.display }.getOrNull()
    } else {
      @Suppress("DEPRECATION")
      activity.windowManager?.defaultDisplay
    }
    val bestMode = display?.let(::selectPeakDisplayMode)

    if (Build.VERSION.SDK_INT >= 35) {
      if (window.isFrameRatePowerSavingsBalanced()) {
        window.setFrameRatePowerSavingsBalanced(false)
      }
      if (!window.getFrameRateBoostOnTouchEnabled()) {
        window.setFrameRateBoostOnTouchEnabled(true)
      }
    }

    if (bestMode != null && bestMode.refreshRate > 60.5f) {
      val attrs = window.attributes
      if (
        attrs.preferredDisplayModeId != bestMode.modeId ||
        abs(attrs.preferredRefreshRate - bestMode.refreshRate) > 0.5f
      ) {
        attrs.preferredDisplayModeId = bestMode.modeId
        attrs.preferredRefreshRate = bestMode.refreshRate
        window.attributes = attrs
      }
    }

    // Keep React Native <Modal> / Sheet Dialog windows unthrottled at 120Hz as well.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching {
        val wm = activity.getSystemService(WindowManager::class.java) ?: return@runCatching
        for (rootView in WindowInspector.getGlobalWindowViews()) {
          if (rootView === window.decorView || !rootView.isAttachedToWindow) continue
          val lp = rootView.layoutParams as? WindowManager.LayoutParams ?: continue
          var changed = false
          if (Build.VERSION.SDK_INT >= 35) {
            if (lp.isFrameRatePowerSavingsBalanced()) {
              lp.setFrameRatePowerSavingsBalanced(false)
              changed = true
            }
            if (!lp.getFrameRateBoostOnTouchEnabled()) {
              lp.setFrameRateBoostOnTouchEnabled(true)
              changed = true
            }
          }
          if (bestMode != null && bestMode.refreshRate > 60.5f) {
            if (
              lp.preferredDisplayModeId != bestMode.modeId ||
              abs(lp.preferredRefreshRate - bestMode.refreshRate) > 0.5f
            ) {
              lp.preferredDisplayModeId = bestMode.modeId
              lp.preferredRefreshRate = bestMode.refreshRate
              changed = true
            }
          }
          if (changed) {
            runCatching { wm.updateViewLayout(rootView, lp) }
          }
        }
      }
    }
  }

  private fun selectPeakDisplayMode(display: Display): Display.Mode? {
    val supported = display.supportedModes
    if (supported.isEmpty()) return null
    val active = display.mode
    val sameResolution = supported.filter {
      it.physicalWidth == active.physicalWidth && it.physicalHeight == active.physicalHeight
    }
    val candidates = sameResolution.ifEmpty { supported.toList() }
    return candidates.maxByOrNull { it.refreshRate }
  }

  private fun startTracking() {
    if (trackingJob?.isActive == true) return
    val activity = appContext.currentActivity ?: return
    attachAndApplyHighRefresh(activity)
    val tracker = WindowInfoTracker.getOrCreate(activity)
    trackingJob = scope.launch {
      tracker.windowLayoutInfo(activity).collect { layout ->
        attachAndApplyHighRefresh(activity)
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
