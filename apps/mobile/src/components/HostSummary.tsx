import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentKind, HostInfo, S2CMessage, UsageAccount } from "@prospero/protocol";
import type { HostConnection } from "@/lib/connection";
import { bytes, duration, untilLabel } from "@/lib/format";
import { Row, Sheet } from "@/components/Sheet";
import { color, font, radius, space, utilizationColor } from "@/lib/theme";

type UsageResult = Extract<S2CMessage, { type: "usage.result" }>;

/** 用量取一次的间隔。限流窗口以小时计,一分钟一刷已经远快过它的变化 */
const POLL_MS = 60_000;

/** 各家 agent 的识别色 —— 颜色即身份,不必每行都读文字才知道是谁 */
const agentTint: Partial<Record<AgentKind, string>> = {
  claude: "#D98A5E",
  codex: "#7AA2F7",
  opencode: "#5BC98C",
  grok: "#B48EAD",
};

/**
 * 主机概览卡。
 *
 * 会话列表回答"我有哪些活儿在跑",但不回答"我那台机器现在怎么样、几个订阅还剩多少"。
 * 这些以前要么得坐到 Mac 前面看,要么得先随便进一个会话才翻得到用量 —— 而限流是
 * 账号级的,进哪个会话都一样;更何况每家 agent 的额度还各算各的,挑一个会话去问
 * 只能答出其中一家。
 *
 * 卡片只放会改变行动的东西:机器压力,以及每个订阅最紧的那个窗口。
 * 细节收进弹层,想看点一下,不想看不占地方。
 */
