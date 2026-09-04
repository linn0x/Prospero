package com.linn0x.prospero.progressoverlay

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class ProsperoProgressOverlayModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ProsperoProgressOverlay")
    Events("onApprovalAction")

    OnCreate {
      ProsperoProgressService.approvalActionHandler = { event ->
        sendEvent("onApprovalAction", event)
      }
    }

    OnDestroy {
      ProsperoProgressService.approvalActionHandler = null
    }

    Function("canDrawOverlays") {
      val context = appContext.reactContext
      context != null && (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context))
    }

    Function("openOverlaySettings") {
      val context = appContext.reactContext
      if (context != null) {
        val intent = Intent(
          Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
          Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        (appContext.currentActivity ?: context).startActivity(intent)
      }
      null
    }

    Function("sync") {
        title: String,
        detail: String,
        deepLink: String,
        runningCount: Int,
        waitingCount: Int,
        showOverlay: Boolean,
        approvalJson: String,
      ->
      val context = appContext.reactContext ?: return@Function
      val approval = runCatching { JSONObject(approvalJson) }.getOrNull()
      val intent = ProsperoProgressService.syncIntent(
        context,
        title,
        detail,
        deepLink,
        runningCount,
        waitingCount,
        showOverlay,
        approval?.optString("hostId").orEmpty(),
        approval?.optString("sid").orEmpty(),
        approval?.optString("reqId").orEmpty(),
        approval?.optString("action").orEmpty(),
        approval?.optString("summary").orEmpty(),
        approval?.optString("resource").orEmpty(),
      )
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    Function("stop") {
      val context = appContext.reactContext
      context?.stopService(Intent(context, ProsperoProgressService::class.java)) ?: false
    }
  }
}
