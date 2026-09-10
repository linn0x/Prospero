import { useMemo } from "react";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { Icon } from "./Icon";
import { ReorderList } from "./ReorderList";
import type { StoredHost } from "@/lib/hosts";
import type { HostRuntime } from "@/lib/store";
import { useMobileTheme } from "@/lib/theme";

export function DeviceOrderList({ hosts, runtimes, enabled = true, onReorder }: {
  hosts: StoredHost[]; runtimes: Record<string, HostRuntime>; enabled?: boolean; onReorder: (ids: string[]) => void;
}) {
  const { palette } = useMobileTheme();
  const items = useMemo(() => hosts.map((host) => {
    const platform = runtimes[host.id]?.hostInfo?.platform?.toLowerCase() ?? "";
    const brand = platform === "win32" || platform.includes("windows") ? "windows"
      : platform === "darwin" || platform.includes("mac") ? "apple" : platform.includes("linux") ? "linux" : null;
    return { id: host.id, title: host.name, icon: brand
      ? <FontAwesome6 name={brand} size={20} color={palette.accent} />
      : <Icon name="desktopcomputer" size={20} color={palette.textDim} /> };
  }), [hosts, runtimes, palette]);
  return <ReorderList items={items} testID="device-order" enabled={enabled} onReorder={onReorder} />;
}
