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
import android.text.TextUtils
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
    private const val EXTRA_APPROVAL_HOST_ID = "approvalHostId"
    private const val EXTRA_APPROVAL_SESSION_ID = "approvalSessionId"
    private const val EXTRA_APPROVAL_REQUEST_ID = "approvalRequestId"
    private const val EXTRA_APPROVAL_ACTION = "approvalAction"
    private const val EXTRA_APPROVAL_SUMMARY = "approvalSummary"
    private const val EXTRA_APPROVAL_RESOURCE = "approvalResource"

    /** 服务不持有 React 上下文；模块存活时用短生命周期回调把审批发回 JS。 */
    @Volatile
    internal var approvalActionHandler: ((Map<String, Any?>) -> Unit)? = null

    fun syncIntent(
      context: Context,
      title: String,
      detail: String,
      deepLink: String,
      runningCount: Int,
      waitingCount: Int,
      showOverlay: Boolean,
      approvalHostId: String,
      approvalSessionId: String,
      approvalRequestId: String,
      approvalAction: String,
      approvalSummary: String,
      approvalResource: String,
    ): Intent = Intent(context, ProsperoProgressService::class.java).apply {
      putExtra(EXTRA_TITLE, title)
      putExtra(EXTRA_DETAIL, detail)
      putExtra(EXTRA_DEEP_LINK, deepLink)
      putExtra(EXTRA_RUNNING_COUNT, runningCount)
      putExtra(EXTRA_WAITING_COUNT, waitingCount)
      putExtra(EXTRA_SHOW_OVERLAY, showOverlay)
      putExtra(EXTRA_APPROVAL_HOST_ID, approvalHostId)
      putExtra(EXTRA_APPROVAL_SESSION_ID, approvalSessionId)
      putExtra(EXTRA_APPROVAL_REQUEST_ID, approvalRequestId)
      putExtra(EXTRA_APPROVAL_ACTION, approvalAction)
      putExtra(EXTRA_APPROVAL_SUMMARY, approvalSummary)
      putExtra(EXTRA_APPROVAL_RESOURCE, approvalResource)
    }
  }

  private var overlayView: View? = null
  private var overlayParams: WindowManager.LayoutParams? = null
  private var overlayTitle: TextView? = null
  private var overlayDetail: TextView? = null
  private var approvalPanel: LinearLayout? = null
  private var approvalActionView: TextView? = null
  private var approvalSummaryView: TextView? = null
  private var approvalResourceView: TextView? = null
  private var approvalButtons: LinearLayout? = null
  private var approvalStatusView: TextView? = null
  private var overlayDeepLink = ""
  private var approvalHostId = ""
  private var approvalSessionId = ""
  private var approvalRequestId = ""
  private var approvalAction = ""
  private var approvalSummary = ""
  private var approvalResource = ""
  private var approvalSubmitting = false
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
    updateOverlay(
      title,
      detail,
      deepLink,
      showOverlay,
      intent?.getStringExtra(EXTRA_APPROVAL_HOST_ID).orEmpty(),
      intent?.getStringExtra(EXTRA_APPROVAL_SESSION_ID).orEmpty(),
      intent?.getStringExtra(EXTRA_APPROVAL_REQUEST_ID).orEmpty(),
      intent?.getStringExtra(EXTRA_APPROVAL_ACTION).orEmpty(),
      intent?.getStringExtra(EXTRA_APPROVAL_SUMMARY).orEmpty(),
      intent?.getStringExtra(EXTRA_APPROVAL_RESOURCE).orEmpty(),
    )
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
      .setContentIntent(pendingOpenIntent(deepLink))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
      .setColor(themeColor("prospero_accent", Color.rgb(49, 94, 168)))
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

  private fun updateOverlay(
    title: String,
    detail: String,
    deepLink: String,
    show: Boolean,
    nextApprovalHostId: String,
    nextApprovalSessionId: String,
    nextApprovalRequestId: String,
    nextApprovalAction: String,
    nextApprovalSummary: String,
    nextApprovalResource: String,
  ) {
    if (!show) {
      overlaySuppressed = false
      approvalSubmitting = false
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

    if (approvalRequestId != nextApprovalRequestId) approvalSubmitting = false
    overlayDeepLink = deepLink
    approvalHostId = nextApprovalHostId
    approvalSessionId = nextApprovalSessionId
    approvalRequestId = nextApprovalRequestId
    approvalAction = nextApprovalAction
    approvalSummary = nextApprovalSummary
    approvalResource = nextApprovalResource
    if (overlayView == null) addOverlay()
    overlayTitle?.text = title
    overlayDetail?.text = detail
    renderApproval()
  }

  private fun addOverlay() {
    val windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      elevation = dp(12).toFloat()
      background = roundedBackground(
        themeColor("prospero_surface", Color.rgb(255, 255, 255)),
        themeColor("prospero_border", Color.rgb(196, 203, 213)),
        18,
      )
    }

    val header = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(14), dp(10), dp(8), dp(10))
      contentDescription = "Prospero 任务进度，可拖动或点按返回"
    }
    val copy = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      addView(TextView(this@ProsperoProgressService).also {
        overlayTitle = it
        it.setTextColor(themeColor("prospero_text", Color.rgb(17, 21, 27)))
        it.textSize = 14f
        it.maxLines = 1
        it.ellipsize = TextUtils.TruncateAt.END
      })
      addView(TextView(this@ProsperoProgressService).also {
        overlayDetail = it
        it.setTextColor(themeColor("prospero_text_dim", Color.rgb(64, 73, 87)))
        it.textSize = 11f
        it.maxLines = 1
        it.ellipsize = TextUtils.TruncateAt.END
      })
    }
    header.addView(copy, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    header.addView(TextView(this).apply {
      text = "×"
      textSize = 20f
      gravity = Gravity.CENTER
      setTextColor(themeColor("prospero_text_dim", Color.rgb(64, 73, 87)))
      contentDescription = "暂时隐藏 Prospero 悬浮进度"
      setOnClickListener {
        overlaySuppressed = true
        removeOverlay()
      }
    }, LinearLayout.LayoutParams(dp(40), dp(40)))
    root.addView(header)

    val panel = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(14), dp(2), dp(14), dp(14))
      addView(TextView(this@ProsperoProgressService).also {
        approvalActionView = it
        it.setTextColor(themeColor("prospero_warn", Color.rgb(135, 83, 10)))
        it.textSize = 11f
        it.setTypeface(it.typeface, android.graphics.Typeface.BOLD)
        it.maxLines = 1
        it.ellipsize = TextUtils.TruncateAt.END
      })
      addView(TextView(this@ProsperoProgressService).also {
        approvalSummaryView = it
        it.setTextColor(themeColor("prospero_text", Color.rgb(17, 21, 27)))
        it.textSize = 13f
        it.maxLines = 3
        it.ellipsize = TextUtils.TruncateAt.END
        it.setPadding(0, dp(5), 0, 0)
      })
      addView(TextView(this@ProsperoProgressService).also {
        approvalResourceView = it
        it.setTextColor(themeColor("prospero_text_dim", Color.rgb(64, 73, 87)))
        it.textSize = 11f
        it.maxLines = 2
        it.ellipsize = TextUtils.TruncateAt.MIDDLE
        it.setPadding(0, dp(5), 0, 0)
      })
      addView(LinearLayout(this@ProsperoProgressService).also { row ->
        approvalButtons = row
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(0, dp(12), 0, 0)
        row.addView(approvalButton("拒绝", false) { submitApproval("reject") }, weightedButtonParams())
        row.addView(View(this@ProsperoProgressService), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(approvalButton("允许一次", true) { submitApproval("once") }, weightedButtonParams())
      })
      addView(TextView(this@ProsperoProgressService).also {
        approvalStatusView = it
        it.text = "正在提交审批…"
        it.gravity = Gravity.CENTER
        it.setTextColor(themeColor("prospero_text_dim", Color.rgb(64, 73, 87)))
        it.textSize = 12f
        it.setPadding(0, dp(14), 0, dp(4))
        it.visibility = View.GONE
      })
    }
    approvalPanel = panel
    root.addView(panel)

    val params = WindowManager.LayoutParams(
      dp(320),
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
    installDragAndOpen(header, root, windowManager, params)

    try {
      windowManager.addView(root, params)
      overlayView = root
      overlayParams = params
    } catch (_: SecurityException) {
      overlayView = null
      overlayParams = null
    }
  }

  private fun approvalButton(label: String, primary: Boolean, onClick: () -> Unit): TextView =
    TextView(this).apply {
      text = label
      gravity = Gravity.CENTER
      minHeight = dp(46)
      textSize = 12.5f
      setTypeface(typeface, android.graphics.Typeface.BOLD)
      setTextColor(themeColor(
        if (primary) "prospero_on_accent" else "prospero_danger",
        if (primary) Color.WHITE else Color.rgb(173, 48, 48),
      ))
      background = roundedBackground(
        themeColor(
          if (primary) "prospero_accent" else "prospero_danger_bg",
          if (primary) Color.rgb(49, 94, 168) else Color.rgb(248, 222, 222),
        ),
        themeColor(
          if (primary) "prospero_accent" else "prospero_danger",
          if (primary) Color.rgb(49, 94, 168) else Color.rgb(173, 48, 48),
        ),
        10,
      )
      contentDescription = "$label 当前 Agent 操作"
      setOnClickListener { onClick() }
    }

  private fun weightedButtonParams() = LinearLayout.LayoutParams(0, dp(46), 1f)

  private fun renderApproval() {
    val hasApproval = approvalRequestId.isNotBlank() &&
      approvalHostId.isNotBlank() && approvalSessionId.isNotBlank()
    approvalPanel?.visibility = if (hasApproval) View.VISIBLE else View.GONE
    if (!hasApproval) return

    approvalActionView?.text = "需要审批 · ${approvalAction.ifBlank { "Agent 操作" }}"
    approvalSummaryView?.text = approvalSummary.ifBlank { "Agent 请求执行一项操作" }
    approvalResourceView?.apply {
      text = approvalResource
      visibility = if (approvalResource.isBlank()) View.GONE else View.VISIBLE
    }
    approvalButtons?.visibility = if (approvalSubmitting) View.GONE else View.VISIBLE
    approvalStatusView?.visibility = if (approvalSubmitting) View.VISIBLE else View.GONE
  }

  private fun submitApproval(reply: String) {
    if (approvalSubmitting || approvalRequestId.isBlank()) return
    val handler = approvalActionHandler
    if (handler == null) {
      openApp(overlayDeepLink)
      return
    }

    val event = mapOf<String, Any?>(
      "hostId" to approvalHostId,
      "sid" to approvalSessionId,
      "reqId" to approvalRequestId,
      "reply" to reply,
      "deepLink" to overlayDeepLink,
    )
    approvalSubmitting = true
    renderApproval()
    try {
      handler(event)
    } catch (_: RuntimeException) {
      approvalSubmitting = false
      renderApproval()
      openApp(overlayDeepLink)
    }
  }

  private fun installDragAndOpen(
    dragHandle: View,
    root: View,
    windowManager: WindowManager,
    params: WindowManager.LayoutParams,
  ) {
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var moved = false
    dragHandle.setOnTouchListener { _, event ->
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
          windowManager.updateViewLayout(root, params)
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

  private fun roundedBackground(fill: Int, stroke: Int, radius: Int): GradientDrawable =
    GradientDrawable().apply {
      cornerRadius = dp(radius).toFloat()
      setColor(fill)
      setStroke(dp(1), stroke)
    }

  @Suppress("DEPRECATION")
  private fun themeColor(name: String, fallback: Int): Int {
    val id = resources.getIdentifier(name, "color", packageName)
    if (id == 0) return fallback
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      resources.getColor(id, theme)
    } else {
      resources.getColor(id)
    }
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
    approvalPanel = null
    approvalActionView = null
    approvalSummaryView = null
    approvalResourceView = null
    approvalButtons = null
    approvalStatusView = null
  }

  private fun dp(value: Int): Int =
    (value * resources.displayMetrics.density + 0.5f).toInt()
}
