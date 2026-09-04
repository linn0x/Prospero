import "@/lib/polyfills";

import { useEffect, useMemo } from "react";
import { Appearance, useColorScheme } from "react-native";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { NavigationBar } from "expo-navigation-bar";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ToastHost } from "@/components/Toast";
import { RunningSessionProgressBridge } from "@/components/RunningSessionProgressBridge";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import { DEFAULT_HOME_SETTINGS, normalizeHomeSettings } from "@/lib/home-preferences";
import { useApp } from "@/lib/store";
import { paletteForScheme } from "@/lib/theme";

// 冷启动深链到会话时仍给导航栈补上首页，Android 返回不会落到空白页或直接退出。
export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  const { verticalPanes } = useAdaptiveLayout();
  const systemScheme = useColorScheme();
  const savedSettings = useApp((state) => state.homeSettings) ?? DEFAULT_HOME_SETTINGS;
  const themeMode = normalizeHomeSettings(savedSettings).themeMode;
  const activeScheme =
    themeMode === "system" ? (systemScheme === "light" ? "light" : "dark") : themeMode;
  const palette = paletteForScheme(activeScheme);
  const prosperoTheme = useMemo(() => {
    const base = activeScheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: palette.accent,
        background: palette.bg,
        card: palette.surface,
        text: palette.text,
        border: palette.border,
        notification: palette.danger,
      },
    };
  }, [activeScheme, palette.accent, palette.bg, palette.border, palette.danger, palette.surface, palette.text]);

  useEffect(() => {
    Appearance.setColorScheme(themeMode === "system" ? "unspecified" : themeMode);
  }, [themeMode]);

  return (
    // Swipeable 依赖这个根视图;缺了它手势在真机上会静默失效
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: palette.bg }}>
      <KeyboardProvider>
        <ThemeProvider value={prosperoTheme}>
          <StatusBar style={activeScheme === "dark" ? "light" : "dark"} />
          <NavigationBar style={activeScheme} />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: palette.surface },
              headerTintColor: palette.text,
              headerTitleStyle: { fontSize: 17, fontWeight: "600" },
              // A centered native-stack title otherwise lands directly under
              // the hinge on book-style foldables.
              headerTitleAlign: verticalPanes ? "left" : undefined,
              headerShadowVisible: false,
              headerBackButtonDisplayMode: "minimal",
              contentStyle: { backgroundColor: palette.bg },
            }}
          />
          <RunningSessionProgressBridge />
          <ToastHost />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
