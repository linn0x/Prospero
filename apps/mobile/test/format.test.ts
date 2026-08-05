import { describe, expect, it } from "vitest";
import { bytes, duration, untilLabel } from "../src/lib/format";

describe("bytes", () => {
  it("按 1024 进位,和活动监视器对得上", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(1024)).toBe("1 KB");
    expect(bytes(1024 * 1024 * 742)).toBe("742 MB");
    expect(bytes(16 * 1024 ** 3)).toBe("16.0 GB");
  });

  it("GB 以下不给小数 —— 那位精度没人关心", () => {
    expect(bytes(1536)).toBe("2 KB");
  });

  it("拿不到值时给破折号,不显示 NaN", () => {
    expect(bytes(Number.NaN)).toBe("—");
    expect(bytes(-1)).toBe("—");
  });
});

describe("duration", () => {
  it("只留最大的两个量级", () => {
    expect(duration(30)).toBe("30 秒");
    expect(duration(90)).toBe("1 分");
    expect(duration(3660)).toBe("1 小时 1 分");
    // 到了"天"这个尺度,分钟就是噪音了
    expect(duration(86400 * 3 + 3600 * 4 + 720)).toBe("3 天 4 小时");
  });

  it("整点时不留空档", () => {
    expect(duration(86400)).toBe("1 天");
    expect(duration(7200)).toBe("2 小时");
  });
});

describe("untilLabel", () => {
  const now = Date.parse("2026-08-05T12:00:00Z");

  it("已经过去的时间点说'即将重置',不显示负数", () => {
    expect(untilLabel("2026-08-05T11:00:00Z", now)).toBe("即将重置");
    expect(untilLabel("2026-08-05T15:30:00Z", now)).toBe("3 小时 30 分后重置");
  });

  it("时间戳不合法时给空串,让调用方自己决定怎么留白", () => {
    expect(untilLabel("随便什么", now)).toBe("");
  });
});