export function HostSummary({
  info,
  conn,
  connected,
  rttMs,
  sessionCount,
  runningCount,
}: {
  info: HostInfo | null;
  conn: HostConnection | null;
  connected: boolean;
  rttMs: number | null;
  sessionCount: number;
  runningCount: number;
}) {
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [open, setOpen] = useState(false);
  // 渲染期读 Date.now() 拿到的是渲染那一刻的快照,之后再不更新 ——
  // "daemon 运行 3 小时"会一直是 3 小时。让它跟着轮询一起 tick。
  const [now, setNow] = useState(() => Date.now());

  // 取用量和拨时钟分开:前者是异步回调里落 state(effect 里可以直接发起),
  // 后者是同步 setState,只能在事件回调和定时器里做 —— 在 effect 体里同步
  // setState 会触发一轮级联渲染
  const fetchUsage = useCallback(() => {
    if (!conn) return;
    // 不传 sid:问账号级的额度。取不到就当作没有 —— 用量是锦上添花,
    // 它失败不该在主机页弹错误,那会盖过真正重要的连接状态
    conn.usageGet().then(
      (r) => { setUsage(r); },
      () => { setUsage(null); },
    );
  }, [conn]);

  useEffect(() => {
    if (!connected) return;
    fetchUsage();
    const t = setInterval(() => {
      setNow(Date.now());
      fetchUsage();
    }, POLL_MS);
    return () => { clearInterval(t); };
  }, [connected, fetchUsage]);

  if (!info) return null;

  const memUsed =
    info.memTotal !== undefined && info.memFree !== undefined && info.memTotal > 0
      ? ((info.memTotal - info.memFree) / info.memTotal) * 100
      : null;

  // 紧的排前面 —— 快满的那个订阅是唯一会改变今天怎么干活的信息
  const accounts = [...(usage?.accounts ?? [])].sort((a, b) => tightest(b) - tightest(a));

  const specs = [
    info.platform !== undefined
      ? `${info.platform}${info.osVersion !== undefined ? ` ${info.osVersion}` : ""}`
      : null,
    info.arch,
    info.cpus !== undefined ? `${String(info.cpus)} 核` : null,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  return (
    <>
      <Pressable
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
        onPress={() => { setOpen(true); setNow(Date.now()); fetchUsage(); }}
      >
        {/* 连接状态并进卡片 —— 它以前是卡片上方孤零零一行灰字,和机器信息
            明明说的是同一件事,却分成两块各占一份高度 */}
        <View style={styles.head}>
          <View style={[styles.dot, connected ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.headText} numberOfLines={1}>
            {connected ? "已连接" : "未连接"}
            {connected && rttMs !== null ? ` · ${String(rttMs)}ms` : ""}
          </Text>
          <Text style={font.meta}>
            {runningCount > 0 ? `${String(runningCount)} 个运行中 · ` : ""}
            {`${String(sessionCount)} 个会话`}
          </Text>
          <Text style={styles.chev}>›</Text>
        </View>

        {/* 机器名不放这儿 —— 导航栏标题已经是它了,重复一遍只是占地方 */}
        {specs.length > 0 && (
          <Text style={font.meta} numberOfLines={1}>
            {specs.join(" · ")}
          </Text>
        )}

        {memUsed !== null && (
          <Gauge
            label="内存"
            /* 报"还剩多少"而不是"用了多少":决定要不要腾地方的是余量 */
            value={`${bytes(info.memFree ?? 0)} 可用`}
            pct={memUsed}
            tint={utilizationColor(memUsed)}
          />
        )}

        {accounts.length > 0 && <View style={styles.rule} />}

        {accounts.map((a) => {
          const w = topWindow(a);
          return (
            <Gauge
              key={a.agent}
              label={a.agent}
              dot={agentTint[a.agent] ?? color.textDim}
              badge={a.subscription ?? undefined}
              value={
                w
                  ? `${w.label} ${String(Math.round(w.utilization))}%`
                  : a.available
                    ? "无限流"
                    : "暂无数据"
              }
              pct={w?.utilization ?? 0}
              tint={w ? utilizationColor(w.utilization) : color.border}
            />
          );
        })}
      </Pressable>

      <Sheet visible={open} title="这台机器" onClose={() => { setOpen(false); }}>
        <Row label="名称" value={info.name} />
        {info.platform !== undefined && (
          <Row
            label="系统"
            value={`${info.platform}${info.osVersion !== undefined ? ` ${info.osVersion}` : ""}`}
          />
        )}
        {info.arch !== undefined && <Row label="架构" value={info.arch} />}
        {info.cpus !== undefined && <Row label="CPU" value={`${String(info.cpus)} 核`} />}
        {info.memTotal !== undefined && (
          <Row
            label="内存"
            value={
              memUsed !== null
                ? `${bytes(info.memFree ?? 0)} 可用 / ${bytes(info.memTotal)}`
                : bytes(info.memTotal)
            }
          />
        )}
        {info.loadAvg !== undefined && info.loadAvg.length > 0 && (
          <Row label="负载" value={info.loadAvg.map((n) => n.toFixed(2)).join("  ")} />
        )}
        {info.uptimeSec !== undefined && <Row label="开机" value={duration(info.uptimeSec)} />}
        {info.daemonStartedAt !== undefined && (
          <Row label="daemon 运行" value={duration((now - info.daemonStartedAt) / 1000)} />
        )}
        <Row
          label="daemon 版本"
          value={`${info.daemonVersion} · 协议 v${String(info.protocolVersion)}`}
        />
        {/* 这条决定 daemon 重启后会话是否还在 —— 值得单独说,而不是藏在文档里 */}
        {info.tmuxManaged !== undefined && (
          <Row
            label="会话托管"
            value={info.tmuxManaged ? "tmux(daemon 重启不丢)" : "直接托管(重启即结束)"}
          />
        )}

        <Text style={styles.section}>订阅用量</Text>
        {accounts.length === 0 ? (
          <Text style={styles.note}>
            {connected
              ? (usage?.reason ?? "还没有对话型会话 —— 用量要有会话才问得到。")
              : "未连接。"}
          </Text>
        ) : (
          accounts.map((a) => (
            <View key={a.agent} style={styles.account}>
              <View style={styles.accountHead}>
                <View
                  style={[styles.dot, { backgroundColor: agentTint[a.agent] ?? color.textDim }]}
                />
                <Text style={font.body}>{a.agent}</Text>
                {a.subscription != null && <Text style={styles.badge}>{a.subscription}</Text>}
              </View>

              {a.windows.length > 0 ? (
                a.windows.map((w) => (
                  <View key={w.label} style={styles.window}>
                    <View style={styles.gaugeHead}>
                      <Text style={font.sub}>{w.label}</Text>
                      <Text
                        style={[
                          styles.gaugeValue,
                          styles.gaugeValueRight,
                          { color: utilizationColor(w.utilization) },
                        ]}
                      >
                        {String(Math.round(w.utilization))}%
                      </Text>
                    </View>
                    <Bar pct={w.utilization} tint={utilizationColor(w.utilization)} />
                    {w.resetsAt !== undefined && (
                      <Text style={font.meta}>{untilLabel(w.resetsAt, now)}</Text>
                    )}
                  </View>
                ))
              ) : (
                <Text style={styles.note}>{a.reason ?? "这个后端不提供套餐限流窗口。"}</Text>
              )}

              {a.inputTokens !== undefined && (
                <Text style={font.meta}>
                  {`${a.inputTokens.toLocaleString()} 入 / ${(a.outputTokens ?? 0).toLocaleString()} 出`}
                  {a.costUsd !== undefined && a.costUsd > 0 ? ` · $${a.costUsd.toFixed(4)}` : ""}
                </Text>
              )}
            </View>
          ))
        )}
      </Sheet>
    </>
  );
}

/** 一行指标:左边名字、右边数、底下一条细进度 */
function Gauge({
  label,
  value,
  pct,
  tint,
  dot,
  badge,
}: {
  label: string;
  value: string;
  pct: number;
  tint: string;
  dot?: string;
  badge?: string;
}) {
  return (
    <View style={styles.gauge}>
      <View style={styles.gaugeHead}>
        {dot !== undefined && <View style={[styles.dot, { backgroundColor: dot }]} />}
        <Text style={font.meta}>{label}</Text>
        {badge !== undefined && <Text style={styles.badge}>{badge}</Text>}
        <Text style={[styles.gaugeValue, styles.gaugeValueRight]}>{value}</Text>
      </View>
      <Bar pct={pct} tint={tint} />
    </View>
  );
}

/** 细进度条。卡片上要并排放好几根,粗了就成了噪音 */
function Bar({ pct, tint }: { pct: number; tint: string }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${v}%` as const, backgroundColor: tint }]} />
    </View>
  );
}

function topWindow(a: UsageAccount): UsageAccount["windows"][number] | null {
  return a.windows.reduce<UsageAccount["windows"][number] | null>(
    (best, w) => (best === null || w.utilization > best.utilization ? w : best),
    null,
  );
}

function tightest(a: UsageAccount): number {
  return topWindow(a)?.utilization ?? -1;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    gap: space.md,
  },
  cardPressed: { backgroundColor: color.pressed },
  head: { flexDirection: "row", alignItems: "center", gap: 6 },
  headText: { ...font.body, flex: 1 },
  dotOn: { backgroundColor: color.success },
  dotOff: { backgroundColor: color.textFaint },
  chev: { color: color.textFaint, fontSize: 20, marginLeft: 2 },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginVertical: space.xs,
  },
  gauge: { gap: 6 },
  gaugeHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  gaugeValue: { ...font.meta, color: color.textDim, fontVariant: ["tabular-nums"] },
  gaugeValueRight: { marginLeft: "auto" },
  dot: { width: 7, height: 7, borderRadius: 4 },
  badge: {
    ...font.meta,
    color: color.textDim,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: "hidden",
    textTransform: "uppercase",
  },
  track: { height: 4, borderRadius: 2, backgroundColor: color.surfaceRaised, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 2 },
  account: { gap: space.sm, paddingVertical: space.md },
  accountHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  window: { gap: 4 },
  section: { ...font.sub, color: color.textFaint, marginTop: space.xl, marginBottom: space.xs },
  note: { ...font.sub, paddingVertical: space.sm, lineHeight: 19 },
});
