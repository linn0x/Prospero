const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
} = require("expo/config-plugins");

const light = {
  activityBackground: "#F4F5F7",
  prospero_bg: "#F4F5F7",
  prospero_surface: "#FFFFFF",
  prospero_surface_raised: "#ECEEF2",
  prospero_pressed: "#E1E4E9",
  prospero_border: "#D8DCE3",
  prospero_text: "#17181C",
  prospero_text_dim: "#5E6470",
  prospero_text_faint: "#8A919D",
  prospero_accent: "#4268BC",
  prospero_accent_dim: "#C7D7F7",
  prospero_on_accent: "#FFFFFF",
  prospero_success: "#247C53",
  prospero_warn: "#9C630F",
  prospero_danger: "#C54242",
  prospero_success_bg: "#DDF1E7",
  prospero_warn_bg: "#F7E8CC",
  prospero_danger_bg: "#F8DEDE",
  prospero_accent_bg: "#E4ECFB",
};

const dark = {
  activityBackground: "#0A0A0C",
  prospero_bg: "#0A0A0C",
  prospero_surface: "#16161A",
  prospero_surface_raised: "#1F1F25",
  prospero_pressed: "#26262D",
  prospero_border: "#26262D",
  prospero_text: "#F2F2F5",
  prospero_text_dim: "#9B9BA6",
  prospero_text_faint: "#61616B",
  prospero_accent: "#7AA2F7",
  prospero_accent_dim: "#3A5BA8",
  prospero_on_accent: "#08101F",
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
