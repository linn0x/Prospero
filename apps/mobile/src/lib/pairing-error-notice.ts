import { RelayCredentialsMissingError } from "./hosts";
import { PairingAddressError } from "./manual-pairing";

export interface PairingErrorNotice {
  title: string;
  message: string;
}

/** Copy kept outside the screen so the scanner and pasted-payload flows agree. */
export function pairingErrorNotice(error: unknown): PairingErrorNotice {
  if (error instanceof PairingAddressError) {
    return { title: "设备地址无效", message: error.message };
  }
  if (error instanceof RelayCredentialsMissingError) {
    return {
      title: "中继凭证缺失",
      message: "这个配对码不含中继凭证。请在电脑运行 prosperod pair 后重新扫码配对。",
    };
  }
  return {
    title: "配对码无效",
    message: error instanceof Error ? error.message : String(error),
  };
}
