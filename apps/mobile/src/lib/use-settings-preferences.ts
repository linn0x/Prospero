import { useCallback, useRef } from "react";
import { useFocusEffect } from "expo-router";
import { getHomeSettings, normalizeHomeSettings, rememberHomeSettings, type HomeSettings } from "./home-preferences";
import { useApp } from "./store";

/** Category pages share the same live settings; a delayed disk read cannot undo an edit. */
export function useSettingsPreferences() {
  const settings = normalizeHomeSettings(useApp((state) => state.homeSettings));
  const revision = useRef(0);
  useFocusEffect(useCallback(() => {
    let active = true;
    const before = revision.current;
    const initial = useApp.getState().homeSettings;
    void getHomeSettings().then((saved) => {
      if (active && before === revision.current && useApp.getState().homeSettings === initial) {
        useApp.getState().setHomeSettings(saved);
      }
    });
    return () => { active = false; };
  }, []));
  const updateSettings = useCallback((patch: Partial<HomeSettings>) => {
    revision.current += 1;
    const next = normalizeHomeSettings({ ...useApp.getState().homeSettings, ...patch });
    useApp.getState().setHomeSettings(next);
    void rememberHomeSettings(next);
  }, []);
  return { settings, updateSettings };
}
