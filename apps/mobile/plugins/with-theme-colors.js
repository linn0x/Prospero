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
  prospero_surface_raised: "#E8ECF2",
  prospero_pressed: "#DCE2EA",
  prospero_border: "#C4CBD5",
  prospero_text: "#11151B",
  prospero_text_dim: "#404957",
  prospero_text_faint: "#667180",
  prospero_accent: "#315EA8",
  prospero_accent_dim: "#D7E3F8",
  prospero_on_accent: "#FFFFFF",
  prospero_success: "#1E7049",
  prospero_warn: "#87530A",
  prospero_danger: "#AD3030",
  prospero_success_bg: "#DDF1E7",
  prospero_warn_bg: "#F7E8CC",
  prospero_danger_bg: "#F8DEDE",
  prospero_accent_bg: "#E4ECFB",
};

const dark = {
  activityBackground: "#0B0D12",
  splashscreen_background: "#0B0D12",
  prospero_bg: "#0B0D12",
  prospero_surface: "#151820",
  prospero_surface_raised: "#20242D",
  prospero_pressed: "#2A303B",
  prospero_border: "#343A46",
  prospero_text: "#F5F7FA",
  prospero_text_dim: "#C1C7D0",
  prospero_text_faint: "#929BA8",
  prospero_accent: "#7EA7FF",
  prospero_accent_dim: "#294A82",
  prospero_on_accent: "#071224",
  prospero_success: "#5BC98C",
  prospero_warn: "#E5A341",
  prospero_danger: "#EF5F5F",
  prospero_success_bg: "#16301F",
  prospero_warn_bg: "#33270F",
  prospero_danger_bg: "#3A1A1A",
  prospero_accent_bg: "#17203A",
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
