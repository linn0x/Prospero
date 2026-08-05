import "@/lib/polyfills";

import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { NavigationBar } from "expo-navigation-bar";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ToastHost } from "@/components/Toast";

// 冷启动深链到会话时仍给导航栈补上首页，Android 返回不会落到空白页或直接退出。
export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  return (
    // Swipeable 依赖这个根视图;缺了它手势在真机上会静默失效
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={DarkTheme}>
        <StatusBar style="light" />
        <NavigationBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: "#141419" },
            headerTintColor: "#e8e8ee",
            contentStyle: { backgroundColor: "#0b0b0e" },
          }}
        />
        <ToastHost />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
