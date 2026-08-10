import "@/lib/polyfills";

import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { NavigationBar } from "expo-navigation-bar";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ToastHost } from "@/components/Toast";
import { color } from "@/lib/theme";

const prosperoTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: color.accent,
    background: color.bg,
    card: color.surface,
    text: color.text,
    border: color.border,
    notification: color.danger,
  },
};

// 冷启动深链到会话时仍给导航栈补上首页，Android 返回不会落到空白页或直接退出。
export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  return (
    // Swipeable 依赖这个根视图;缺了它手势在真机上会静默失效
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={prosperoTheme}>
          <StatusBar style="light" />
          <NavigationBar style="dark" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: color.surface },
              headerTintColor: color.text,
              headerTitleStyle: { fontSize: 17, fontWeight: "600" },
              headerShadowVisible: false,
              headerBackButtonDisplayMode: "minimal",
              contentStyle: { backgroundColor: color.bg },
            }}
          />
          <ToastHost />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
