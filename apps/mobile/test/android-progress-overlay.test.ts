import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const moduleRoot = join(
  import.meta.dirname,
  "..",
  "modules",
  "prospero-progress-overlay",
);

describe("Android 会话进度服务", () => {
  it("声明通知、悬浮窗和 dataSync 前台服务权限", () => {
    const manifest = readFileSync(join(moduleRoot, "android", "src", "main", "AndroidManifest.xml"), "utf8");
    expect(manifest).toContain("android.permission.POST_NOTIFICATIONS");
    expect(manifest).toContain("android.permission.SYSTEM_ALERT_WINDOW");
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE_DATA_SYNC");
    expect(manifest).toContain('android:foregroundServiceType="dataSync"');
  });

  it("锁屏使用私密通知，并提供可拖动悬浮框和会话深链", () => {
    const service = readFileSync(
      join(moduleRoot, "android", "src", "main", "java", "com", "linn0x", "prospero", "progressoverlay", "ProsperoProgressService.kt"),
      "utf8",
    );
    expect(service).toContain("Notification.VISIBILITY_PRIVATE");
    expect(service).toContain("TYPE_APPLICATION_OVERLAY");
    expect(service).toContain("installDragAndOpen");
    expect(service).toContain("Intent.ACTION_VIEW");
  });

  it("悬浮框只提供单次放行和拒绝，并把带身份的审批事件发回 JS", () => {
    const nativeRoot = join(
      moduleRoot,
      "android",
      "src",
      "main",
      "java",
      "com",
      "linn0x",
      "prospero",
      "progressoverlay",
    );
    const service = readFileSync(join(nativeRoot, "ProsperoProgressService.kt"), "utf8");
    const module = readFileSync(join(nativeRoot, "ProsperoProgressOverlayModule.kt"), "utf8");

    expect(service).toContain('approvalButton("拒绝"');
    expect(service).toContain('approvalButton("允许一次"');
    expect(service).not.toContain("始终允许");
    expect(service).toContain('"hostId" to approvalHostId');
    expect(service).toContain('"reqId" to approvalRequestId');
    expect(service).toContain("approvalSubmitting");
    expect(module).toContain('Events("onApprovalAction")');
    expect(module).toContain('sendEvent("onApprovalAction", event)');
    expect(module).toContain("approvalJson: String");
    expect(module).toContain("JSONObject(approvalJson)");
  });
});
