import "@/lib/polyfills";

import { useEffect, useMemo } from "react";
import { useColorScheme } from "react-native";
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
import {
  applyNativeThemeMode,
  MobileThemeContext,
  paletteForScheme,
  resolveThemeScheme,
} from "@/lib/theme";

// 冷启动深链到会话时仍给导航栈补上首页，Android 返回不会落到空白页或直接退出。
export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  const { verticalPanes } = useAdaptiveLayout();
  const systemScheme = useColorScheme();
  const themeMode = useApp((state) =>
    normalizeHomeSettings(state.homeSettings ?? DEFAULT_HOME_SETTINGS).themeMode,
  );
  // 固定明/暗模式直接由设置驱动，点击后这一帧就更新。仅“跟随系统”依赖原生事件。
  const activeScheme = resolveThemeScheme(themeMode, systemScheme);
  const palette = paletteForScheme(activeScheme);
  const mobileTheme = useMemo(
    () => ({ scheme: activeScheme, palette }),
    [activeScheme, palette],
  );
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

  // React 已经按用户选择完成首帧后，再同步 Android uiMode 与系统资源。
  useEffect(() => {
    applyNativeThemeMode(themeMode);
  }, [activeScheme, themeMode]);

  return (
    // Swipeable 依赖这个根视图;缺了它手势在真机上会静默失效
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: palette.bg }}>
      <KeyboardProvider>
        <MobileThemeContext.Provider value={mobileTheme}>
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
        </MobileThemeContext.Provider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
