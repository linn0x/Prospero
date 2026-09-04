package com.linn0x.prospero.progressoverlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.max

private const val CHANNEL_ID = "prospero-running-sessions"
private const val NOTIFICATION_ID = 41073

class ProsperoProgressService : Service() {
  companion object {
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_DETAIL = "detail"
    private const val EXTRA_DEEP_LINK = "deepLink"
    private const val EXTRA_RUNNING_COUNT = "runningCount"
    private const val EXTRA_WAITING_COUNT = "waitingCount"
    private const val EXTRA_SHOW_OVERLAY = "showOverlay"

    fun syncIntent(
      context: Context,
      title: String,
      detail: String,
      deepLink: String,
      runningCount: Int,
      waitingCount: Int,
      showOverlay: Boolean,
    ): Intent = Intent(context, ProsperoProgressService::class.java).apply {
      putExtra(EXTRA_TITLE, title)
      putExtra(EXTRA_DETAIL, detail)
      putExtra(EXTRA_DEEP_LINK, deepLink)
      putExtra(EXTRA_RUNNING_COUNT, runningCount)
      putExtra(EXTRA_WAITING_COUNT, waitingCount)
      putExtra(EXTRA_SHOW_OVERLAY, showOverlay)
    }
  }

  private var overlayView: View? = null
  private var overlayParams: WindowManager.LayoutParams? = null
  private var overlayTitle: TextView? = null
  private var overlayDetail: TextView? = null
  private var overlayDeepLink = ""
  private var overlaySuppressed = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() }
      ?: "Prospero 正在工作"
    val detail = intent?.getStringExtra(EXTRA_DETAIL)?.takeIf { it.isNotBlank() }
      ?: "Agent 会话正在运行"
    val deepLink = intent?.getStringExtra(EXTRA_DEEP_LINK).orEmpty()
    val runningCount = intent?.getIntExtra(EXTRA_RUNNING_COUNT, 1) ?: 1
    val waitingCount = intent?.getIntExtra(EXTRA_WAITING_COUNT, 0) ?: 0
    val showOverlay = intent?.getBooleanExtra(EXTRA_SHOW_OVERLAY, false) ?: false

    createNotificationChannel()
    startForeground(
      NOTIFICATION_ID,
      buildNotification(title, detail, deepLink, runningCount, waitingCount),
    )
    updateOverlay(title, detail, deepLink, showOverlay)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    removeOverlay()
    super.onDestroy()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Agent 工作进度",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "有 Agent 会话运行时显示状态和快速返回入口"
      setShowBadge(false)
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    }
    manager.createNotificationChannel(channel)
  }

  @Suppress("DEPRECATION")
  private fun notificationBuilder(): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }

  private fun buildNotification(
    title: String,
    detail: String,
    deepLink: String,
    runningCount: Int,
    waitingCount: Int,
  ): Notification {
    val openIntent = pendingOpenIntent(deepLink)
    val summary = if (waitingCount > 0) {
      "${waitingCount} 项等待处理 · ${runningCount} 项活跃"
    } else {
      "${runningCount} 项正在运行"
    }
    val publicVersion = notificationBuilder()
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setContentTitle("Prospero")
      .setContentText(summary)
      .setShowWhen(false)
      .build()

    return notificationBuilder()
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setContentTitle(title)
      .setContentText(detail)
      .setSubText(summary)
      .setContentIntent(openIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
      .setColor(Color.rgb(122, 162, 247))
      .setProgress(0, 0, waitingCount == 0)
      .build()
  }

  private fun pendingOpenIntent(deepLink: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    return PendingIntent.getActivity(
      this,
      deepLink.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun updateOverlay(title: String, detail: String, deepLink: String, show: Boolean) {
    if (!show) {
      overlaySuppressed = false
      removeOverlay()
      return
    }
    if (
      overlaySuppressed ||
      Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
      !Settings.canDrawOverlays(this)
    ) {
      removeOverlay()
      return
    }

    overlayDeepLink = deepLink
    if (overlayView == null) addOverlay()
    overlayTitle?.text = title
    overlayDetail?.text = detail
  }

  private fun addOverlay() {
    val windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(14), dp(10), dp(8), dp(10))
      elevation = dp(10).toFloat()
      background = GradientDrawable().apply {
        cornerRadius = dp(16).toFloat()
        setColor(Color.rgb(30, 31, 38))
        setStroke(dp(1), Color.rgb(68, 72, 87))
      }
    }
    val copy = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      addView(TextView(this@ProsperoProgressService).also {
        overlayTitle = it
        it.setTextColor(Color.rgb(232, 232, 238))
        it.textSize = 14f
        it.maxLines = 1
      })
      addView(TextView(this@ProsperoProgressService).also {
        overlayDetail = it
        it.setTextColor(Color.rgb(159, 165, 181))
        it.textSize = 11f
        it.maxLines = 1
      })
    }
    root.addView(
      copy,
      LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
    )
    root.addView(TextView(this).apply {
      text = "×"
      textSize = 20f
      gravity = Gravity.CENTER
      setTextColor(Color.rgb(159, 165, 181))
      contentDescription = "暂时隐藏 Prospero 悬浮进度"
      setOnClickListener {
        overlaySuppressed = true
        removeOverlay()
      }
    }, LinearLayout.LayoutParams(dp(36), dp(36)))

    val params = WindowManager.LayoutParams(
      dp(286),
      WindowManager.LayoutParams.WRAP_CONTENT,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      } else {
        @Suppress("DEPRECATION")
        WindowManager.LayoutParams.TYPE_PHONE
      },
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.END
      x = dp(12)
      y = dp(72)
    }
    installDragAndOpen(root, windowManager, params)

    try {
      windowManager.addView(root, params)
      overlayView = root
      overlayParams = params
    } catch (_: SecurityException) {
      overlayView = null
      overlayParams = null
    }
  }

  private fun installDragAndOpen(
    view: View,
    windowManager: WindowManager,
    params: WindowManager.LayoutParams,
  ) {
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var moved = false
    view.setOnTouchListener { _, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX
          downY = event.rawY
          startX = params.x
          startY = params.y
          moved = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = event.rawX - downX
          val dy = event.rawY - downY
          if (abs(dx) > dp(5) || abs(dy) > dp(5)) moved = true
          params.x = max(0, startX - dx.toInt())
          params.y = max(0, startY + dy.toInt())
          windowManager.updateViewLayout(view, params)
          true
        }
        MotionEvent.ACTION_UP -> {
          if (!moved) openApp(overlayDeepLink)
          true
        }
        else -> false
      }
    }
  }

  private fun openApp(deepLink: String) {
    if (deepLink.isBlank()) return
    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    })
  }

  private fun removeOverlay() {
    val view = overlayView ?: return
    try {
      (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(view)
    } catch (_: IllegalArgumentException) {
      // View was already detached by the system.
    }
    overlayView = null
    overlayParams = null
    overlayTitle = null
    overlayDetail = null
  }

  private fun dp(value: Int): Int =
    (value * resources.displayMetrics.density + 0.5f).toInt()
}
