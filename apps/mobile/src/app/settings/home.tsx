import { Redirect } from "expo-router";

export default function HomeSettingsScreen() {
  // Existing links keep working after the category merge.
  return <Redirect href="/settings/appearance" />;
}
