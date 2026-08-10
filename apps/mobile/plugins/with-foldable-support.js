const { withAndroidManifest } = require("expo/config-plugins");

/**
 * Keep Android resizable and free of orientation locks so folding, rotation,
 * and multi-window resize the existing React Native surface in place.
 */
module.exports = function withFoldableSupport(config) {
  return withAndroidManifest(config, (androidConfig) => {
    const manifest = androidConfig.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return androidConfig;

    application.$ ??= {};
    application.$["android:resizeableActivity"] = "true";

    const activities = application.activity ?? [];
    for (const activity of activities) {
      if (activity.$?.["android:name"] !== ".MainActivity") continue;
      activity.$["android:resizeableActivity"] = "true";
      delete activity.$["android:screenOrientation"];
      delete activity.$["android:maxAspectRatio"];
      delete activity.$["android:minAspectRatio"];
    }
    return androidConfig;
  });
};
