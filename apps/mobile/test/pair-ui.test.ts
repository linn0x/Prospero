import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {},
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
}));

import { RelayCredentialsMissingError } from "../src/lib/hosts";
import { pairingErrorNotice } from "../src/lib/pairing-error-notice";

describe("配对页错误提示", () => {
  it("中继模式重配缺少 QR 凭证时明确提示重新扫码", () => {
    expect(pairingErrorNotice(new RelayCredentialsMissingError())).toEqual({
      title: "中继凭证缺失",
      message: "这个配对码不含中继凭证。请在电脑运行 prosperod pair 后重新扫码配对。",
    });
  });

  it("保留其他无效配对码错误的通用提示", () => {
    expect(pairingErrorNotice(new Error("payload invalid"))).toEqual({
      title: "配对码无效",
      message: "payload invalid",
    });
  });

  it("扫描和粘贴共用的配对页会展示这个提示", () => {
    const screen = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "pair.tsx"),
      "utf8",
    );

    expect(screen).toContain('import { pairingErrorNotice } from "@/lib/pairing-error-notice"');
    expect(screen).toContain("const notice = pairingErrorNotice(e);");
    expect(screen).toContain("Alert.alert(notice.title, notice.message);");
  });
});
