/**
 * 给人看的数字格式化。
 *
 * 手机屏窄,一切都要短:内存写 "16 GB" 不写 "17179869184",
 * 运行时长写 "3 天" 不写 "268341 秒"。
 */

/** 字节 → 人类可读。基数 1024,和活动监视器/htop 对得上 */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // GB 以上给一位小数(16.0 GB 和 16.9 GB 差着一个量级的体感),
  // 以下取整 —— "742.3 MB" 的那位小数没人关心
  return i >= 3 ? `${v.toFixed(1)} ${units[i]}` : `${String(Math.round(v))} ${units[i]}`;
}

/**
 * 秒数 → 时长。只保留最大的两个量级:
 * "3 天 4 小时" 够用,"3 天 4 小时 12 分 8 秒" 只是噪音。
 */
export function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const s = Math.floor(sec);
  if (s < 60) return `${String(s)} 秒`;
  const parts: string[] = [];
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) parts.push(`${String(d)} 天`);
  if (h > 0) parts.push(`${String(h)} 小时`);
  // 有天数时就不提分钟了 —— 第三级精度在这个尺度上没有意义
  if (m > 0 && d === 0) parts.push(`${String(m)} 分`);
  return parts.slice(0, 2).join(" ");
}

/**
 * 到某个时间点还有多久。已经过了就说"即将重置",不显示负数。
 *
 * `now` 由调用方传入而不是在这里读 Date.now():渲染期读时钟得到的是
 * 一个渲染那一刻的快照,之后不会再更新,"还有 3 小时"会一直停在那儿。
 * 让它跟着一个会 tick 的 state 走,才是真的在倒数。
 */
export function untilLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const left = (t - now) / 1000;
  return left <= 0 ? "即将重置" : `${duration(left)}后重置`;
}
