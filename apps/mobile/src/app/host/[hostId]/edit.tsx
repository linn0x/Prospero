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
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/Toast";
import {
  addHostAddr,
  getHosts,
  removeHostAddr,
  setHostPort,
  type StoredHost,
} from "@/lib/hosts";

/**
 * 编辑主机的连接方式。
 *
 * 存在的理由:地址是配对二维码一次性带走的,Mac 换网段、DHCP 换 IP、
 * 或者事后才装上 WireGuard,原本都只能重新扫码 —— 而重新配对会换掉 token,
 * 等于为了改一个 IP 把凭证也换了。这里只改地址和端口,配对本身不动。
 */
export default function EditHostScreen(): React.ReactElement {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const [host, setHost] = useState<StoredHost | null>(null);
  const [newAddr, setNewAddr] = useState("");
  const [portText, setPortText] = useState("");

  const reload = useCallback(() => {
    void getHosts().then((hosts) => {
      const h = hosts.find((x) => x.id === hostId) ?? null;
      setHost(h);
      if (h) setPortText(String(h.port));
    });
  }, [hostId]);

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
      <Stack.Screen options={{ title: host.name }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
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

        <Text style={styles.footer}>
          改这里不影响配对凭证 —— token 与密钥都不变,不需要重新扫码。
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
  footer: { color: "#5a5a66", fontSize: 11, marginTop: 18, lineHeight: 16 },
  dim: { color: "#8a8a96", padding: 16 },
});
