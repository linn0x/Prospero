const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
} = require("expo/config-plugins");

const light = {
  activityBackground: "#F2F4F7",
  splashscreen_background: "#F2F4F7",
  prospero_bg: "#F2F4F7",
  prospero_surface: "#FFFFFF",
  prospero_surface_raised: "#EEF0F5",
  prospero_pressed: "#E4E7EE",
  prospero_border: "#E2E5EC",
  prospero_text: "#0F141C",
  prospero_text_dim: "#475262",
  prospero_text_faint: "#5E6978",
  prospero_accent: "#2454CC",
  prospero_accent_dim: "#DAE5FF",
  prospero_on_accent: "#FFFFFF",
  prospero_success: "#147247",
  prospero_warn: "#945200",
  prospero_danger: "#B42323",
  prospero_success_bg: "#E3F6EC",
  prospero_warn_bg: "#FEF2DE",
  prospero_danger_bg: "#FDECEC",
  prospero_accent_bg: "#EDF2FF",
};

const dark = {
  activityBackground: "#0B0D12",
  splashscreen_background: "#0B0D12",
  prospero_bg: "#0B0D12",
  prospero_surface: "#14171F",
  prospero_surface_raised: "#1D212B",
  prospero_pressed: "#262B38",
  prospero_border: "#232834",
  prospero_text: "#F5F7FA",
  prospero_text_dim: "#B8C0CC",
  prospero_text_faint: "#8E97A6",
  prospero_accent: "#7EA7FF",
  prospero_accent_dim: "#26457A",
  prospero_on_accent: "#071224",
  prospero_success: "#52D18E",
  prospero_warn: "#F2AC42",
  prospero_danger: "#F56B6B",
  prospero_success_bg: "#122B1D",
  prospero_warn_bg: "#2E220D",
  prospero_danger_bg: "#351719",
  prospero_accent_bg: "#162038",
};

function assignColors(xml, values) {
  let next = xml;
  for (const [name, value] of Object.entries(values)) {
    next = AndroidConfig.Colors.assignColorValue(next, { name, value });
  }
  return next;
}

/** Keep custom semantic colors reproducible after `expo prebuild --clean`. */
module.exports = function withThemeColors(config) {
  config = withAndroidColors(config, (androidConfig) => {
    androidConfig.modResults = assignColors(androidConfig.modResults, light);
    return androidConfig;
  });
  return withAndroidColorsNight(config, (androidConfig) => {
    androidConfig.modResults = assignColors(androidConfig.modResults, dark);
    return androidConfig;
  });
};

// Expose the source palettes so tests can validate CNG input without relying on
// a generated, gitignored android/ directory being present.
module.exports.palettes = { light, dark };
