import { useCallback, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/Toast";
import {
  addHostAddr,
  getHosts,
  RelayCredentialsMissingError,
  removeHostAddr,
  setHostConnectionMode,
  setHostPort,
  setHostRelayUrl,
  type ConnectionMode,
  type StoredHost,
} from "@/lib/hosts";
import { useApp } from "@/lib/store";

/**
 * 编辑主机的连接方式。
 *
 * 存在的理由:地址是配对二维码一次性带走的,电脑换网段、DHCP 换 IP、
 * 或者事后才装上 WireGuard,原本都只能重新扫码 —— 而重新配对会换掉 token,
 * 等于为了改一个 IP 把凭证也换了。这里只改地址和端口,配对本身不动。
 */
export default function EditHostScreen(): React.ReactElement {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const [host, setHost] = useState<StoredHost | null>(null);
  const [newAddr, setNewAddr] = useState("");
  const [portText, setPortText] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const runtime = useApp((s) => s.runtimes[hostId]);
  const setHosts = useApp((s) => s.setHosts);

  const reload = useCallback(() => {
    void getHosts().then((hosts) => {
      setHosts(hosts);
      const h = hosts.find((x) => x.id === hostId) ?? null;
      setHost(h);
      if (h) {
        setPortText(String(h.port));
        setRelayUrl(h.relay?.url ?? "");
      }
    });
  }, [hostId, setHosts]);

  useFocusEffect(reload);

  const add = (): void => {
    const addr = newAddr.trim();
    if (!addr) return;
    // 只做最基本的形状检查 —— 主机名也是合法输入,不该强求 IP 格式
    if (/\s/.test(addr)) {
      Alert.alert("地址不能含空格");
      return;
    }
    void addHostAddr(hostId, addr).then(() => {
      setNewAddr("");
      toast(`已添加 ${addr}`);
      reload();
    });
  };

  const savePort = (): void => {
    const p = Number(portText.trim());
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      Alert.alert("端口无效", "应为 1–65535 的整数。");
      return;
    }
    void setHostPort(hostId, p).then(() => {
      toast("端口已保存");
      reload();
    });
  };

  const selectMode = (mode: ConnectionMode): void => {
    void setHostConnectionMode(hostId, mode).then(
      () => {
        toast(`已选择${mode === "auto" ? "自动" : mode === "direct" ? "直连" : "中继"}`);
        reload();
      },
      (error: unknown) => {
        if (error instanceof RelayCredentialsMissingError) {
          Alert.alert("中继凭证缺失", "中继 ticket 只会由配对二维码提供。请重新扫码配对。", [
            { text: "取消", style: "cancel" },
            { text: "重新扫码", onPress: () => router.push("/pair") },
          ]);
          return;
        }
        Alert.alert("无法保存连接方式", error instanceof Error ? error.message : String(error));
      },
    );
  };

  const saveRelayUrl = (): void => {
    const url = relayUrl.trim();
    if (!url) {
      Alert.alert("中继 URL 不能为空");
      return;
    }
    void setHostRelayUrl(hostId, url).then(
      () => {
        toast("中继 URL 已保存");
        reload();
      },
      (error: unknown) => {
        if (error instanceof RelayCredentialsMissingError) {
          Alert.alert("中继凭证缺失", "请重新扫码配对后再使用中继。", [
            { text: "取消", style: "cancel" },
            { text: "重新扫码", onPress: () => router.push("/pair") },
          ]);
          return;
        }
        Alert.alert("中继 URL 无效", error instanceof Error ? error.message : String(error));
      },
    );
  };

  if (!host) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "编辑主机" }} />
        <Text style={styles.dim}>找不到这台主机。</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ title: host.name, headerBackButtonDisplayMode: "minimal" }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>连接方式</Text>
        <Text style={styles.note}>
          自动会同时竞速直连与中继，最先完成端到端握手的一条线路胜出。
        </Text>
        <View accessibilityRole="radiogroup" style={styles.modeGroup}>
          {([
            ["auto", "自动", "同时尝试可用线路"],
            ["direct", "直连", "只连接电脑地址"],
            ["relay", "中继", "只通过中继连接"],
          ] as const).map(([mode, label, hint]) => (
            <Pressable
              key={mode}
              accessibilityRole="radio"
              accessibilityState={{ selected: host.connectionMode === mode }}
              accessibilityLabel={`${label}连接`}
              accessibilityHint={hint}
              onPress={() => selectMode(mode)}
              style={[styles.mode, host.connectionMode === mode && styles.modeSelected]}
            >
              <View style={[styles.radio, host.connectionMode === mode && styles.radioSelected]} />
              <View style={styles.modeCopy}>
                <Text style={styles.modeTitle}>{label}</Text>
                <Text style={styles.modeHint}>{hint}</Text>
              </View>
            </Pressable>
          ))}
        </View>
        <Text style={styles.actualPath} accessibilityLiveRegion="polite">
          当前实际路径：{runtime?.activePath === "relay" ? "中继" : runtime?.activePath === "direct" ? "直连" : "尚未连接"}
          {runtime?.activeAddr ? ` · ${runtime.activeAddr}` : ""}
        </Text>

        <Text style={styles.section}>连接地址</Text>
        <Text style={styles.note}>
          连接时会并发尝试全部地址,最先握手成功的胜出。切换网络后通常仍是同一条,
          所以多留几条不会变慢。
        </Text>

        {host.addrs.length === 0 && (
          <Text style={styles.warn}>一条地址都没有 —— 现在无法连接。</Text>
        )}

        {host.addrs.map((addr) => (
          <View key={addr} style={styles.row}>
            <Text style={styles.addr} numberOfLines={1}>
              {addr}
              {host.lastGoodAddr === addr ? "  · 上次成功" : ""}
            </Text>
            <Pressable
              hitSlop={8}
              onPress={() => {
                void removeHostAddr(hostId, addr).then(() => {
                  toast(`已移除 ${addr}`);
                  reload();
                });
              }}
            >
              <Icon name="trash" size={16} color="#e5534b" />
            </Pressable>
          </View>
        ))}

        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={newAddr}
            onChangeText={setNewAddr}
            placeholder="新增地址(IP 或主机名)"
            placeholderTextColor="#5a5a66"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            onSubmitEditing={add}
            returnKeyType="done"
          />
          <Pressable onPress={add} style={styles.addBtn}>
            <Text style={styles.addBtnText}>添加</Text>
          </Pressable>
        </View>

        <Text style={styles.section}>端口</Text>
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={portText}
            onChangeText={setPortText}
            keyboardType="number-pad"
            placeholderTextColor="#5a5a66"
            onSubmitEditing={savePort}
            returnKeyType="done"
          />
          <Pressable onPress={savePort} style={styles.addBtn}>
            <Text style={styles.addBtnText}>保存</Text>
          </Pressable>
        </View>

        <Text style={styles.section}>中继</Text>
        {host.relay ? (
          <>
            <Text style={styles.note}>
              中继 ticket 已安全保存在本机，不会显示或写入地址簿。这里只能查看或更改 URL。
            </Text>
            <View style={styles.addRow}>
              <TextInput
                style={styles.input}
                value={relayUrl}
                onChangeText={setRelayUrl}
                placeholder="wss://relay.example.com/v1"
                placeholderTextColor="#5a5a66"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel="中继 URL"
                onSubmitEditing={saveRelayUrl}
                returnKeyType="done"
              />
              <Pressable onPress={saveRelayUrl} style={styles.addBtn} accessibilityRole="button" accessibilityLabel="保存中继 URL">
                <Text style={styles.addBtnText}>保存</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <View style={styles.repairBox}>
            <Text style={styles.warn}>这台主机没有中继凭证，不能保存中继模式。</Text>
            <Pressable
              style={styles.repairBtn}
              accessibilityRole="button"
              accessibilityLabel="重新扫码配对以设置中继"
              onPress={() => router.push("/pair")}
            >
              <Text style={styles.addBtnText}>重新扫码配对</Text>
            </Pressable>
          </View>
        )}

        <Text style={styles.footer}>
          改地址、端口或 URL 不影响配对凭证。缺少中继 ticket 时必须重新扫码，不能手动补填。
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b0b0e" },
  body: { padding: 16, gap: 10 },
  section: { color: "#e8e8ee", fontSize: 15, fontWeight: "600", marginTop: 12 },
  note: { color: "#8a8a96", fontSize: 12, lineHeight: 17 },
  modeGroup: { gap: 8, marginTop: 2 },
  mode: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#292932",
    backgroundColor: "#121218",
    paddingHorizontal: 12,
  },
  modeSelected: { borderColor: "#587bd8", backgroundColor: "#17203a" },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: "#737382" },
  radioSelected: { borderColor: "#7aa2f7", backgroundColor: "#7aa2f7" },
  modeCopy: { flex: 1 },
  modeTitle: { color: "#e8e8ee", fontSize: 14, fontWeight: "600" },
  modeHint: { color: "#8a8a96", fontSize: 11, marginTop: 2 },
  actualPath: { color: "#a7b8e7", fontSize: 12, lineHeight: 18 },
  warn: { color: "#e5534b", fontSize: 13, paddingVertical: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1c1c22",
  },
  addr: { color: "#e8e8ee", fontSize: 14, flex: 1, fontVariant: ["tabular-nums"] },
  addRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    backgroundColor: "#16161c",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#e8e8ee",
    fontSize: 14,
  },
  addBtn: {
    backgroundColor: "#26262e",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  addBtnText: { color: "#7aa2f7", fontSize: 14 },
  repairBox: { gap: 8, paddingVertical: 4 },
  repairBtn: { alignSelf: "flex-start", paddingVertical: 10, paddingHorizontal: 12 },
  footer: { color: "#5a5a66", fontSize: 11, marginTop: 18, lineHeight: 16 },
  dim: { color: "#8a8a96", padding: 16 },
});
