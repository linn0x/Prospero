// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    files: ["src/**/*.{js,jsx,ts,tsx}"],
    rules: {
      // Expo Router 56+ owns its navigation contexts. External hooks compile
      // successfully but crash when a native screen tries to read that context.
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@react-navigation/*"],
          message: "Import navigation APIs from expo-router or expo-router/react-navigation (SDK 57).",
        }],
      }],
    },
  },
]);
