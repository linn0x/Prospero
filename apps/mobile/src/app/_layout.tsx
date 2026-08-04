import "@/lib/polyfills";

import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <ThemeProvider value={DarkTheme}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#141419" },
          headerTintColor: "#e8e8ee",
          contentStyle: { backgroundColor: "#0b0b0e" },
        }}
      />
    </ThemeProvider>
  );
}
