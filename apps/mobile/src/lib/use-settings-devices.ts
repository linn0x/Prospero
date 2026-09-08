import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { getHosts } from "./hosts";
import { useApp } from "./store";
import { useOrderedDevices } from "./device-order-preferences";
import { toast } from "@/components/Toast";

export function useSettingsDevices() {
  const storedHosts = useApp((state) => state.hosts);
  const hosts = useOrderedDevices(storedHosts);
  const runtimes = useApp((state) => state.runtimes);
  useFocusEffect(useCallback(() => {
    let active = true;
    void getHosts().then((devices) => {
      if (active) useApp.getState().setHosts(devices);
    }).catch(() => { if (active) toast("读取设备失败，请稍后重试"); });
    return () => { active = false; };
  }, []));
  return { hosts, runtimes };
}
